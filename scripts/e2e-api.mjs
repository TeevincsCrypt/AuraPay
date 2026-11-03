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
import { encodeEventTopics, encodeFunctionData, parseAbi } from "viem";

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
  patch = (p, b) => this.req("PATCH", p, b);
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
  ? { airtime: "BIL099:AT099:MTN", data: "BIL108", dataProduct: "MD138", electricity: "BIL113:UB157" }
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
  eq("investing" in json || "lending" in json, false, "invest/borrow removed");
});
await test("countries list only provider-supported services", async () => {
  const { json } = await c.get("/api/utilities/countries");
  const ng = json.countries.find((x) => x.code === "NG");
  assert(ng.services.airtime && ng.services.data && ng.services.electricity, "NG should have all three");
  eq(json.countries.map((x) => x.code).join(","), "NG,GH,KE,UG", "only the four served countries");
  const ke = json.countries.find((x) => x.code === "KE");
  assert(!ke.services.data, "services the provider doesn't offer aren't shown");
});
await test("phone validation + operator auto-detect", async () => {
  const ok = await c.get("/api/utilities/detect?country=NG&phone=08031234567");
  eq(ok.json.e164, "2348031234567", "e164");
  // Reloadly looks the number up; for Flutterwave AuraPay detects the network from the prefix.
  eq(ok.json.operator?.name ?? null, PROVIDER === "reloadly" ? "MTN Nigeria" : "MTN", "detected");
  if (PROVIDER === "flutterwave") {
    eq((await c.get("/api/utilities/detect?country=NG&phone=09044544951")).json.operator?.name, "Airtel", "0904 → Airtel");
    // MTN has no biller of its own when the generic item spans networks: it's still listed, paid through BIL099/AT099.
    const air = (await c.get("/api/utilities/operators?country=NG&service=airtime")).json.operators;
    eq(air.map((o) => o.name).sort().join(","), "Airtel,All networks,Glo,MTN", "airtime operators incl. MTN");
    eq(air.find((o) => o.name === "MTN").code, "BIL099:AT099:MTN", "MTN routed via the generic item");
    eq(ok.json.operator?.code, "BIL099:AT099:MTN", "detected MTN is payable");
    const data = (await c.get("/api/utilities/operators?country=NG&service=data")).json.operators;
    eq(data.map((o) => o.name).sort().join(","), "Airtel Data,MTN Data", "data operators named by network");
    eq(data.find((o) => o.name === "MTN Data").products.length, 2, "bundles grouped under their network");
  }
  eq((await c.get("/api/utilities/detect?country=NG&phone=12345")).json.valid, false, "invalid");
});
await test("NIM balance can be read from AuraPay's own node", async () => {
  const r = await c.get("/api/wallet/nim-balance?address=" + encodeURIComponent("NQ07 0000 0000 0000 0000 0000 0000 0000 0000"));
  eq(r.status, 200, "status");
  eq(r.json.luna, 250_000_000, "luna");
  eq((await c.get("/api/wallet/nim-balance?address=nope")).status, 422, "invalid address");
});
await test("wallet balance includes POL for gas", async () => {
  const r = await c.get("/api/wallet/usdt-balance?address=0x3333333333333333333333333333333333333333");
  eq(r.status, 200, "status");
  assert(typeof r.json.balance === "number" && typeof r.json.pol === "number", "usdt + pol");
});

