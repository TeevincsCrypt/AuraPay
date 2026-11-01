#!/usr/bin/env node
/**
 * End-to-end API tests against a running AuraPay server wired to scripts/mock-providers.mjs
 * (AURAPAY_TEST_MODE=true). See README "Tests" for the env used. Exits non-zero on failure.
 *
 *   APP=http://localhost:3000 MOCK=http://localhost:4010 node scripts/e2e-api.mjs
 */
import { randomUUID, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP ?? "http://localhost:3000";
const MOCK = process.env.MOCK ?? "http://localhost:4010";
const ADMIN = process.env.ADMIN_API_TOKEN ?? "test-admin-token-123";
const MERCHANT_NIM = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const PAYER_NIM = "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB";
const evm = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PAYER_POLY = evm.address.toLowerCase();

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString("hex");

class Client {
  cookie = "";
  async req(method, path, body, headers = {}) {
    const res = await fetch(APP + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set && !/ap_session=;/.test(set)) this.cookie = set.split(";")[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }
  get = (p, h) => this.req("GET", p, undefined, h);
  post = (p, b, h) => this.req("POST", p, b, h);
  del = (p) => this.req("DELETE", p);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// The suite runs against whichever utility provider the server is configured with.
const PROVIDER = (await (await fetch(APP + "/api/status")).json()).utilities.provider;
const CODES = PROVIDER === "flutterwave"
  ? { airtime: "BIL099:AT099", data: "BIL108", dataProduct: "MD138", electricity: "BIL113:UB157" }
  : { airtime: "341", data: "645", dataProduct: "1.34", electricity: "9" };
console.log(`Utility provider: ${PROVIDER}`);

const mock = async (path, body) =>
  (await fetch(MOCK + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
const nimHash = () => randomBytes(32).toString("hex");
const polyHash = () => `0x${randomBytes(32).toString("hex")}`;

// --- Nimiq Pay signing, exactly as the host does (see src/lib/server/auth/nimiq-signature.ts)
function nimSign(privKey, message) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x16Nimiq Signed Message:\n${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix);
  payload.set(msg, prefix.length);
  return { publicKey: hex(ed25519.getPublicKey(privKey)), signature: hex(ed25519.sign(sha256(payload), privKey)) };
}

async function signIn(c, privKey = ed25519.utils.randomPrivateKey()) {
  const ch = await c.post("/api/auth/challenge", { mode: "local" });
  const r = await c.post("/api/auth/verify", { challengeId: ch.json.id, ...nimSign(privKey, ch.json.message) });
  assert(r.status === 200, `sign-in failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.user.address;
}

async function linkEvm(c, account = evm) {
  const ch = await c.post("/api/auth/evm/challenge", { address: account.address });
  const signature = await account.signMessage({ message: ch.json.message });
  return c.post("/api/auth/evm/verify", { challengeId: ch.json.id, signature });
}

async function registerNimTx(order, overrides = {}) {
  const hash = overrides.hash ?? nimHash();
  await mock("/_test/nimiq-tx", {
    hash, from: PAYER_NIM, to: order.payToAddress, value: Number(order.quote.payAmountAtomic), fee: 0,
    recipientData: Buffer.from(order.memo ?? "").toString("hex"), blockNumber: 1000, confirmations: 5, timestamp: Date.now(), executionResult: true, ...overrides,
  });
  return hash;
}

async function registerPolyTx(order, { units, from = PAYER_POLY, hash = polyHash() } = {}) {
  const pad = (a) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
  await mock("/_test/polygon-tx", {
    hash,
    timestamp: Date.now(),
    receipt: {
      status: "0x1", blockNumber: `0x${(60_000_000 - 20).toString(16)}`, to: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
      logs: [{
        address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(from), pad(order.payToAddress)],
        data: pad(BigInt(units ?? order.quote.payAmountAtomic).toString(16)),
      }],
    },
  });
  return hash;
}

async function createOrder(c, overrides = {}) {
  const r = await c.post("/api/orders", {
    clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567",
    amount: 1000, amountCurrency: "local", payCurrency: "NIM", ...overrides,
  });
  assert(r.status === 201, `create order ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.order;
}

async function payNim(c, order, overrides) {
  const hash = await registerNimTx(order, overrides);
  return (await c.post(`/api/orders/${order.id}/payment`, { txHash: hash })).json.order;
}

async function waitFor(c, id, pred, ms = 20_000) {
  const end = Date.now() + ms;
  let o;
  while (Date.now() < end) {
    o = (await c.get(`/api/orders/${id}`)).json.order;
    if (pred(o)) return o;
    await sleep(1000);
  }
  throw new Error(`timeout; last status ${o?.status} ${o?.statusReason ?? ""}`);
}

const c = new Client();
let myAddress;

// ---------------------------------------------------------------------------
console.log("\nWallet-signature authentication");
await test("protected APIs reject unauthenticated requests", async () => {
  const anon = new Client();
  eq((await anon.get("/api/activity")).status, 401, "activity");
  eq((await anon.post("/api/orders", {})).status, 401, "orders");
  eq((await anon.get("/api/auth/session")).json.user, null, "session");
});
await test("in-app sign-in with a Nimiq Pay signature", async () => {
  myAddress = await signIn(c);
  assert(/^NQ\d\d( [0-9A-Z]{4}){8}$/.test(myAddress), `address format ${myAddress}`);
  eq((await c.get("/api/auth/session")).json.user.address, myAddress, "session address");
});
await test("same key signs in to the same account", async () => {
  const key = ed25519.utils.randomPrivateKey();
  const a = await signIn(new Client(), key);
  const b = await signIn(new Client(), key);
  eq(a, b, "stable identity");
});
await test("tampered signature is rejected", async () => {
  const x = new Client();
  const ch = await x.post("/api/auth/challenge", { mode: "local" });
  const signed = nimSign(ed25519.utils.randomPrivateKey(), ch.json.message + " tampered");
  eq((await x.post("/api/auth/verify", { challengeId: ch.json.id, ...signed })).status, 401, "status");
});
await test("a challenge can only be used once", async () => {
  const x = new Client();
  const key = ed25519.utils.randomPrivateKey();
  const ch = await x.post("/api/auth/challenge", { mode: "local" });
  const s = nimSign(key, ch.json.message);
  eq((await x.post("/api/auth/verify", { challengeId: ch.json.id, ...s })).status, 200, "first");
  eq((await new Client().post("/api/auth/verify", { challengeId: ch.json.id, ...s })).status, 400, "replay");
});
await test("remote sign-in: approve in Nimiq Pay, browser receives its own session once", async () => {
  const desktop = new Client();
  const phone = new Client();
  const key = ed25519.utils.randomPrivateKey();
  const r = await desktop.post("/api/auth/challenge", { mode: "remote" });
  assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.json.code), "code format");
  assert(r.json.deepLink.startsWith("https://nimpay.app/miniapps/open/") && r.json.deepLink.includes("/auth/approve?code="), "deep link");
  eq((await desktop.post("/api/auth/remote/poll", { id: r.json.id, pollToken: r.json.pollToken })).json.status, "pending", "pending");
  eq((await desktop.post("/api/auth/remote/poll", { id: r.json.id, pollToken: "x".repeat(32) })).status, 404, "wrong poll token");
  const look = await phone.get(`/api/auth/remote?code=${r.json.code}`);
  eq(look.status, 200, "lookup");
  const ap = await phone.post("/api/auth/remote/approve", { code: r.json.code, ...nimSign(key, look.json.message) });
  eq(ap.json.approved, true, "approved");
  eq((await desktop.post("/api/auth/remote/poll", { id: r.json.id, pollToken: r.json.pollToken })).json.status, "approved", "poll approved");
  eq((await desktop.get("/api/auth/session")).json.user.address, ap.json.user.address, "desktop signed in");
  eq((await desktop.post("/api/auth/remote/poll", { id: r.json.id, pollToken: r.json.pollToken })).json.status, "consumed", "single use");
});
await test("EVM wallet linking requires a valid personal_sign", async () => {
  const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const ch = await c.post("/api/auth/evm/challenge", { address: evm.address });
  const wrong = await other.signMessage({ message: ch.json.message });
  eq((await c.post("/api/auth/evm/verify", { challengeId: ch.json.id, signature: wrong })).status, 401, "wrong signer");
  eq((await linkEvm(c)).status, 200, "valid signature");
  assert((await c.get("/api/auth/session")).json.user.evmAddresses.includes(PAYER_POLY), "linked");
});
await test("sign out revokes the session", async () => {
  const x = new Client();
  await signIn(x);
  await x.del("/api/auth/session");
  eq((await x.get("/api/activity")).status, 401, "revoked");
});

// ---------------------------------------------------------------------------
console.log("\nStatus & catalogue");
await test("status reports live integrations only", async () => {
  const { json } = await c.get("/api/status");
  eq(json.utilities.state, "sandbox", "utilities");
  eq(json.utilities.provider, PROVIDER, "provider");
  eq(json.rails.NIM.available, true, "NIM rail");
  eq(json.rails.USDT.available, true, "USDT rail");
  eq("DEMO" in json.rails, false, "no simulated rail");
  eq(json.investing.state, "live", "investing");
  eq(json.lending.state, "live", "lending");
});
await test("countries list only provider-supported services", async () => {
  const { json } = await c.get("/api/utilities/countries");
  const ng = json.countries.find((x) => x.code === "NG");
  const tz = json.countries.find((x) => x.code === "TZ");
  assert(ng.services.airtime && ng.services.data && ng.services.electricity, "NG should have all three");
  assert(!tz.services.airtime && !tz.services.data, "TZ unsupported in mock");
});
await test("phone validation + operator auto-detect", async () => {
  const ok = await c.get("/api/utilities/detect?country=NG&phone=08031234567");
  eq(ok.json.e164, "2348031234567", "e164");
  // Reloadly looks the number up; for Flutterwave AuraPay detects the network from the prefix.
  eq(ok.json.operator?.name ?? null, PROVIDER === "reloadly" ? "MTN Nigeria" : "MTN", "detected");
  if (PROVIDER === "flutterwave") {
    eq((await c.get("/api/utilities/detect?country=NG&phone=09044544951")).json.operator?.name, "Airtel", "0904 → Airtel");
    const data = (await c.get("/api/utilities/operators?country=NG&service=data")).json.operators;
    eq(data.map((o) => o.name).sort().join(","), "Airtel Data,MTN Data", "data operators named by network");
    eq(data.find((o) => o.name === "MTN Data").products.length, 2, "bundles grouped under their network");
  }
  eq((await c.get("/api/utilities/detect?country=NG&phone=12345")).json.valid, false, "invalid");
});

// ---------------------------------------------------------------------------
console.log("\nUtility orders — NIM, verified on-chain");
let firstOrder;
await test("quote is priced server-side and bound to a memo", async () => {
  firstOrder = await createOrder(c);
  eq(firstOrder.quote.providerCostUsd, 0.67, "provider cost");
  eq(firstOrder.quote.totalUsd, 0.77, "total");
  eq(firstOrder.memo, `AuraPay ${firstOrder.ref}`, "memo");
  eq(firstOrder.payToAddress, MERCHANT_NIM.replace(/\s/g, ""), "merchant");
  eq(firstOrder.quote.payAmountAtomic, String(Math.ceil(((0.77 * 1.01) / 0.0012) * 1e5)), "luna");
});
await test("verified payment → exactly one sandbox top-up", async () => {
  const before = await mock("/_test/counters");
  const o = await payNim(c, firstOrder);
  eq(o.status, "successful", "status");
  eq((await mock("/_test/counters")).topupCalls - before.topupCalls, 1, "one topup");
});
await test("idempotent create with same clientRequestId", async () => {
  const body = { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567", amount: 500, amountCurrency: "local", payCurrency: "NIM" };
  eq((await c.post("/api/orders", body)).json.order.id, (await c.post("/api/orders", body)).json.order.id, "same order");
});
await test("simulated payments no longer exist", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567", amount: 1000, amountCurrency: "local", payCurrency: "DEMO" });
  eq(r.status, 422, "status");
});
await test("invalid phone and out-of-range amount rejected", async () => {
  eq((await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "0123", amount: 1000, amountCurrency: "local", payCurrency: "NIM" })).status, 422, "phone");
  eq((await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567", amount: 50, amountCurrency: "local", payCurrency: "NIM" })).status, 422, "amount");
});
await test("data bundle (FIXED) purchase", async () => {
  const o = await createOrder(c, { service: "data", operatorCode: CODES.data, productCode: CODES.dataProduct, amount: 1.34, amountCurrency: "sender" });
  eq(o.productDescription, "3GB · 30 days", "product");
  eq((await payNim(c, o)).status, "successful", "status");
});
await test("same tx hash cannot pay a second order", async () => {
  const o1 = await createOrder(c);
  const hash = await registerNimTx(o1);
  await c.post(`/api/orders/${o1.id}/payment`, { txHash: hash });
  const o2 = await createOrder(c);
  const r = await c.post(`/api/orders/${o2.id}/payment`, { txHash: hash });
  eq(r.json.error?.code, "TX_ALREADY_USED", "code");
});
await test("memo mismatch and underpayment → review, never fulfilled", async () => {
  const before = await mock("/_test/counters");
  eq((await payNim(c, await createOrder(c), { recipientData: Buffer.from("AuraPay AP-OTHER").toString("hex") })).status, "requires_review", "memo");
  const o = await createOrder(c);
  eq((await payNim(c, o, { value: Number(o.quote.payAmountAtomic) - 1 })).status, "requires_review", "underpaid");
  eq((await mock("/_test/counters")).topupCalls, before.topupCalls, "no topups");
});
await test("pending until confirmed; concurrent polls fulfil exactly once", async () => {
  const o = await createOrder(c);
  const hash = nimHash();
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: hash })).json.order.status, "payment_pending", "pending");
  await registerNimTx(o, { hash, confirmations: 3 });
  const before = await mock("/_test/counters");
  const results = await Promise.all(Array.from({ length: 8 }, () => c.get(`/api/orders/${o.id}`)));
  eq((await mock("/_test/counters")).topupCalls - before.topupCalls, 1, "one topup");
  assert(results.some((x) => x.json.order.status === "successful"), "successful");
});

