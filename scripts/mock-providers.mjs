#!/usr/bin/env node
/**
 * TEST-ONLY mock of AuraPay's external providers, shaped after their public specs:
 *   /auth/oauth/token            Reloadly OAuth (client credentials)
 *   /airtime/...                 Reloadly Airtime API (operators, auto-detect, topups, status)
 *   /utilities/...               Reloadly Utility Payments API (billers, pay, transactions)
 *   /coingecko/api/v3/...        CoinGecko simple price
 *   /nimiq                       Nimiq Albatross JSON-RPC (getTransactionByHash, getBlockNumber)
 *   /polygon                     Polygon JSON-RPC (receipts, blocks, eth_call)
 *   /_test/...                   Helpers to register fake on-chain payments and read counters
 *
 * Used by scripts/e2e-api.mjs and for offline UI development. Never used in production:
 * the *_URL_OVERRIDE variables are ignored when APP_MODE=production.
 *
 *   node scripts/mock-providers.mjs [port=4010]
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4010);

const OPERATORS = {
  NG: [
    {
      id: 341, operatorId: 341, name: "MTN Nigeria", bundle: false, data: false, pin: false, supportsLocalAmounts: true,
      denominationType: "RANGE", senderCurrencyCode: "USD", destinationCurrencyCode: "NGN", destinationCurrencySymbol: "₦",
      minAmount: 0.07, maxAmount: 40, localMinAmount: 100, localMaxAmount: 60000, country: { isoName: "NG", name: "Nigeria" },
      fx: { rate: 1500, currencyCode: "NGN" }, logoUrls: [], fixedAmounts: [], fixedAmountsDescriptions: [], localFixedAmounts: [],
      localFixedAmountsDescriptions: [], suggestedAmounts: [1, 2, 5, 10], status: "ACTIVE",
    },
    {
      id: 342, operatorId: 342, name: "Airtel Nigeria", bundle: false, data: false, pin: false, supportsLocalAmounts: false,
      denominationType: "RANGE", senderCurrencyCode: "USD", destinationCurrencyCode: "NGN", minAmount: 0.5, maxAmount: 50,
      localMinAmount: null, localMaxAmount: null, country: { isoName: "NG", name: "Nigeria" }, fx: { rate: 1500, currencyCode: "NGN" },
      logoUrls: [], fixedAmounts: [], fixedAmountsDescriptions: [], suggestedAmounts: [1, 3, 5], status: "ACTIVE",
    },
    {
      id: 645, operatorId: 645, name: "MTN Nigeria Data", bundle: false, data: true, pin: false, supportsLocalAmounts: false,
      denominationType: "FIXED", senderCurrencyCode: "USD", destinationCurrencyCode: "NGN", minAmount: null, maxAmount: null,
      country: { isoName: "NG", name: "Nigeria" }, fx: { rate: 1500, currencyCode: "NGN" }, logoUrls: [],
      fixedAmounts: [0.67, 1.34, 3.35], localFixedAmounts: [1000, 2000, 5000],
      fixedAmountsDescriptions: { "0.67": "1.5GB · 30 days", "1.34": "3GB · 30 days", "3.35": "10GB · 30 days" },
      localFixedAmountsDescriptions: [], suggestedAmounts: [], status: "ACTIVE",
    },
  ],
  GH: [
    {
      id: 150, operatorId: 150, name: "MTN Ghana", bundle: false, data: false, pin: false, supportsLocalAmounts: true,
      denominationType: "RANGE", senderCurrencyCode: "USD", destinationCurrencyCode: "GHS", minAmount: 0.1, maxAmount: 50,
      localMinAmount: 1, localMaxAmount: 600, country: { isoName: "GH", name: "Ghana" }, fx: { rate: 12, currencyCode: "GHS" },
      logoUrls: [], fixedAmounts: [], fixedAmountsDescriptions: [], suggestedAmounts: [1, 2, 5], status: "ACTIVE",
    },
  ],
  KE: [
    {
      id: 270, operatorId: 270, name: "Safaricom Kenya", bundle: false, data: false, pin: false, supportsLocalAmounts: true,
      denominationType: "RANGE", senderCurrencyCode: "USD", destinationCurrencyCode: "KES", minAmount: 0.1, maxAmount: 80,
      localMinAmount: 10, localMaxAmount: 10000, country: { isoName: "KE", name: "Kenya" }, fx: { rate: 129, currencyCode: "KES" },
      logoUrls: [], fixedAmounts: [], fixedAmountsDescriptions: [], suggestedAmounts: [1, 2, 5], status: "ACTIVE",
    },
  ],
};

const BILLERS = [
  {
    id: 9, name: "Ikeja Electricity Prepaid", countryIsoCode: "NG", type: "ELECTRICITY_BILL_PAYMENT", serviceType: "PREPAID",
    localAmountSupported: true, localTransactionCurrencyCode: "NGN", minLocalTransactionAmount: 1000, maxLocalTransactionAmount: 300000,
    localTransactionFee: 100, internatonalAmountSupported: true, internationalTransactionCurrencyCode: "USD",
    minInternationalTransactionAmount: 0.67, maxInternationalTransactionAmount: 200, fx: [{ rate: 1500 }, { curencyCode: "NGN" }],
  },
];

// state
const topups = new Map(); // transactionId -> record
const customIds = new Map(); // customIdentifier -> transactionId
const bills = new Map();
const nimTxs = new Map(); // hash -> tx
const polyTxs = new Map(); // hash -> { receipt, timestamp }
let nextTopup = 9000;
let nextBill = 500;
let polygonHead = 60_000_000;
const counters = { topupCalls: 0, payCalls: 0, tokenCalls: 0 };
let failNextTopup = null; // e.g. "INSUFFICIENT_BALANCE"

const err = (res, status, errorCode, message) => send(res, status, { timeStamp: new Date().toISOString(), message, path: "", errorCode, infoLink: null, details: [] });
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

function authed(req) {
  return (req.headers.authorization ?? "").startsWith("Bearer mock-token-");
}

function detect(phone, iso) {
  const ops = OPERATORS[iso] ?? [];
  if (iso === "NG" && /^234(80[36]|81[0346]|70[36]|90[36])/.test(phone)) return ops.find((o) => o.id === 341);
  if (iso === "NG" && /^234(80[28]|70[18]|90[12])/.test(phone)) return ops.find((o) => o.id === 342);
  return ops.find((o) => !o.data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const body = req.method === "POST" ? await readBody(req) : {};

  // ---- test helpers
  if (p === "/_test/nimiq-tx" && req.method === "POST") {
    nimTxs.set(body.hash, body);
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/polygon-tx" && req.method === "POST") {
    polyTxs.set(body.hash.toLowerCase(), body);
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/counters") return send(res, 200, { ...counters, topupsByCustomId: Object.fromEntries([...customIds.entries()]) });
  if (p === "/_test/fail-next-topup" && req.method === "POST") {
    failNextTopup = body.errorCode ?? "INSUFFICIENT_BALANCE";
    return send(res, 200, { ok: true });
  }

  // ---- Reloadly auth
  if (p === "/auth/oauth/token" && req.method === "POST") {
    counters.tokenCalls++;
    if (body.client_id !== "mock-client" || body.client_secret !== "mock-secret") return err(res, 401, "INVALID_CREDENTIALS", "Access Denied");
    return send(res, 200, { access_token: `mock-token-${Date.now()}`, scope: "developer", expires_in: 5184000, token_type: "Bearer" });
  }

  // ---- Reloadly airtime
  if (p.startsWith("/airtime/")) {
    if (!authed(req)) return err(res, 401, "INVALID_TOKEN", "Full authentication is required to access this resource");
    const sub = p.slice("/airtime".length);
    let m;
    if ((m = sub.match(/^\/operators\/countries\/([A-Z]{2})$/))) {
      const ops = OPERATORS[m[1]];
      if (!ops) return err(res, 404, "COUNTRY_NOT_SUPPORTED", "Country not found and/or not currently supported");
      return send(res, 200, ops);
    }
    if ((m = sub.match(/^\/operators\/auto-detect\/phone\/(\d+)\/countries\/([A-Z]{2})$/))) {
      const op = detect(m[1], m[2]);
      return op ? send(res, 200, op) : err(res, 404, "COULD_NOT_AUTO_DETECT_OPERATOR", "Could not detect operator");
    }
    if ((m = sub.match(/^\/operators\/(\d+)$/))) {
      const op = Object.values(OPERATORS).flat().find((o) => o.id === Number(m[1]));
      return op ? send(res, 200, op) : err(res, 404, "OPERATOR_NOT_FOUND", "Operator not found");
    }
    if (sub === "/topups" && req.method === "POST") {
      counters.topupCalls++;
      if (failNextTopup) {
        const code = failNextTopup;
        failNextTopup = null;
        return err(res, 400, code, "Mock failure");
      }
      if (customIds.has(body.customIdentifier)) return err(res, 400, "DUPLICATED_TRANSACTION", "Duplicate customIdentifier");
      const op = Object.values(OPERATORS).flat().find((o) => o.id === Number(body.operatorId));
      if (!op) return err(res, 404, "OPERATOR_NOT_FOUND", "Operator not found");
      if (!/^\d{8,15}$/.test(body.recipientPhone?.number ?? "")) return err(res, 400, "INVALID_RECIPIENT_PHONE", "Recipient phone number is not valid");
      const id = nextTopup++;
      const usd = body.useLocalAmount ? body.amount / op.fx.rate : body.amount;
      const rec = {
        transactionId: id, status: "SUCCESSFUL", operatorTransactionId: `OP-${id}`, customIdentifier: body.customIdentifier,
        recipientPhone: body.recipientPhone.number, countryCode: body.recipientPhone.countryCode, operatorId: op.id, operatorName: op.name,
        requestedAmount: usd, requestedAmountCurrencyCode: "USD", deliveredAmount: +(usd * op.fx.rate).toFixed(2),
        deliveredAmountCurrencyCode: op.destinationCurrencyCode, transactionDate: new Date().toISOString(), pinDetail: null,
      };
      topups.set(id, rec);
      customIds.set(body.customIdentifier, id);
      return send(res, 200, rec);
    }
    if ((m = sub.match(/^\/topups\/(\d+)\/status$/))) {
      const rec = topups.get(Number(m[1]));
      return rec ? send(res, 200, rec) : err(res, 404, null, "No message available");
    }
    if (sub === "/accounts/balance") return send(res, 200, { balance: 1000, currencyCode: "USD", currencyName: "US Dollar" });
    return err(res, 404, null, "No message available");
  }

  // ---- Reloadly utilities
  if (p.startsWith("/utilities/")) {
    if (!authed(req)) return err(res, 401, "INVALID_TOKEN", "Full authentication is required to access this resource");
    const sub = p.slice("/utilities".length);
    let m;
    if (sub === "/billers") {
      let list = BILLERS;
      const id = url.searchParams.get("id");
      const iso = url.searchParams.get("countryISOCode");
      const type = url.searchParams.get("type");
      if (id) list = list.filter((b) => b.id === Number(id));
      if (iso) list = list.filter((b) => b.countryIsoCode === iso);
      if (type) list = list.filter((b) => b.type === type);
      return send(res, 200, { content: list, totalElements: list.length });
    }
    if (sub === "/pay" && req.method === "POST") {
      counters.payCalls++;
      const id = nextBill++;
      bills.set(id, { body, created: Date.now() });
      return send(res, 200, { id, status: "PROCESSING", referenceId: body.referenceId, code: "PAYMENT_PROCESSING_IN_PROGRESS", message: "The payment is being processed, status will be updated when biller processes the payment." });
    }
    if ((m = sub.match(/^\/transactions\/(\d+)$/))) {
      const b = bills.get(Number(m[1]));
      if (!b) return err(res, 404, null, "Not found");
      return send(res, 200, {
        code: "PAYMENT_PROCESSED_SUCCESSFULLY",
        message: "The payment was processed successfully",
        transaction: {
          id: Number(m[1]), status: "SUCCESSFUL", referenceId: b.body.referenceId, amount: b.body.amount, amountCurrencyCode: "NGN",
          billDetails: { type: "ELECTRICITY_BILL_PAYMENT", billerId: b.body.billerId, serviceType: "PREPAID", pinDetails: { token: "1234-5678-9012-3456-7890" }, subscriberDetails: { accountNumber: b.body.subscriberAccountNumber } },
        },
      });
    }
    return err(res, 404, null, "No message available");
  }

  // ---- CoinGecko
  if (p === "/coingecko/api/v3/simple/price") return send(res, 200, { "nimiq-2": { usd: 0.0012 }, tether: { usd: 1.0 } });

  // ---- Nimiq RPC
  if (p === "/nimiq" && req.method === "POST") {
    if (body.method === "getBlockNumber") return send(res, 200, { jsonrpc: "2.0", id: body.id, result: { data: 1000, metadata: null } });
    if (body.method === "getTransactionByHash") {
      const tx = nimTxs.get(body.params?.[0]);
      if (!tx) return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Transaction not found" } });
      return send(res, 200, { jsonrpc: "2.0", id: body.id, result: { data: tx, metadata: null } });
    }
    return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }

  // ---- Polygon RPC
  if (p === "/polygon" && req.method === "POST") {
    const ok = (result) => send(res, 200, { jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_blockNumber") return ok(`0x${polygonHead.toString(16)}`);
    if (body.method === "eth_getTransactionReceipt") {
      const t = polyTxs.get(String(body.params?.[0]).toLowerCase());
      return ok(t ? t.receipt : null);
    }
    if (body.method === "eth_getBlockByNumber") {
      const t = [...polyTxs.values()].find((x) => x.receipt.blockNumber === body.params?.[0]);
      return ok({ number: body.params?.[0], timestamp: `0x${Math.floor((t?.timestamp ?? Date.now()) / 1000).toString(16)}` });
    }
    if (body.method === "eth_call") return ok(`0x${(25_500_000).toString(16).padStart(64, "0")}`); // 25.5 USDT
    return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`mock providers on http://localhost:${PORT}`));
export const POLYGON_HEAD = polygonHead;
