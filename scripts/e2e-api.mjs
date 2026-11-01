#!/usr/bin/env node
/**
 * End-to-end API tests against a running AuraPay server wired to scripts/mock-providers.mjs.
 * See README "Testing" for the env used. Exits non-zero on failure.
 *
 *   APP=http://localhost:3000 MOCK=http://localhost:4010 node scripts/e2e-api.mjs
 */
import { randomUUID, randomBytes } from "node:crypto";

const APP = process.env.APP ?? "http://localhost:3000";
const MOCK = process.env.MOCK ?? "http://localhost:4010";
const ADMIN = process.env.ADMIN_API_TOKEN ?? "test-admin-token-123";
const MERCHANT_NIM = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const PAYER_NIM = "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB";
const PAYER_POLY = "0x2222222222222222222222222222222222222222";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookie = "";
  async req(method, path, body, headers = {}) {
    const res = await fetch(APP + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }
  get = (p, h) => this.req("GET", p, undefined, h);
  post = (p, b, h) => this.req("POST", p, b, h);
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

const mock = async (path, body) => (await fetch(MOCK + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const nimHash = () => randomBytes(32).toString("hex");
const polyHash = () => `0x${randomBytes(32).toString("hex")}`;

async function registerNimTx(order, overrides = {}) {
  const hash = overrides.hash ?? nimHash();
  await mock("/_test/nimiq-tx", {
    hash, from: PAYER_NIM, to: order.payToAddress, value: Number(order.quote.payAmountAtomic), fee: 0,
    recipientData: hex(order.memo ?? ""), blockNumber: 1000, confirmations: 5, timestamp: Date.now(), executionResult: true, ...overrides,
  });
  return hash;
}

async function registerPolyTx(order, { units, from = PAYER_POLY, hash = polyHash() } = {}) {
  const pad = (a) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
  const head = 60_000_000;
  const blockNumber = `0x${(head - 20).toString(16)}`;
  await mock("/_test/polygon-tx", {
    hash,
    timestamp: Date.now(),
    receipt: {
      status: "0x1", blockNumber, to: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
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
    clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorId: 341, recipient: "08031234567",
    amount: 1000, amountCurrency: "local", payCurrency: "DEMO", ...overrides,
  });
  assert(r.status === 201, `create order ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.order;
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

console.log("\nStatus & catalogue");
await test("status reports modes and rails truthfully", async () => {
  const { json } = await c.get("/api/status");
  eq(json.reloadly.state, "sandbox", "reloadly");
  eq(json.rails.NIM.available, true, "NIM rail");
  eq(json.rails.USDT.available, true, "USDT rail (ALLOW_REAL_PAYMENTS_FOR_SANDBOX in test)");
  eq(json.rails.DEMO.available, true, "DEMO rail");
  eq(json.brokerage.state, "unavailable", "brokerage");
  eq(json.lending.state, "simulator", "lending");
  eq(json.rates.state, "live", "rates");
});
await test("countries list only provider-supported services", async () => {
  const { json } = await c.get("/api/utilities/countries");
  const ng = json.countries.find((x) => x.code === "NG");
  const tz = json.countries.find((x) => x.code === "TZ");
  assert(ng.services.airtime && ng.services.data && ng.services.electricity, "NG should have all three");
  assert(!tz.services.airtime && !tz.services.data && !tz.services.electricity, "TZ unsupported in mock → no services");
});
await test("operators split into airtime and data", async () => {
  const a = await c.get("/api/utilities/operators?country=NG&service=airtime");
  const d = await c.get("/api/utilities/operators?country=NG&service=data");
  eq(a.json.operators.length, 2, "airtime ops");
  eq(d.json.operators.length, 1, "data ops");
  eq(d.json.operators[0].products[1].description, "3GB · 30 days", "bundle description");
});
await test("phone validation + operator auto-detect", async () => {
  const ok = await c.get("/api/utilities/detect?country=NG&phone=08031234567");
  eq(ok.json.valid, true, "valid");
  eq(ok.json.e164, "2348031234567", "e164");
  eq(ok.json.operator?.name, "MTN Nigeria", "detected");
  const bad = await c.get("/api/utilities/detect?country=NG&phone=12345");
  eq(bad.json.valid, false, "invalid number");
});

console.log("\nUtility orders — simulated payment + sandbox provider");
let demoOrder;
await test("quote is priced server-side", async () => {
  demoOrder = await createOrder(c);
  eq(demoOrder.status, "quoted", "status");
  eq(demoOrder.quote.providerCostUsd, 0.67, "provider cost (1000 NGN / 1500)");
  eq(demoOrder.quote.serviceFeeUsd, 0.1, "min fee");
  eq(demoOrder.quote.totalUsd, 0.77, "total");
  eq(demoOrder.environment, "sandbox", "environment");
  eq(demoOrder.recipient, "2348031234567", "normalised phone");
});
await test("idempotent create with same clientRequestId", async () => {
  const id = randomUUID();
  const body = { clientRequestId: id, service: "airtime", countryCode: "NG", operatorId: 341, recipient: "08031234567", amount: 500, amountCurrency: "local", payCurrency: "DEMO" };
  const a = await c.post("/api/orders", body);
  const b = await c.post("/api/orders", body);
  eq(a.json.order.id, b.json.order.id, "same order");
});
await test("simulated payment → sandbox top-up → successful", async () => {
  const before = await mock("/_test/counters");
  const r = await c.post(`/api/orders/${demoOrder.id}/payment`, {});
  eq(r.json.order.status, "successful", "status");
  eq(r.json.order.isSimulatedPayment, true, "simulated flag");
  const after = await mock("/_test/counters");
  eq(after.topupCalls - before.topupCalls, 1, "exactly one topup call");
  assert(after.topupsByCustomId[demoOrder.ref], "customIdentifier = order ref");
});
await test("re-submitting payment is idempotent (no second top-up)", async () => {
  const before = await mock("/_test/counters");
  const r = await c.post(`/api/orders/${demoOrder.id}/payment`, {});
  eq(r.json.order.status, "successful", "status");
  eq((await mock("/_test/counters")).topupCalls, before.topupCalls, "no extra topup");
});
await test("invalid phone rejected at quote time", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorId: 341, recipient: "0123", amount: 1000, amountCurrency: "local", payCurrency: "DEMO" });
  eq(r.status, 422, "status");
});
await test("amount outside operator range rejected", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorId: 341, recipient: "08031234567", amount: 50, amountCurrency: "local", payCurrency: "DEMO" });
  eq(r.status, 422, "status");
});
await test("data bundle (FIXED) purchase", async () => {
  const o = await createOrder(c, { service: "data", operatorId: 645, amount: 1.34, amountCurrency: "sender" });
  eq(o.productDescription, "3GB · 30 days", "product");
  eq(o.amountLocal, 2000, "local value");
  const r = await c.post(`/api/orders/${o.id}/payment`, {});
  eq(r.json.order.status, "successful", "status");
});
await test("airtime operator can't be used for data", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "data", countryCode: "NG", operatorId: 341, recipient: "08031234567", amount: 1, amountCurrency: "sender", payCurrency: "DEMO" });
  eq(r.status, 422, "status");
});

console.log("\nNIM payments — on-chain verification");
await test("verified NIM payment is fulfilled", async () => {
  const o = await createOrder(c, { payCurrency: "NIM" });
  assert(o.memo === `AuraPay ${o.ref}`, "memo binds order ref");
  assert(o.payToAddress === MERCHANT_NIM.replace(/\s/g, ""), "merchant address");
  // 0.77 USD * 1.01 buffer / 0.0012 = 648.083… NIM → rounded up in luna
  eq(o.quote.payAmountAtomic, String(Math.ceil((0.77 * 1.01 / 0.0012) * 1e5)), "luna amount");
  const hash = await registerNimTx(o);
  const r = await c.post(`/api/orders/${o.id}/payment`, { txHash: hash });
  eq(r.json.order.status, "successful", "status");
  eq(r.json.order.paymentTxHash, hash, "tx hash recorded");
});
await test("same tx hash cannot pay a second order", async () => {
  const o1 = await createOrder(c, { payCurrency: "NIM" });
  const hash = await registerNimTx(o1);
  await c.post(`/api/orders/${o1.id}/payment`, { txHash: hash });
  const o2 = await createOrder(c, { payCurrency: "NIM" });
  const r = await c.post(`/api/orders/${o2.id}/payment`, { txHash: hash });
  eq(r.status, 409, "status");
  eq(r.json.error.code, "TX_ALREADY_USED", "code");
});
await test("memo mismatch → requires review, never fulfilled", async () => {
  const before = await mock("/_test/counters");
  const o = await createOrder(c, { payCurrency: "NIM" });
  const hash = await registerNimTx(o, { recipientData: hex("AuraPay AP-SOMEOTHER") });
  const r = await c.post(`/api/orders/${o.id}/payment`, { txHash: hash });
  eq(r.json.order.status, "requires_review", "status");
  eq((await mock("/_test/counters")).topupCalls, before.topupCalls, "no topup");
});
await test("underpayment → requires review", async () => {
  const o = await createOrder(c, { payCurrency: "NIM" });
  const hash = await registerNimTx(o, { value: Number(o.quote.payAmountAtomic) - 1 });
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: hash })).json.order.status, "requires_review", "status");
});
await test("unconfirmed → pending, then fulfilled once confirmed; concurrent polls fulfil once", async () => {
  const o = await createOrder(c, { payCurrency: "NIM" });
  const hash = nimHash();
  const r = await c.post(`/api/orders/${o.id}/payment`, { txHash: hash });
  eq(r.json.order.status, "payment_pending", "pending while not on-chain");
  await registerNimTx(o, { hash, confirmations: 1 });
  eq((await c.get(`/api/orders/${o.id}`)).json.order.status, "payment_pending", "still pending at 1 confirmation");
  await registerNimTx(o, { hash, confirmations: 3 });
  const before = await mock("/_test/counters");
  const results = await Promise.all(Array.from({ length: 8 }, () => c.get(`/api/orders/${o.id}`)));
  const after = await mock("/_test/counters");
  eq(after.topupCalls - before.topupCalls, 1, "exactly one topup despite 8 concurrent requests");
  assert(results.some((x) => x.json.order.status === "successful"), "eventually successful");
});
await test("invalid hash format rejected", async () => {
  const o = await createOrder(c, { payCurrency: "NIM" });
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: "abc" })).status, 422, "status");
});

console.log("\nUSDT payments — Polygon verification");
await test("exact USDT transfer from payer is fulfilled", async () => {
  const o = await createOrder(c, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  const units = BigInt(o.quote.payAmountAtomic);
  assert(units >= 770_001n && units <= 770_099n, `USDT carries a per-order tag: ${units}`);
  const hash = await registerPolyTx(o);
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: hash })).json.order.status, "successful", "status");
});
await test("USDT amount mismatch → requires review", async () => {
  const o = await createOrder(c, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  const hash = await registerPolyTx(o, { units: "770000" });
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: hash })).json.order.status, "requires_review", "status");
});
await test("USDT transfer from a different wallet → requires review", async () => {
  const o = await createOrder(c, { payCurrency: "USDT", payerAddress: PAYER_POLY });
  const hash = await registerPolyTx(o, { from: "0x3333333333333333333333333333333333333333" });
  eq((await c.post(`/api/orders/${o.id}/payment`, { txHash: hash })).json.order.status, "requires_review", "status");
});
await test("USDT requires payer address", async () => {
  const r = await c.post("/api/orders", { clientRequestId: randomUUID(), service: "airtime", countryCode: "NG", operatorId: 341, recipient: "08031234567", amount: 1000, amountCurrency: "local", payCurrency: "USDT" });
  eq(r.status, 422, "status");
});

console.log("\nElectricity");
await test("billers + electricity payment → token after provider processing", async () => {
  const b = await c.get("/api/utilities/billers?country=NG");
  eq(b.json.billers[0].name, "Ikeja Electricity Prepaid", "biller");
  const o = await createOrder(c, { service: "electricity", operatorId: 9, recipient: "04223568280", amount: 5000, amountCurrency: "local" });
  eq(o.quote.providerCostUsd, 3.4, "(5000 + 100 fee) / 1500 rounded up");
  const r = await c.post(`/api/orders/${o.id}/payment`, {});
  eq(r.json.order.status, "provider_pending", "processing at provider");
  const done = await waitFor(c, o.id, (x) => x.status === "successful", 25_000);
  eq(done.deliveryDetails.token, "1234-5678-9012-3456-7890", "token");
});

console.log("\nFailure handling, refunds, admin");
let reviewOrder;
await test("provider failure after verified payment → requires review", async () => {
  await mock("/_test/fail-next-topup", { errorCode: "INSUFFICIENT_BALANCE" });
  reviewOrder = await createOrder(c, { payCurrency: "NIM" });
  const hash = await registerNimTx(reviewOrder);
  const r = await c.post(`/api/orders/${reviewOrder.id}/payment`, { txHash: hash });
  eq(r.json.order.status, "requires_review", "status");
  assert(/temporarily unavailable/i.test(r.json.order.statusReason), "friendly reason");
});
await test("admin API requires token", async () => {
  eq((await c.get("/api/admin/orders")).status, 401, "unauthenticated");
  const r = await c.get("/api/admin/orders", { authorization: `Bearer ${ADMIN}` });
  eq(r.status, 200, "authenticated");
  assert(r.json.orders.some((o) => o.id === reviewOrder.id), "review order listed");
});
await test("refund is recorded only after on-chain verification", async () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const missing = await c.post(`/api/admin/orders/${reviewOrder.id}/refund`, { refundTxHash: nimHash() }, auth);
  eq(missing.status, 409, "unverifiable refund rejected");
  const refundHash = nimHash();
  await mock("/_test/nimiq-tx", {
    hash: refundHash, from: reviewOrder.payToAddress, to: PAYER_NIM, value: Number(reviewOrder.quote.payAmountAtomic),
    recipientData: "", blockNumber: 1001, confirmations: 4, timestamp: Date.now(), executionResult: true,
  });
  const r = await c.post(`/api/admin/orders/${reviewOrder.id}/refund`, { refundTxHash: refundHash }, auth);
  eq(r.json.order.status, "refunded", "status");
  const act = await c.get("/api/activity?limit=100");
  assert(act.json.items.some((i) => i.category === "refund"), "refund in activity");
});

console.log("\nIsolation & activity");
await test("orders are private to their session", async () => {
  const other = new Client();
  eq((await other.get(`/api/orders/${demoOrder.id}`)).status, 404, "other session can't read");
  eq((await other.post(`/api/orders/${demoOrder.id}/payment`, {})).status, 404, "other session can't pay");
});
await test("activity ledger mirrors order states", async () => {
  const { json } = await c.get("/api/activity?limit=200");
  const item = json.items.find((i) => i.ref === demoOrder.ref);
  eq(item.status, "successful", "ledger status");
  eq(item.isSimulated, true, "simulated flagged");
  const detail = await c.get(`/api/activity/${item.id}`);
  eq(detail.json.order.ref, demoOrder.ref, "detail includes order");
});

console.log("\nInvest & borrow simulators");
let loanId;
await test("estimate + simulated stock order + portfolio", async () => {
  const e = await c.post("/api/invest/estimate", { symbol: "NVDA", notionalUsd: 500, payCurrency: "USDT" });
  eq(e.status, 200, "estimate");
  eq(e.json.execution.state, "unavailable", "no real execution");
  const o = await c.post("/api/invest/orders", { symbol: "NVDA", notionalUsd: 500, payCurrency: "USDT", clientRequestId: randomUUID(), simulated: true });
  eq(o.status, 201, "order");
  const p = await c.get("/api/portfolio");
  const pos = p.json.portfolio.positions.find((x) => x.symbol === "NVDA");
  assert(pos && pos.isSimulated && !pos.verified, "simulated, unverified position");
});
await test("simulated order requires explicit acknowledgement", async () => {
  const o = await c.post("/api/invest/orders", { symbol: "NVDA", notionalUsd: 50, payCurrency: "USDT", clientRequestId: randomUUID() });
  eq(o.status, 422, "status");
});
await test("borrow against simulated collateral within LTV", async () => {
  const b = await c.get("/api/borrow");
  const nv = b.json.collateral.find((x) => x.symbol === "NVDA");
  assert(nv && nv.borrowCapacity > 100, "capacity available");
  const tooMuch = await c.post("/api/borrow/loans", { amountUsdt: nv.borrowCapacity + 50, termDays: 90, collateral: [{ symbol: "NVDA", quantity: nv.availableQuantity }], simulated: true });
  eq(tooMuch.status, 422, "over capacity rejected");
  const ok = await c.post("/api/borrow/loans", { amountUsdt: 100, termDays: 90, collateral: [{ symbol: "NVDA", quantity: nv.availableQuantity }], simulated: true });
  eq(ok.status, 201, "loan opened");
  const b2 = await c.get("/api/borrow");
  const loan = b2.json.loans[0];
  loanId = loan.id;
  eq(loan.status, "active", "active");
  eq(b2.json.collateral.find((x) => x.symbol === "NVDA").availableQuantity, 0, "collateral locked");
});
await test("repay in full closes loan and releases collateral", async () => {
  const b = await c.get("/api/borrow");
  const loan = b.json.loans.find((l) => l.id === loanId);
  const r = await c.post(`/api/borrow/loans/${loanId}/repay`, { amountUsdt: Math.ceil(loan.outstanding * 100) / 100, simulated: true });
  eq(r.json.closed, true, "closed");
  const b2 = await c.get("/api/borrow");
  assert(b2.json.collateral.find((x) => x.symbol === "NVDA").availableQuantity > 0, "collateral released");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