console.log("\nUSDT payments — verified wallet + Polygon receipt");
await test("USDT payer must be a signature-verified wallet", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567", amount: 1000, amountCurrency: "local", payCurrency: "USDT", payerAddress: "0x3333333333333333333333333333333333333333" });
  eq(r.json.error?.code, "PAYER_NOT_VERIFIED", "code");
});
await test("exact USDT transfer from the verified wallet is fulfilled", async () => {
  const o = await createOrder(c, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  const units = BigInt(o.quote.payAmountAtomic);
  assert(units > 770_000n && units < 770_100n, `tagged amount ${units}`);
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: await registerPolyTx(o) })).json.order.status, "successful", "status");
});
await test("USDT amount mismatch → review", async () => {
  const o = await createOrder(c, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: await registerPolyTx(o, { units: "770000" }) })).json.order.status, "requires_review", "status");
});

console.log("\nElectricity");
await test("electricity payment → token after provider processing", async () => {
  const o = await createOrder(c, { service: "electricity", operatorCode: CODES.electricity, recipient: "04223568280", amount: 5000, amountCurrency: "local" });
  eq(o.quote.providerCostUsd, 3.4, "(5000 + 100 fee) / 1500");
  eq((await payNim(c, o)).status, "provider_pending", "processing");
  const done = await waitFor(c, o.id, (x) => x.status === "successful", 25_000);
  eq(done.deliveryDetails.token, "1234-5678-9012-3456-7890", "token");
});