// ---------------------------------------------------------------------------
console.log("\nUtility orders — NIM, verified on-chain");
let firstOrder;
await test("quote is priced server-side and bound to a memo", async () => {
  firstOrder = await createOrder(c);
  eq(firstOrder.quote.providerCostUsd, 0.67, "provider cost");
  eq(firstOrder.quote.serviceFeeUsd, 0, "AuraPay is free");
  eq(firstOrder.quote.totalUsd, 0.67, "total = provider price");
  eq(firstOrder.memo, `AuraPay ${firstOrder.ref}`, "memo");
  eq(firstOrder.payToAddress, MERCHANT_NIM.replace(/\s/g, ""), "merchant");
  eq(firstOrder.quote.payAmountAtomic, String(Math.ceil(((0.67 * 1.01) / 0.0012) * 1e5)), "luna");
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
await test("an unpaid order (insufficient funds) shows as failed, never stuck pending", async () => {
  const o = await createOrder(c, { amount: 900 });
  const item = () => c.get("/api/activity?limit=50").then((r) => r.json.items.find((i) => i.sourceId === o.id));
  eq((await item()).status, "pending", "pending while awaiting payment");
  const closed = (await c.post(`/api/orders/${o.id}/cancel`, { reason: "insufficient_funds" })).json.order;
  eq(closed.status, "expired", "order closed");
  assert(/insufficient/i.test(closed.statusReason), "reason recorded");
  eq((await item()).status, "failed", "activity shows failed");
  const before = await mock("/_test/counters");
  const late = (await c.post(`/api/orders/${o.id}/payment`, { txHash: await registerNimTx(o) })).json.order;
  eq(late.status, "requires_review", "a late payment goes to review for refund");
  eq((await mock("/_test/counters")).topupCalls, before.topupCalls, "never delivered");
  eq((await new Client().post(`/api/orders/${o.id}/cancel`, { reason: "cancelled" })).status, 401, "auth");
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
  assert(units > 670_000n && units < 670_100n, `tagged amount ${units}`);
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

console.log("\nCable TV & internet");
await test("cable billers list packages; smartcard checked; package delivered", async () => {
  const r = await c.get("/api/utilities/billers?country=NG&service=cable");
  if (PROVIDER !== "flutterwave") return eq(r.json.billers.length, 0, "reloadly has no cable");
  const dstv = r.json.billers.find((b) => b.name === "DSTV");
  eq(dstv?.products.length, 2, "DStv packages");
  eq(r.json.billers.length, 2, "DStv + GOtv");
  const bad = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "cable", countryCode: "NG", operatorCode: "BIL121", productCode: "CB141", recipient: "00000000", amount: 1, amountCurrency: "sender", payCurrency: "NIM" });
  eq(bad.json.error?.code, "CUSTOMER_INVALID", "invalid smartcard");
  const o = await createOrder(c, { service: "cable", operatorCode: "BIL121", productCode: "CB141", recipient: "7027914329", amount: 1, amountCurrency: "sender" });
  eq(o.amountLocal, 4400, "package price");
  assert(o.productDescription.includes("CHIOMA OKAFOR"), "customer name shown");
  eq((await payNim(c, o)).status, "successful", "status");
});
await test("internet plan purchase", async () => {
  if (PROVIDER !== "flutterwave") return;
  const r = await c.get("/api/utilities/billers?country=NG&service=internet");
  eq(r.json.billers[0]?.name, "SPECTRANET", "biller");
  const o = await createOrder(c, { service: "internet", operatorCode: "BIL124", productCode: "IN201", recipient: "SPC123456", amount: 1, amountCurrency: "sender" });
  eq((await payNim(c, o)).status, "successful", "status");
});
await test("countries report cable and internet", async () => {
  const ng = (await c.get("/api/utilities/countries")).json.countries.find((x) => x.code === "NG");
  eq(ng.services.cable, PROVIDER === "flutterwave", "cable");
  eq(ng.services.internet, PROVIDER === "flutterwave", "internet");
});

console.log("\nScheduled bills (prepaid, run automatically)");
const CRON = process.env.CRON_SECRET ?? "test-cron-secret-123";
const cron = (secret = CRON) => fetch(APP + "/api/cron/schedules", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).then(async (r) => ({ status: r.status, json: await r.json() }));
const newSchedule = async (overrides = {}) => {
  const r = await c.post("/api/schedules", {
    clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567",
    amount: 1000, amountCurrency: "local", payCurrency: "NIM", frequency: "weekly", totalRuns: 3, startAt: new Date().toISOString(), ...overrides,
  });
  assert(r.status === 201, `create schedule ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.schedule;
};
let sched;
await test("schedule is priced for every run and paid once", async () => {
  sched = await newSchedule();
  eq(sched.status, "quoted", "status");
  eq(sched.totalRuns, 3, "runs");
  eq(sched.perRunUsd, 0.67, "per run");
  eq(sched.quote.totalUsd, 2.01, "total = 3 × per run");
  eq(sched.memo, `AuraPay ${sched.ref}`, "memo");
});
await test("verified payment activates it; a 'now' start runs the first payment immediately", async () => {
  const before = await mock("/_test/counters");
  const hash = await registerNimTx(sched);
  const r = await c.post(`/api/schedules/${sched.id}/payment`, { txHash: hash });
  eq(r.json.schedule.status, "active", "active");
  eq(r.json.schedule.runsDone, 1, "first run done");
  eq(r.json.schedule.runs[0]?.status, "successful", "run 1 delivered");
  assert(new Date(r.json.schedule.nextRunAt) - Date.now() > 6 * 86_400_000, "next run a week later");
  eq((await mock("/_test/counters")).topupCalls - before.topupCalls, 1, "one top-up");
  const activity = (await c.get("/api/activity?limit=20")).json.items;
  assert(activity.some((i) => i.category === "bill_schedule"), "schedule in activity");
});
await test("runner needs CRON_SECRET and never runs early or twice", async () => {
  eq((await cron(null)).status, 401, "no secret");
  eq((await cron("wrong")).status, 401, "wrong secret");
  const before = await mock("/_test/counters");
  const results = await Promise.all([cron(), cron(), cron(), c.get(`/api/schedules/${sched.id}`), c.get("/api/schedules")]);
  eq(results[0].status, 200, "runner ok");
  eq((await mock("/_test/counters")).topupCalls, before.topupCalls, "no early run");
  eq((await c.get(`/api/schedules/${sched.id}`)).json.schedule.runs.length, 1, "still one run");
});
await test("runner pays a due schedule exactly once at its time", async () => {
  const s = await newSchedule({ frequency: "once", totalRuns: 1, startAt: new Date(Date.now() + 3000).toISOString() });
  const paid = (await c.post(`/api/schedules/${s.id}/payment`, { txHash: await registerNimTx(s) })).json.schedule;
  eq(paid.status, "active", "active");
  eq(paid.runsDone, 0, "not yet");
  await sleep(3500);
  const before = await mock("/_test/counters");
  const runs = await Promise.all([cron(), cron(), cron(), cron()]);
  eq(runs.reduce((n, r) => n + (r.json.ran ?? 0), 0), 1, "exactly one run across concurrent runners");
  eq((await mock("/_test/counters")).topupCalls - before.topupCalls, 1, "one top-up");
  const done = (await c.get(`/api/schedules/${s.id}`)).json.schedule;
  eq(done.status, "completed", "completed");
  eq(done.runs[0].status, "successful", "delivered");
});
await test("start in the past is rejected", async () => {
  const r = await c.post("/api/schedules", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorCode: CODES.airtime, recipient: "08031234567", amount: 1000, amountCurrency: "local", payCurrency: "NIM", frequency: "monthly", totalRuns: 3, startAt: new Date(Date.now() - 86_400_000).toISOString() });
  eq(r.json.error?.code, "START_IN_PAST", "code");
});
await test("cancel stops future runs; unused runs are owed and refunded after on-chain check", async () => {
  const r = await c.post(`/api/schedules/${sched.id}/cancel`);
  eq(r.json.schedule.status, "cancelled", "cancelled");
  eq(r.json.schedule.refundDue, true, "refund due");
  const auth = { authorization: `Bearer ${ADMIN}` };
  const owed = Number(sched.quote.payAmountAtomic) - Math.floor(Number(sched.quote.payAmountAtomic) / 3);
  assert((await c.get("/api/admin/schedules", auth)).json.schedules.some((x) => x.id === sched.id), "listed for admin");
  const refundHash = nimHash();
  await mock("/_test/nimiq-tx", { hash: refundHash, from: sched.payToAddress, to: PAYER_NIM, value: owed, recipientData: "", blockNumber: 1001, confirmations: 4, timestamp: Date.now(), executionResult: true });
  eq((await c.post(`/api/admin/schedules/${sched.id}/refund`, { refundTxHash: nimHash() }, auth)).status, 409, "unverified refund");
  eq((await c.post(`/api/admin/schedules/${sched.id}/refund`, { refundTxHash: refundHash }, auth)).json.schedule.status, "refunded", "refunded");
});
await test("schedules are private to their account", async () => {
  const other = new Client();
  await signIn(other);
  eq((await other.get(`/api/schedules/${sched.id}`)).status, 404, "read");
  eq((await other.post(`/api/schedules/${sched.id}/cancel`)).status, 404, "cancel");
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
console.log("\nUsernames & transfers (wallet to wallet)");
const rnd = () => randomBytes(3).toString("hex");
const alice = c; // signed in, EVM wallet verified (PAYER_POLY)
const bob = new Client();
const bobAddress = await signIn(bob);
const aliceName = `alice_${rnd()}`;
const bobName = `bob_${rnd()}`;
const asOrder = (t) => ({ payToAddress: t.toAddress, memo: t.memo, quote: { payAmountAtomic: t.amountAtomic } });
await test("claiming a username: format, reserved names, uniqueness", async () => {
  eq((await alice.post("/api/me/username", { username: "1abc" })).json.error?.code, "INVALID_USERNAME", "format");
  eq((await alice.post("/api/me/username", { username: "admin" })).json.error?.code, "USERNAME_RESERVED", "reserved");
  eq((await alice.post("/api/me/username", { username: `@${aliceName.toUpperCase()}` })).json.profile?.username, aliceName, "claimed (normalised)");
  eq((await bob.get(`/api/users/check?username=${aliceName}`)).json.available, false, "now unavailable");
  eq((await bob.post("/api/me/username", { username: aliceName })).json.error?.code, "USERNAME_TAKEN", "taken");
  eq((await bob.post("/api/me/username", { username: bobName })).json.profile?.username, bobName, "bob claimed");
  eq((await alice.get("/api/auth/session")).json.user.username, aliceName, "in session");
});
await test("a username resolves to the owner's receiving addresses (signed-in only)", async () => {
  eq((await new Client().get(`/api/users/${bobName}`)).status, 401, "anonymous");
  const r = (await alice.get(`/api/users/${bobName}`)).json.user;
  eq(r.nimAddress.replace(/\s/g, ""), bobAddress.replace(/\s/g, ""), "NIM address");
  eq(r.polygonAddress, null, "no USDT wallet yet");
  eq((await alice.get(`/api/users/${aliceName}`)).json.user.polygonAddress, PAYER_POLY, "alice's verified USDT wallet");
  eq((await alice.get("/api/users/nobody_here_123")).status, 404, "unknown");
});
let nimTransfer;
await test("send NIM by username: verified on-chain, both sides see it", async () => {
  eq((await new Client().post("/api/transfers", { toUsername: bobName, currency: "NIM", amount: 1 })).status, 401, "auth");
  eq((await alice.post("/api/transfers", { toUsername: aliceName, currency: "NIM", amount: 1 })).json.error?.code, "SELF_TRANSFER", "self");
  const r = await alice.post("/api/transfers", { toUsername: bobName, currency: "NIM", amount: 12.5, note: "Lunch" });
  eq(r.status, 201, "intent");
  nimTransfer = r.json.transfer;
  eq(nimTransfer.amountAtomic, "1250000", "luna");
  assert(nimTransfer.memo.startsWith(`AuraPay ${nimTransfer.ref}`), "memo binds tx to transfer");
  const hash = await registerNimTx(asOrder(nimTransfer));
  const done = (await alice.post(`/api/transfers/${nimTransfer.id}/submit`, { txHash: hash })).json.transfer;
  eq(done.status, "confirmed", "confirmed");
  eq(done.counterparty, bobName, "counterparty");
  const sent = (await alice.get("/api/activity?limit=20")).json.items.find((i) => i.category === "transfer_sent");
  eq(sent?.status, "successful", "sender ledger");
  const got = (await bob.get("/api/activity?limit=20")).json.items.find((i) => i.category === "transfer_received");
  eq(got?.title, `Received from @${aliceName}`, "recipient ledger");
  eq((await bob.get("/api/transfers")).json.transfers[0]?.direction, "received", "bob's list");
  eq((await alice.get("/api/transfers")).json.recent[0], bobName, "recent recipients");
});
await test("a transaction can't be claimed twice; wrong amount or memo fails", async () => {
  const t2 = (await alice.post("/api/transfers", { toUsername: bobName, currency: "NIM", amount: 1 })).json.transfer;
  const r = await alice.post(`/api/transfers/${t2.id}/submit`, { txHash: (await alice.get(`/api/transfers/${nimTransfer.id}`)).json.transfer.txHash });
  eq(r.json.error?.code, "TX_ALREADY_USED", "reuse");
  const short = await registerNimTx(asOrder(t2), { value: 99_999 });
  eq((await alice.post(`/api/transfers/${t2.id}/submit`, { txHash: short })).json.transfer.status, "failed", "underpaid");
  const t3 = (await alice.post("/api/transfers", { toUsername: bobName, currency: "NIM", amount: 1 })).json.transfer;
  const wrongMemo = await registerNimTx(asOrder(t3), { recipientData: Buffer.from("AuraPay TX-OTHER").toString("hex") });
  eq((await alice.post(`/api/transfers/${t3.id}/submit`, { txHash: wrongMemo })).json.transfer.status, "failed", "memo mismatch");
});
await test("USDT by username needs the recipient's verified wallet; exact amount from the sender's", async () => {
  eq((await alice.post("/api/transfers", { toUsername: bobName, currency: "USDT", amount: 5, fromAddress: PAYER_POLY })).json.error?.code, "NO_USDT_ADDRESS", "no wallet");
  const bobEvm = privateKeyToAccount(`0x${"22".repeat(32)}`);
  eq((await linkEvm(bob, bobEvm)).status, 200, "bob verifies a wallet");
  const ok = await alice.post("/api/transfers", { toUsername: bobName, currency: "USDT", amount: 5, fromAddress: "0x3333333333333333333333333333333333333333" });
  eq(ok.json.error?.code, "PAYER_NOT_VERIFIED", "unverified sender wallet");
  const t = (await alice.post("/api/transfers", { toUsername: bobName, currency: "USDT", amount: 5, fromAddress: PAYER_POLY })).json.transfer;
  eq(t.toAddress, bobEvm.address.toLowerCase(), "to bob's wallet");
  eq(t.amountAtomic, "5000000", "units");
  const hash = await registerPolyTx(asOrder(t));
  eq((await alice.post(`/api/transfers/${t.id}/submit`, { txHash: hash })).json.transfer.status, "confirmed", "confirmed");
});
await test("transfers are private to their two parties", async () => {
  const eve = new Client();
  await signIn(eve);
  eq((await eve.get(`/api/transfers/${nimTransfer.id}`)).status, 404, "read");
  eq((await bob.get(`/api/transfers/${nimTransfer.id}`)).json.transfer.direction, "received", "recipient can read");
});

console.log("\nLocal currency display");
await test("display currency is saved and priced at the bill provider's rate", async () => {
  eq((await alice.post("/api/me/display-currency", { currency: "EUR" })).status, 422, "unsupported");
  eq((await alice.post("/api/me/display-currency", { currency: "NGN" })).json.displayCurrency, "NGN", "saved");
  eq((await alice.get("/api/auth/session")).json.user.displayCurrency, "NGN", "in session");
  const r = (await alice.get("/api/rates?fiat=NGN")).json;
  assert(Math.abs(r.fiat.perUsd - (PROVIDER === "flutterwave" ? 1500 : 1600)) < 0.01, `rate (Flutterwave, else CoinGecko): ${r.fiat.perUsd}`);
  eq(r.fiat.source, PROVIDER === "flutterwave" ? "flutterwave" : "coingecko", "source");
  eq((await alice.get("/api/rates?fiat=USD")).json.fiat.perUsd, 1, "USD");
});

console.log("\nRecurring payments & bill reminders");
let reminder;
await test("a reminder repeats a real payment and is due on its date", async () => {
  const done = await createOrder(alice, { recipient: "08031234567", amount: 700 });
  eq((await payNim(alice, done)).status, "successful", "source payment");
  const r = await alice.post("/api/recurring", { orderId: done.id, frequency: "monthly", firstDueAt: new Date().toISOString() });
  eq(r.status, 201, "created");
  reminder = r.json.item;
  eq(reminder.payload.amount, 700, "amount copied");
  eq(reminder.payload.recipient, "2348031234567", "recipient copied");
  eq(reminder.due, "today", "due");
  eq(reminder.payUrl, `/pay?recurring=${reminder.id}`, "one-tap pay link");
  eq((await alice.post(`/api/recurring/${reminder.id}/paid`)).json.error?.code, "NO_MATCHING_PAYMENT", "the source payment doesn't count");
  eq((await bob.get(`/api/recurring/${reminder.id}`)).status, 404, "private");
});
await test("paying the bill advances it a month; calendar file has the repeat rule", async () => {
  const again = await createOrder(alice, { recipient: "08031234567", amount: 700 });
  eq((await payNim(alice, again)).status, "successful", "paid");
  const item = (await alice.post(`/api/recurring/${reminder.id}/paid`)).json.item;
  eq(item.timesPaid, 1, "times paid");
  const days = (new Date(item.nextDueAt) - Date.now()) / 86_400_000;
  assert(days > 26 && days < 32, `next due in ~1 month, got ${days.toFixed(1)} days`);
  eq(item.due, "later", "no longer due");
  const ics = await fetch(APP + `/api/recurring/${reminder.id}/ics`, { headers: { cookie: alice.cookie } });
  eq(ics.headers.get("content-type")?.startsWith("text/calendar"), true, "content type");
  assert((await ics.text()).includes("RRULE:FREQ=MONTHLY"), "monthly rule");
});
await test("a transfer reminder settles automatically when the transfer is made", async () => {
  const r = (await alice.post("/api/recurring", { transferId: nimTransfer.id, frequency: "weekly", firstDueAt: new Date().toISOString() })).json.item;
  eq(r.kind, "transfer", "kind");
  assert(r.payUrl.startsWith(`/send?to=${bobName}`), "prefilled send link");
  const t = (await alice.post("/api/transfers", { toUsername: bobName, currency: "NIM", amount: 12.5 })).json.transfer;
  await alice.post(`/api/transfers/${t.id}/submit`, { txHash: await registerNimTx(asOrder(t)) });
  const listed = (await alice.get("/api/recurring")).json.items.find((x) => x.id === r.id);
  eq(listed.timesPaid, 1, "settled by listing (payment made through the normal flow)");
  const pause = (await alice.patch(`/api/recurring/${r.id}`, { active: false })).json.item;
  eq(pause.active, false, "paused");
  eq((await alice.del(`/api/recurring/${r.id}`)).status, 200, "deleted");
});

console.log("\nProfile pictures");
// 1×1 PNG; the app uploads 320px WebP/JPEG, but any real JPEG/PNG/WebP is accepted.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
await test("set, serve and remove a profile picture; others see it on your @username", async () => {
  eq((await alice.req("PUT", "/api/me/avatar", { image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).json.error?.code, "INVALID_IMAGE", "SVG refused");
  eq((await alice.req("PUT", "/api/me/avatar", { image: `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}` })).json.error?.code, "INVALID_IMAGE", "bytes must be an image");
  eq((await alice.req("PUT", "/api/me/avatar", { image: `data:image/png;base64,${Buffer.alloc(300_000, 1).toString("base64")}` })).status, 422, "size capped");
  const url = (await alice.req("PUT", "/api/me/avatar", { image: `data:image/png;base64,${PNG_1PX}` })).json.avatarUrl;
  assert(/^\/api\/avatars\/[0-9a-f-]{36}\?v=1$/.test(url), `versioned url ${url}`);
  eq((await alice.get("/api/auth/session")).json.user.avatarUrl, url, "in session");
  const res = await fetch(APP + url);
  eq(res.status, 200, "served");
  eq(res.headers.get("content-type"), "image/png", "type from the bytes");
  eq(res.headers.get("x-content-type-options"), "nosniff", "nosniff");
  eq(Buffer.from(await res.arrayBuffer()).toString("base64"), PNG_1PX, "same bytes");
  eq((await bob.get(`/api/users/${aliceName}`)).json.user.avatarUrl, url, "visible on the username");
  const url2 = (await alice.req("PUT", "/api/me/avatar", { image: `data:image/png;base64,${PNG_1PX}` })).json.avatarUrl;
  assert(url2.endsWith("?v=2"), "new version, new URL");
  eq((await alice.del("/api/me/avatar")).json.avatarUrl, null, "removed");
  eq((await fetch(APP + url)).status, 404, "gone");
  eq((await new Client().req("PUT", "/api/me/avatar", { image: `data:image/png;base64,${PNG_1PX}` })).status, 401, "sign-in required");
});

console.log("\nSavings circles (rotating, wallet to wallet)");
let circle;
const contribute = async (client, toName, round, amount = 2) => {
  const r = await client.post("/api/transfers", { toUsername: toName, currency: "NIM", amount, circleId: circle.id, round });
  if (r.status !== 201) return r;
  const t = r.json.transfer;
  return client.post(`/api/transfers/${t.id}/submit`, { txHash: await registerNimTx(asOrder(t)) });
};
await test("organizer creates a circle; members are invited by username", async () => {
  eq((await alice.post("/api/circles", { name: "Fam", currency: "NIM", amount: 2, frequency: "monthly", startAt: new Date().toISOString(), members: ["nobody_xyz_1"] })).json.error?.code, "USER_NOT_FOUND", "unknown member");
  const r = await alice.post("/api/circles", { name: "Family ajo", currency: "NIM", amount: 2, frequency: "monthly", startAt: new Date().toISOString(), members: [bobName] });
  eq(r.status, 201, "created");
  circle = r.json.circle;
  eq(circle.members.map((m) => m.username).join(","), `${aliceName},${bobName}`, "payout order: organizer first");
  eq(circle.status, "forming", "forming");
  const invite = (await bob.get("/api/circles")).json.circles.find((x) => x.id === circle.id);
  eq(invite.myAction.type, "accept", "bob sees the invite");
  eq((await alice.post(`/api/circles/${circle.id}/start`)).json.error?.code, "WAITING_FOR_MEMBERS", "can't start before replies");
  eq((await bob.post(`/api/circles/${circle.id}/start`)).json.error?.code, "NOT_ORGANIZER", "only organizer starts");
});
await test("members join; contributions are checked against the round", async () => {
  eq((await bob.post(`/api/circles/${circle.id}/respond`, { accept: true })).json.circle.myStatus, "joined", "joined");
  const started = (await alice.post(`/api/circles/${circle.id}/start`)).json.circle;
  eq(started.status, "active", "active");
  eq(started.rounds.length, 2, "two rounds");
  eq(started.rounds[0].recipient, aliceName, "round 1 to organizer");
  eq((await bob.get(`/api/circles/${circle.id}`)).json.circle.myAction.type, "pay", "bob must pay");
  eq((await contribute(bob, aliceName, 1, 3)).json.error?.code, "WRONG_AMOUNT", "wrong amount");
  eq((await contribute(bob, bobName, 1)).json.error?.code, "SELF_TRANSFER", "can't pay yourself");
  eq((await contribute(alice, aliceName, 1)).json.error?.code, "SELF_TRANSFER", "recipient doesn't pay own round");
  eq((await contribute(alice, bobName, 1)).json.error?.code, "WRONG_RECIPIENT", "round 1 goes to alice");
  eq((await contribute(bob, aliceName, 1)).json.transfer.status, "confirmed", "round 1 paid");
  eq((await contribute(bob, aliceName, 1)).json.error?.code, "ALREADY_CONTRIBUTED", "once per round");
  const c = (await alice.get(`/api/circles/${circle.id}`)).json.circle;
  eq(c.rounds[0].complete, true, "round 1 complete");
  eq(c.currentRound, 2, "now round 2");
  eq((await new Client().get(`/api/circles/${circle.id}`)).status, 401, "auth");
});
await test("the circle completes when every round is paid", async () => {
  eq((await contribute(bob, aliceName, 2)).json.error?.code, "WRONG_RECIPIENT", "round 2 goes to bob");
  eq((await contribute(alice, bobName, 2)).json.transfer.status, "confirmed", "round 2 paid");
  eq((await bob.get(`/api/circles/${circle.id}`)).json.circle.status, "completed", "completed");
  const got = (await alice.get("/api/activity?limit=50")).json.items.filter((i) => i.category === "transfer_received");
  assert(got.length >= 1, "alice received her payout in activity");
});

console.log("\nEarn: Aave V3 on Polygon (wallet-sent, receipt-verified)");
const POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const ROUTER = "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff";
const USDT_P = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const AUSDT = "0x6ab707aca953edaefbc4fd23ba73294241490620";
const NIM_P = "0x4e494d0000000000000000000000000000000001";
const PAIR = "0x4e494d0000000000000000000000000000000002";
const pad32 = (a) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const transferLog = (token, from, to, units) => ({ address: token, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad32(from), pad32(to)], data: pad32(BigInt(units).toString(16)) });
const polyReceipt = async ({ from = PAYER_POLY, to, logs, status = "0x1", tx }) => {
  const hash = polyHash();
  await mock("/_test/polygon-tx", { hash, timestamp: Date.now(), receipt: { status, blockNumber: "0x3938700", from, to, logs }, tx });
  return hash;
};
await test("position is read live from Polygon (aPolUSDT, wallet USDT, POL, live APY)", async () => {
  const p = (await alice.get(`/api/earn/position?address=${PAYER_POLY}`)).json.position;
  eq(p.walletUsdt, 25.5, "wallet USDT");
  eq(p.supplied, 0, "nothing supplied yet");
  eq(p.pol, 2, "POL for gas");
  assert(p.apy > 0.0370 && p.apy < 0.0380, `APY from Aave's liquidity rate ≈3.75%, got ${p.apy}`);
  eq((await alice.get("/api/earn/position?address=0x3333333333333333333333333333333333333333")).status, 422, "only your verified wallets");
});
await test("a deposit (supply) is confirmed from its receipt and shows in Activity", async () => {
  const hash = await polyReceipt({ to: POOL, logs: [transferLog(USDT_P, PAYER_POLY, AUSDT, 10_000_000)] });
  const a = (await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: hash, from: PAYER_POLY, amount: "10" })).json.action;
  eq(a.status, "confirmed", "confirmed");
  eq(a.amountIn, 10, "amount from the Transfer log");
  const item = (await alice.get("/api/activity?limit=50")).json.items.find((i) => i.category === "earn_deposit");
  eq(item?.status, "successful", "activity");
});
await test("a max withdraw records the real amount; it hands off to Pay with USDT", async () => {
  const hash = await polyReceipt({ to: POOL, logs: [transferLog(USDT_P, AUSDT, PAYER_POLY, 10_003_412)] });
  const a = (await alice.post("/api/defi/actions", { kind: "earn_withdraw", txHash: hash, from: PAYER_POLY })).json.action;
  eq(a.status, "confirmed", "confirmed");
  eq(a.amountOut, 10.003412, "principal + interest from the log");
  // the USDT can go straight into a bill quote paid in USDT
  const o = await createOrder(alice, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  eq(o.quote.payCurrency, "USDT", "bill payable with the withdrawn USDT");
});
await test("reverted, misdirected, foreign-wallet and reused transactions never count", async () => {
  const reverted = await polyReceipt({ to: POOL, status: "0x0", logs: [] });
  eq((await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: reverted, from: PAYER_POLY, amount: "1" })).json.action.status, "failed", "reverted");
  const wrongTo = await polyReceipt({ to: ROUTER, logs: [transferLog(USDT_P, PAYER_POLY, AUSDT, 1_000_000)] });
  eq((await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: wrongTo, from: PAYER_POLY, amount: "1" })).json.action.status, "failed", "wrong contract");
  const notMine = await polyReceipt({ to: POOL, logs: [transferLog(USDT_P, PAYER_POLY, AUSDT, 1_000_000)] });
  eq((await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: notMine, from: "0x3333333333333333333333333333333333333333", amount: "1" })).json.error?.code, "PAYER_NOT_VERIFIED", "unverified wallet");
  const once = await polyReceipt({ to: POOL, logs: [transferLog(USDT_P, PAYER_POLY, AUSDT, 2_000_000)] });
  await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: once, from: PAYER_POLY, amount: "2" });
  eq((await alice.post("/api/defi/actions", { kind: "earn_supply", txHash: once, from: PAYER_POLY, amount: "2" })).json.action.status, "confirmed", "same user: idempotent");
  const bobEvm = privateKeyToAccount(`0x${"22".repeat(32)}`).address.toLowerCase();
  eq((await bob.post("/api/defi/actions", { kind: "earn_supply", txHash: once, from: bobEvm, amount: "2" })).json.error?.code, "TX_ALREADY_USED", "another user can't claim it");
});