await test("meter is verified with the provider before quoting", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "electricity", countryCode: "NG", operatorCode: CODES.electricity, recipient: "00000000", amount: 5000, amountCurrency: "local", payCurrency: "NIM" });
  if (PROVIDER === "flutterwave") eq(r.json.error?.code, "CUSTOMER_INVALID", "code");
  else assert(r.status === 201 || r.status === 422, `status ${r.status}`);
});

console.log("\nFailure handling, refunds, isolation");
let reviewOrder;
await test("provider failure after verified payment → review", async () => {
  await mock("/_test/fail-next-topup", { errorCode: "INSUFFICIENT_BALANCE" });
  reviewOrder = await createOrder(c);
  eq((await payNim(c, reviewOrder)).status, "requires_review", "status");
});
await test("refund recorded only after on-chain verification", async () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  eq((await c.get("/api/admin/orders")).status, 401, "admin requires token");
  eq((await c.post(`/api/admin/orders/${reviewOrder.id}/refund`, { refundTxHash: nimHash() }, auth)).status, 409, "unverified");
  const refundHash = nimHash();
  await mock("/_test/nimiq-tx", { hash: refundHash, from: reviewOrder.payToAddress, to: PAYER_NIM, value: Number(reviewOrder.quote.payAmountAtomic), recipientData: "", blockNumber: 1001, confirmations: 4, timestamp: Date.now(), executionResult: true });
  eq((await c.post(`/api/admin/orders/${reviewOrder.id}/refund`, { refundTxHash: refundHash }, auth)).json.order.status, "refunded", "refunded");
});
await test("orders are private to their account", async () => {
  const other = new Client();
  await signIn(other);
  eq((await other.get(`/api/orders/${firstOrder.id}`)).status, 404, "read");
  eq((await other.post(`/api/orders/${firstOrder.id}/payment`, { txHash: nimHash() })).status, 404, "pay");
});

// ---------------------------------------------------------------------------
console.log("\nInvesting — tokenised stocks");
const NVDAC = "0xb20000000000000000000078ee7ce2fE4908108C";
await test("quotes come from live tokenised prices when Finnhub isn't set", async () => {
  const { json } = await c.get("/api/markets/quotes");
  eq(json.source, "tokenized", "source");
  const nv = json.quotes.find((q) => q.symbol === "NVDA");
  eq(nv.token.symbol, "NVDAC", "token");
  eq(nv.token.chainId, 8453, "Base");
  assert(nv.price > 0 && nv.source === "tokenized", "priced");
  const h = await c.get("/api/markets/NVDA?range=1M");
  assert(h.json.history.points.length > 10 && h.json.history.source === "coingecko", "history");
});
await test("portfolio reads on-chain balances of the verified wallet", async () => {
  await mock("/_test/evm-balance", { chainId: 8453, token: NVDAC, owner: PAYER_POLY, amount: "250000000" }); // 2.5 NVDAc
  const { json } = await c.get("/api/portfolio");
  const h = json.portfolio.holdings.find((x) => x.symbol === "NVDA");
  eq(h?.walletQuantity, 2.5, "quantity");
  assert(h.valueUsd > 0, "valued");
});
await test("CoW order recorded, then verified against the order book", async () => {
  const uid = `0x${randomBytes(56).toString("hex")}`;
  const r = await c.post("/api/invest/trades", {
    symbol: "NVDA", orderUid: uid, chainId: 137, destinationChainId: 8453, owner: PAYER_POLY,
    inputToken: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 }, inputAmount: "25000000",
    outputToken: { address: NVDAC }, outputAmount: "13000000",
  });
  eq(r.status, 201, "recorded");
  await mock("/_test/cow-order", { uid, owner: PAYER_POLY, status: "fulfilled", executedSellAmount: "25000000", executedBuyAmount: "13000000" });
  const t = await c.get("/api/invest/trades");
  eq(t.json.trades.find((x) => x.orderUid === uid)?.status, "fulfilled", "fulfilled");
  const p = await c.get("/api/portfolio");
  eq(p.json.portfolio.holdings.find((x) => x.symbol === "NVDA").costBasisUsd, 25, "cost basis");
  const act = await c.get("/api/activity?limit=50");
  eq(act.json.items.find((i) => i.providerRef === uid)?.status, "successful", "ledger");
});
await test("orders from unverified wallets are refused", async () => {
  const r = await c.post("/api/invest/trades", {
    symbol: "NVDA", orderUid: `0x${randomBytes(56).toString("hex")}`, chainId: 8453, owner: "0x3333333333333333333333333333333333333333",
    inputToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 }, inputAmount: "1", outputToken: { address: NVDAC }, outputAmount: "1",
  });
  eq(r.status, 403, "status");
});