console.log("\nSwap: QuickSwap USDT ↔ POL and NIM ↔ USDT on Polygon");
const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", POLPAIR = "0x604229c960e5cacf2aaeac8be68ac07ba9df81c3";
const ROUTER_ABI = parseAbi([
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const WPOL_ABI = parseAbi(["event Deposit(address indexed dst, uint256 wad)", "event Withdrawal(address indexed src, uint256 wad)"]);
const wpolLog = (eventName, who, wad) => ({ address: WPOL, topics: encodeEventTopics({ abi: WPOL_ABI, eventName, args: eventName === "Deposit" ? { dst: who } : { src: who } }), data: pad32(wad.toString(16)) });
await test("USDT ↔ POL is always offered (QuickSwap WPOL/USDT pool)", async () => {
  const pol = (await alice.get("/api/swap/config")).json.swap.pairs.POL;
  eq(pol.enabled, true, "enabled");
  eq(pol.pair, POLPAIR, "WPOL/USDT pair via factory");
  eq(pol.decimals, 18, "POL decimals");
});
await test("USDT → POL: quote, then verified from calldata + WPOL unwrap", async () => {
  const q = (await alice.get("/api/swap/quote?direction=USDT_POL&amount=2")).json.quote;
  const rin = 400_000n * 1_000_000n, rout = 2_000_000n * 10n ** 18n, inFee = 2_000_000n * 997n;
  eq(q.amountOut, ((inFee * rout) / (rin * 1000n + inFee)).toString(), "constant-product quote");
  eq(q.path.join(), `${USDT_P},${WPOL}`, "USDT → WPOL path");
  eq(q.decimalsOut, 18, "out decimals");
  const out = BigInt(q.amountOut);
  const input = (to) => encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactTokensForETH", args: [2_000_000n, out, [USDT_P, WPOL], to, 9_999_999_999n] });
  const logs = [transferLog(USDT_P, PAYER_POLY, POLPAIR, 2_000_000), transferLog(WPOL, POLPAIR, ROUTER, out), wpolLog("Withdrawal", ROUTER, out)];
  const hash = await polyReceipt({ to: ROUTER, logs, tx: { input: input(PAYER_POLY), value: "0x0" } });
  const a = (await alice.post("/api/defi/actions", { kind: "swap", txHash: hash, from: PAYER_POLY, amount: "2", direction: "USDT_POL" })).json.action;
  eq(a.status, "confirmed", "confirmed");
  eq(a.amountIn, 2, "USDT in");
  eq(a.amountOut, Number((Number(out) / 1e18).toFixed(8)), "POL out from the unwrap (stored to 8 dp)");
  // Same receipt, but the router was told to pay someone else: never counted as yours.
  const other = await polyReceipt({ to: ROUTER, logs, tx: { input: input("0x3333333333333333333333333333333333333333"), value: "0x0" } });
  const b = (await alice.post("/api/defi/actions", { kind: "swap", txHash: other, from: PAYER_POLY, amount: "2", direction: "USDT_POL" })).json.action;
  eq(b.status, "failed", "POL sent elsewhere is rejected");
  const item = (await alice.get("/api/activity?limit=50")).json.items.find((i) => i.title === "Swapped USDT → POL");
  assert(item, "activity shows the POL top-up");
});
await test("POL → USDT: value wrapped by the router, USDT to the wallet", async () => {
  const value = 10n ** 18n;
  const q = (await alice.get("/api/swap/quote?direction=POL_USDT&amount=1")).json.quote;
  const out = BigInt(q.amountOut);
  const input = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokens", args: [out, [WPOL, USDT_P], PAYER_POLY, 9_999_999_999n] });
  const logs = [wpolLog("Deposit", ROUTER, value), transferLog(WPOL, ROUTER, POLPAIR, value), transferLog(USDT_P, POLPAIR, PAYER_POLY, out)];
  const hash = await polyReceipt({ to: ROUTER, logs, tx: { input, value: `0x${value.toString(16)}` } });
  const a = (await alice.post("/api/defi/actions", { kind: "swap", txHash: hash, from: PAYER_POLY, amount: "1", direction: "POL_USDT" })).json.action;
  eq(a.status, "confirmed", "confirmed");
  eq(a.amountIn, 1, "POL in = tx value");
  eq(a.amountOut, Number(out) / 1e6, "USDT out");
});
await test("NIM ↔ USDT is offered only when NIM exists on Polygon with a QuickSwap pool", async () => {
  const cfg = (await alice.get("/api/swap/config")).json.swap.pairs.NIM;
  if (PROVIDER === "flutterwave") {
    eq(cfg.enabled, true, "enabled (NIM_POLYGON_TOKEN set, pair exists)");
    eq(cfg.pair, PAIR, "pair found via router.factory().getPair()");
    eq(cfg.decimals, 5, "decimals read from the token");
  } else {
    eq(cfg.enabled, false, "disabled without NIM on Polygon");
    assert(/Polygon/.test(cfg.reason), "explains why");
    eq((await alice.get("/api/swap/quote?direction=USDT_NIM&amount=5")).json.error?.code, "SWAP_UNAVAILABLE", "no quotes");
  }
});
await test("quotes come from the router; a swap is verified from its receipt", async () => {
  if (PROVIDER !== "flutterwave") return;
  const q = (await alice.get("/api/swap/quote?direction=USDT_NIM&amount=6")).json.quote;
  const rin = 60_000n * 1_000_000n, rout = 50_000_000n * 100_000n, inFee = 6_000_000n * 997n;
  eq(q.amountOut, ((inFee * rout) / (rin * 1000n + inFee)).toString(), "constant-product quote");
  eq(q.path.join(), `${USDT_P},${NIM_P}`, "direct path");
  assert(q.priceImpact >= 0 && q.priceImpact < 0.01, "small price impact");
  const b = (await alice.get(`/api/swap/balances?address=${PAYER_POLY}`)).json.balances;
  eq(b.nim, 10_000, "NIM on Polygon balance");
  const hash = await polyReceipt({ to: ROUTER, logs: [transferLog(USDT_P, PAYER_POLY, PAIR, 6_000_000), transferLog(NIM_P, PAIR, PAYER_POLY, BigInt(q.amountOut))] });
  const a = (await alice.post("/api/defi/actions", { kind: "swap", txHash: hash, from: PAYER_POLY, amount: "6", direction: "USDT_NIM" })).json.action;
  eq(a.status, "confirmed", "confirmed");
  eq(a.amountIn, 6, "USDT in");
  eq(a.amountOut, Number(BigInt(q.amountOut)) / 1e5, "NIM out (5 decimals)");
  const item = (await alice.get("/api/activity?limit=50")).json.items.find((i) => i.category === "swap");
  eq(item?.title, "Swapped USDT → NIM", "activity");
});

await test("invest and borrow APIs are gone", async () => {
  for (const p of ["/api/portfolio", "/api/markets/quotes", "/api/borrow"]) eq((await c.get(p)).status, 404, p);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