await test("USDC balance on Base for the buy flow", async () => {
  await mock("/_test/evm-balance", { chainId: 8453, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", owner: PAYER_POLY, amount: "12500000" });
  eq((await c.get(`/api/wallet/usdc-balance?address=${PAYER_POLY}&chainId=8453`)).json.balance, 12.5, "balance");
  eq((await c.get(`/api/wallet/usdc-balance?address=${PAYER_POLY}&chainId=1`)).status, 422, "unsupported chain");
});

console.log("\nBorrowing — Aave V4 (MAG7 spoke, Base)");
await test("reads live reserves and the user's position", async () => {
  await mock("/_test/aave-position", { supplied: "100000000", debt: "50000000", collateral: true }); // 1 NVDAc, 50 USDC
  const { json } = await c.get("/api/borrow");
  eq(json.available, true, "available");
  const nv = json.reserves.find((r) => r.symbol === "NVDAc");
  const usdc = json.reserves.find((r) => r.symbol === "USDC");
  eq(nv.ticker, "NVDA", "stock reserve identified by address");
  eq(usdc.ticker, null, "USDC is not a stock");
  eq(nv.collateralFactor, 0.5, "collateral factor");
  eq(nv.priceUsd, 180, "oracle price");
  eq(usdc.borrowApr, 0.055, "borrow APR");
  eq(json.account.collateralUsd, 180, "collateral USD");
  eq(json.account.debtUsd, 50, "debt USD");
  eq(json.account.healthFactor, 1.8, "health factor");
  eq(json.account.borrowCapacityUsd, 40, "capacity");
});
await test("lending transaction recorded and verified via its receipt", async () => {
  const hash = polyHash();
  const r = await c.post("/api/borrow/actions", { action: "borrow", reserveId: 1, owner: PAYER_POLY, txHash: hash, amountAtomic: "10000000" });
  eq(r.json.status, "submitted", "pending until mined");
  await mock("/_test/evm-tx", { hash, from: PAYER_POLY, to: "0x17905Db0e4A3514467539956c084180616AE7B8D", status: "0x1" });
  eq((await c.get(`/api/borrow/actions?txHash=${hash}`)).json.status, "confirmed", "confirmed");
  const act = await c.get("/api/activity?limit=50");
  const item = act.json.items.find((i) => i.chainTxHash === hash);
  eq(item?.category, "loan_disbursement", "ledger category");
  eq(item?.status, "successful", "ledger status");
});
await test("reverted or foreign transactions are marked failed", async () => {
  const hash = polyHash();
  await c.post("/api/borrow/actions", { action: "repay", reserveId: 1, owner: PAYER_POLY, txHash: hash, amountAtomic: "1000000" });
  await mock("/_test/evm-tx", { hash, from: PAYER_POLY, to: "0x17905Db0e4A3514467539956c084180616AE7B8D", status: "0x0" });
  eq((await c.get(`/api/borrow/actions?txHash=${hash}`)).json.status, "failed", "reverted");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
