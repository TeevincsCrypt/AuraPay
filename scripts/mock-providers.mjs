#!/usr/bin/env node
/**
 * TEST-ONLY mock of AuraPay's external providers, shaped after their public specs:
 *   /auth/oauth/token            Reloadly OAuth (client credentials)
 *   /airtime/...                 Reloadly Airtime API (operators, auto-detect, topups, status)
 *   /utilities/...               Reloadly Utility Payments API (billers, pay, transactions)
 *   /flw/v3/...                  Flutterwave v3 Bills (bill-categories, validate, payment, status, rates)
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
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";

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

// ---- Polygon DeFi state (Aave V3 Pool, aPolUSDT, QuickSwap V2) for eth_call
const P = {
  USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  AUSDT: "0x6ab707aca953edaefbc4fd23ba73294241490620",
  POOL: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  ROUTER: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
  FACTORY: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  NIM: "0x4e494d0000000000000000000000000000000001", // NIM on Polygon (test token, 5 decimals)
  PAIR: "0x4e494d0000000000000000000000000000000002",
};
const defi = {
  bal: new Map(), // `${token}:${owner}` -> bigint
  allowance: new Map(), // `${token}:${owner}:${spender}` -> bigint
  pol: 2n * 10n ** 18n,
  liquidityRateRay: 36_800_000_000_000_000_000_000_000n, // 3.68% APR ≈ 3.75% APY
  reserves: { nim: 50_000_000n * 100_000n, usdt: 60_000n * 1_000_000n }, // 50M NIM / 60k USDT
};
const DEFI_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function factory() view returns (address)",
  "function getPair(address tokenA, address tokenB) view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);
function polygonCall(to, data) {
  to = String(to).toLowerCase();
  const { functionName: fn, args = [] } = decodeFunctionData({ abi: DEFI_ABI, data });
  const r = (result) => encodeFunctionResult({ abi: DEFI_ABI, functionName: fn, result });
  const a = (x) => String(x).toLowerCase();
  if (fn === "balanceOf") {
    const dflt = to === P.USDT ? 25_500_000n : to === P.NIM ? 10_000n * 100_000n : 0n;
    return r(defi.bal.get(`${to}:${a(args[0])}`) ?? dflt);
  }
  if (fn === "allowance") return r(defi.allowance.get(`${to}:${a(args[0])}:${a(args[1])}`) ?? 0n);
  if (fn === "decimals") return r(to === P.NIM ? 5 : 6);
  if (fn === "getReserveData") return r({ configuration: 0n, liquidityIndex: 10n ** 27n, currentLiquidityRate: defi.liquidityRateRay, variableBorrowIndex: 10n ** 27n, currentVariableBorrowRate: 0n, currentStableBorrowRate: 0n, lastUpdateTimestamp: 0, id: 1, aTokenAddress: P.AUSDT, stableDebtTokenAddress: P.AUSDT, variableDebtTokenAddress: P.AUSDT, interestRateStrategyAddress: P.AUSDT, accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n });
  if (fn === "factory") return r(P.FACTORY);
  if (fn === "getPair") return r([a(args[0]), a(args[1])].sort().join() === [P.NIM, P.USDT].sort().join() ? P.PAIR : "0x0000000000000000000000000000000000000000");
  if (fn === "token0") return r(P.NIM);
  if (fn === "getReserves") return r([defi.reserves.nim, defi.reserves.usdt, 0]);
  if (fn === "getAmountsOut") {
    const [amountIn, path] = args;
    const nimIn = a(path[0]) === P.NIM;
    const rin = nimIn ? defi.reserves.nim : defi.reserves.usdt, rout = nimIn ? defi.reserves.usdt : defi.reserves.nim;
    const inFee = amountIn * 997n;
    return r([amountIn, (inFee * rout) / (rin * 1000n + inFee)]);
  }
  throw new Error("unsupported call " + fn);
}
let nextTopup = 9000;
let nextBill = 500;
let polygonHead = 60_000_000;
const counters = { topupCalls: 0, payCalls: 0, tokenCalls: 0 };

// ---- Flutterwave v3 Bills fixtures
const FLW_RATES = { NGN: 1500, GHS: 15, KES: 130 };
const FLW_ITEMS = {
  NG: {
    airtime: [
      { id: 1, biller_code: "BIL099", name: "MTN NIGERIA", default_commission: 0.03, country: "NG", is_airtime: true, biller_name: "AIRTIME", item_code: "AT099", short_name: "MTN NIGERIA", fee: 0, label_name: "Mobile Number", amount: 0 },
      // Live Flutterwave also lists other networks under the generic BIL099/AT099 item, so it reads
      // as "All networks" and MTN has no biller of its own.
      { id: 3, biller_code: "BIL099", name: "AIRTEL NIGERIA", default_commission: 0.03, country: "NG", is_airtime: true, biller_name: "AIRTIME", item_code: "AT099", short_name: "AIRTEL NIGERIA", fee: 0, label_name: "Mobile Number", amount: 0 },
      { id: 2, biller_code: "BIL102", name: "GLO NIGERIA", default_commission: 0.03, country: "NG", is_airtime: true, biller_name: "AIRTIME", item_code: "AT102", short_name: "GLO NIGERIA", fee: 0, label_name: "Mobile Number", amount: 0 },
    ],
    data_bundle: [
      { id: 10, biller_code: "BIL108", name: "1.5GB", country: "NG", is_airtime: false, biller_name: "MTN 1.5GB DATA", item_code: "MD136", short_name: "MTN 1.5GB", fee: 0, label_name: "Mobile Number", amount: 1000, validity_period: 30 },
      { id: 12, biller_code: "BIL110", name: "AIRTEL 40 MB Data", country: "NG", is_airtime: false, biller_name: "AIRTEL 40 MB Data", item_code: "MD301", short_name: "AIRTEL 40MB", fee: 0, label_name: "Mobile Number", amount: 50, validity_period: 1 },
      { id: 11, biller_code: "BIL108", name: "3GB", country: "NG", is_airtime: false, biller_name: "MTN 3GB DATA", item_code: "MD138", short_name: "MTN 3GB", fee: 0, label_name: "Mobile Number", amount: 2000, validity_period: 30 },
    ],
    cable: [
      { id: 40, biller_code: "BIL121", name: "DStv Padi", country: "NG", is_airtime: false, biller_name: "DSTV", item_code: "CB141", short_name: "DStv Padi", fee: 0, label_name: "SmartCard Number", amount: 4400, validity_period: 30 },
      { id: 41, biller_code: "BIL121", name: "DStv Compact", country: "NG", is_airtime: false, biller_name: "DSTV", item_code: "CB177", short_name: "DStv Compact", fee: 0, label_name: "SmartCard Number", amount: 19000, validity_period: 30 },
      { id: 42, biller_code: "BIL122", name: "GOtv Jolli", country: "NG", is_airtime: false, biller_name: "GOTV", item_code: "CB144", short_name: "GOtv Jolli", fee: 0, label_name: "IUC Number", amount: 4850, validity_period: 30 },
    ],
    internet: [
      { id: 50, biller_code: "BIL124", name: "Spectranet 10GB", country: "NG", is_airtime: false, biller_name: "SPECTRANET", item_code: "IN201", short_name: "Spectranet 10GB", fee: 0, label_name: "Account Number", amount: 7000, validity_period: 30 },
    ],
    power: [
      { id: 20, biller_code: "BIL113", name: "IKEDC  PREPAID", country: "NG", is_airtime: false, biller_name: "IKEDC  PREPAID", item_code: "UB157", short_name: "IKEDC PREPAID", fee: 100, label_name: "Meter Number", amount: 0 },
    ],
  },
  GH: {
    airtime: [{ id: 30, biller_code: "BIL132", name: "MTN Ghana", country: "GH", is_airtime: true, biller_name: "AIRTIME", item_code: "AT132", short_name: "MTN GH", fee: 0, label_name: "Mobile Number", amount: 0 }],
    data_bundle: [],
    power: [],
    cable: [],
    internet: [],
  },
};
const flwBills = new Map(); // reference -> { body, created, billerCode, itemCode }
const flwOk = (res, data, message = "success") => send(res, 200, { status: "success", message, data });
const flwErr = (res, status, message) => send(res, status, { status: "error", message, data: null });

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

// ---------------------------------------------------------------------------
// EVM state: ERC-20 balances, an Aave V4 MAG7-like spoke, CoW orders, receipts
// ---------------------------------------------------------------------------
const HUB = "0xa4d5947eb727a052bae69c593ffc84247ec9864e";
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const erc20 = new Map();
const cowOrders = new Map();
const evmTxs = new Map();
let aavePosition = { supplied: 0n, debt: 0n, collateral: false };
const SYMBOLS = { [NVDAC]: "NVDAc", [USDC]: "USDC" };

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256) view returns ((address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey))",
  "function getReserveConfig(uint256) view returns ((uint24 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled))",
  "function getDynamicReserveConfig(uint256, uint32) view returns ((uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee))",
  "function getUserAccountData(address) view returns ((uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))",
  "function getUserSuppliedAssets(uint256, address) view returns (uint256)",
  "function getUserTotalDebt(uint256, address) view returns (uint256)",
  "function getUserReserveStatus(uint256, address) view returns (bool, bool)",
  "function getReservesPrices(uint256[]) view returns (uint256[])",
  "function getAssetDrawnRate(uint256) view returns (uint256)",
]);

function tokenPrice(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 100 + (h % 300);
}

const RESERVES = [
  { underlying: NVDAC, hub: HUB, assetId: 1, decimals: 8, collateralRisk: 0, flags: 0, dynamicConfigKey: 0 },
  { underlying: USDC, hub: HUB, assetId: 0, decimals: 6, collateralRisk: 0, flags: 0, dynamicConfigKey: 0 },
];

function evmCall(chainId, r) {
  if (r.method === "eth_blockNumber") return { result: "0x1000" };
  if (r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionByHash") {
    const t = evmTxs.get(String(r.params[0]).toLowerCase());
    return { result: t ? { status: t.status ?? "0x1", from: t.from, to: t.to, blockNumber: "0xff0" } : null };
  }
  if (r.method !== "eth_call") return { error: { code: -32601, message: "unsupported" } };
  const { to, data } = r.params[0];
  const target = to.toLowerCase();
  let call;
  try {
    call = decodeFunctionData({ abi: ABI, data });
  } catch {
    return { error: { code: 3, message: "execution reverted" } };
  }
  const enc = (result) => ({ result: encodeFunctionResult({ abi: ABI, functionName: call.functionName, result }) });
  const a = call.args ?? [];
  switch (call.functionName) {
    case "balanceOf":
      return enc(erc20.get(`${chainId}:${target}:${String(a[0]).toLowerCase()}`) ?? 0n);
    case "symbol":
      return enc(SYMBOLS[target] ?? "TKN");
    case "getReserveCount":
      return enc(BigInt(RESERVES.length));
    case "getReserve":
      return enc(RESERVES[Number(a[0])]);
    case "getReserveConfig":
      return enc({ collateralRisk: 0, paused: false, frozen: false, borrowable: Number(a[0]) === 1, receiveSharesEnabled: false });
    case "getDynamicReserveConfig":
      return enc({ collateralFactor: Number(a[0]) === 0 ? 5000 : 0, maxLiquidationBonus: 10500, liquidationFee: 1000 });
    case "getReservesPrices":
      return enc(a[0].map((id) => (Number(id) === 0 ? 180_00000000n : 1_00000000n)));
    case "getAssetDrawnRate":
      return enc(55n * 10n ** 24n); // 5.5% in RAY
    case "getUserSuppliedAssets":
      return enc(Number(a[0]) === 0 ? aavePosition.supplied : 0n);
    case "getUserTotalDebt":
      return enc(Number(a[0]) === 1 ? aavePosition.debt : 0n);
    case "getUserReserveStatus":
      return enc([Number(a[0]) === 0 && aavePosition.collateral, Number(a[0]) === 1 && aavePosition.debt > 0n]);
    case "getUserAccountData": {
      const collValue = (aavePosition.supplied * 180n * 10n ** 26n) / 10n ** 8n; // Value units: 1e26 per USD
      const debtValueRay = (aavePosition.debt * 10n ** 26n * 10n ** 27n) / 10n ** 6n;
      const hf = aavePosition.debt > 0n ? (collValue * 5000n * 10n ** 18n * 10n ** 27n) / 10000n / debtValueRay : 2n ** 255n;
      return enc({ riskPremium: 50n, avgCollateralFactor: 5n * 10n ** 17n, healthFactor: hf, totalCollateralValue: collValue, totalDebtValueRay: debtValueRay, activeCollateralCount: 1n, borrowCount: aavePosition.debt > 0n ? 1n : 0n });
    }
    default:
      return { error: { code: 3, message: "execution reverted" } };
  }
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
  if (p === "/_test/evm-balance" && req.method === "POST") {
    erc20.set(`${body.chainId}:${body.token.toLowerCase()}:${body.owner.toLowerCase()}`, BigInt(body.amount));
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/aave-position" && req.method === "POST") {
    aavePosition = {
      supplied: BigInt(body.supplied ?? aavePosition.supplied),
      debt: BigInt(body.debt ?? aavePosition.debt),
      collateral: Boolean(body.collateral ?? aavePosition.collateral),
    };
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/cow-order" && req.method === "POST") {
    cowOrders.set(body.uid.toLowerCase(), body);
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/evm-tx" && req.method === "POST") {
    evmTxs.set(body.hash.toLowerCase(), body);
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/defi" && req.method === "POST") {
    // { balances: [{token, owner, units}], allowances: [{token, owner, spender, units}], pol }
    for (const b of body.balances ?? []) defi.bal.set(`${b.token.toLowerCase()}:${b.owner.toLowerCase()}`, BigInt(b.units));
    for (const x of body.allowances ?? []) defi.allowance.set(`${x.token.toLowerCase()}:${x.owner.toLowerCase()}:${x.spender.toLowerCase()}`, BigInt(x.units));
    if (body.pol !== undefined) defi.pol = BigInt(body.pol);
    return send(res, 200, { ok: true });
  }
  if (p === "/_test/counters") return send(res, 200, { ...counters, topupsByCustomId: Object.fromEntries([...customIds.entries()]) });
  if (p === "/_test/fail-next-topup" && req.method === "POST") {
    failNextTopup = body.errorCode ?? "INSUFFICIENT_BALANCE";
    return send(res, 200, { ok: true });
  }

  // ---- Flutterwave v3
  if (p.startsWith("/flw/v3/")) {
    if (!/^Bearer FLWSECK(_TEST)?-/.test(req.headers.authorization ?? "")) return flwErr(res, 401, "Invalid authorization key");
    const sub = p.slice("/flw/v3".length);
    let m;
    if (sub === "/bill-categories") {
      // FLW_CATALOG_DELAY_MS simulates Flutterwave's slow test-mode catalogue.
      await new Promise((r) => setTimeout(r, Number(process.env.FLW_CATALOG_DELAY_MS ?? 0)));
      const cc = url.searchParams.get("country") ?? "NG";
      const cats = ["airtime", "data_bundle", "power", "cable", "internet"];
      const cat = cats.find((k) => url.searchParams.get(k) === "1");
      const all = FLW_ITEMS[cc] ?? { airtime: [], data_bundle: [], power: [], cable: [], internet: [] };
      return flwOk(res, cat ? all[cat] ?? [] : cats.flatMap((k) => all[k] ?? []), "Bill categories retrieved");
    }
    if (sub === "/transfers/rates") {
      const amount = Number(url.searchParams.get("amount"));
      const dest = url.searchParams.get("destination_currency");
      const rate = FLW_RATES[dest];
      if (!rate || url.searchParams.get("source_currency") !== "USD") return flwErr(res, 400, "Unsupported currency pair");
      return flwOk(res, { rate: 1 / rate, source: { currency: "USD", amount: Math.round((amount / rate) * 1e6) / 1e6 }, destination: { currency: dest, amount } }, "Transfer amount fetched");
    }
    if ((m = sub.match(/^\/bill-items\/([^/]+)\/validate$/))) {
      const customer = url.searchParams.get("customer") ?? "";
      const item = Object.values(FLW_ITEMS).flatMap((c) => Object.values(c).flat()).find((i) => i.item_code === m[1] && i.biller_code === url.searchParams.get("code"));
      if (!item) return flwErr(res, 400, "Invalid biller code");
      if (["SmartCard Number", "IUC Number", "Account Number"].includes(item.label_name)) {
        if (customer === "00000000") return flwOk(res, { response_code: "RR", response_message: "Invalid smartcard number", name: null, customer });
        return flwOk(res, { response_code: "00", response_message: "Successful", name: "CHIOMA OKAFOR", biller_code: item.biller_code, customer, product_code: item.item_code, fee: 0, maximum: 0, minimum: 0 });
      }
      if (item.label_name === "Meter Number") {
        if (customer === "00000000") return flwOk(res, { response_code: "RR", response_message: "Invalid meter number", name: null, customer });
        return flwOk(res, { response_code: "00", address: null, response_message: "Successful", name: "ADEBAYO TEST", biller_code: item.biller_code, customer, product_code: item.item_code, email: null, fee: 100, maximum: 500000, minimum: 1000 });
      }
      // Like live Flutterwave: phone validation wants the national format (080…) and answers
      // other formats with a 400 that has no top-level message.
      if (!/^0\d{9,10}$/.test(customer)) return send(res, 400, { status: "error", data: { response_message: "Invalid customer number" } });
      return flwOk(res, { response_code: "00", response_message: "Successful", name: null, biller_code: item.biller_code, customer, product_code: item.item_code, fee: 0, maximum: 50000, minimum: 100 });
    }
    if ((m = sub.match(/^\/billers\/([^/]+)\/items\/([^/]+)\/payment$/)) && req.method === "POST") {
      const isPower = m[1] === "BIL113";
      const count = () => (isPower ? counters.payCalls++ : counters.topupCalls++);
      if (failNextTopup) {
        count();
        failNextTopup = null;
        return flwErr(res, 400, "Insufficient wallet balance");
      }
      if (!body.reference || !body.customer_id || !(body.amount > 0) || !body.country) return flwErr(res, 400, "Missing required field");
      // FLW_PAY_NATIONAL_ONLY=1: reject +intl phone formats (exercises AuraPay's format fallback).
      const isPhoneBill = ["BIL099", "BIL102", "BIL108", "BIL110", "BIL132"].includes(m[1]);
      if (process.env.FLW_PAY_NATIONAL_ONLY === "1" && isPhoneBill && !/^0\d+$/.test(body.customer_id)) {
        return send(res, 400, { status: "error", message: "Invalid customer id" });
      }
      if (flwBills.has(body.reference)) return flwErr(res, 400, "Duplicate reference");
      count(); // accepted payments only
      customIds.set(body.reference, (customIds.get(body.reference) ?? 0) + 1);
      flwBills.set(body.reference, { body, created: Date.now(), billerCode: m[1], itemCode: m[2], isPower });
      return flwOk(res, {
        phone_number: body.customer_id, amount: body.amount, network: isPower ? "IKEDC" : "MTN", code: "200",
        tx_ref: `CF-FLYAPI-${Date.now()}`, flw_ref: `BPUSSD${Date.now()}`, reference: body.reference, status: isPower ? "pending" : "success",
      }, "Bill payment successful");
    }
    if ((m = sub.match(/^\/bills\/([^/]+)$/))) {
      const b = flwBills.get(decodeURIComponent(m[1]));
      if (!b) return flwErr(res, 404, "Bill not found");
      const done = !b.isPower || Date.now() - b.created > 2500;
      return flwOk(res, {
        currency: "NGN", customer_id: b.body.customer_id, frequency: "One Time", amount: String(b.body.amount), product: b.isPower ? "IKEDC" : "AIRTIME",
        product_name: b.isPower ? "IKEDC PREPAID" : "MTN", commission: 0, transaction_date: new Date(b.created).toISOString(), country: b.body.country,
        tx_ref: b.body.reference, extra: done && b.isPower ? { token: "1234-5678-9012-3456-7890" } : null, product_details: "FLY-API", status: done ? "successful" : "pending",
      }, "Bill status fetched");
    }
    return flwErr(res, 404, "Not found");
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

  // ---- CoinGecko (any id; stock tokens get a deterministic price)
  if (p === "/coingecko/api/v3/simple/price") {
    const out = {};
    for (const id of (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)) {
      out[id] = id === "nimiq-2" ? { usd: 0.0012, usd_24h_change: 1.5 } : id === "tether" ? { usd: 1.0, usd_24h_change: 0 } : { usd: tokenPrice(id), usd_24h_change: 1.2 };
      // Local currencies (only ones CoinGecko actually supports): distinct from Flutterwave's mock rates.
      const FIAT = { ngn: 1600, zar: 18 };
      for (const v of (url.searchParams.get("vs_currencies") ?? "").split(",")) if (FIAT[v] && out[id].usd) out[id][v] = out[id].usd * FIAT[v];
    }
    return send(res, 200, out);
  }
  if (p.startsWith("/coingecko/api/v3/coins/") && p.endsWith("/market_chart")) {
    const id = p.split("/")[5];
    const now = Date.now();
    return send(res, 200, { prices: Array.from({ length: 30 }, (_, i) => [now - (29 - i) * 86400000, +(tokenPrice(id) * (0.9 + i * 0.004)).toFixed(2)]) });
  }

  // ---- CoW Protocol order book
  let cm;
  if ((cm = p.match(/^\/cow\/([a-z_]+)\/api\/v1\/orders\/(0x[0-9a-fA-F]+)$/))) {
    const o = cowOrders.get(cm[2].toLowerCase());
    return o ? send(res, 200, o) : send(res, 404, { errorType: "NotFound" });
  }

  // ---- Batched EVM JSON-RPC per chain: /evm/<chainId>
  let em;
  if ((em = p.match(/^\/evm\/(\d+)$/)) && req.method === "POST") {
    const chainId = Number(em[1]);
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((r) => {
      try {
        return { jsonrpc: "2.0", id: r.id, ...evmCall(chainId, r) };
      } catch (e) {
        return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: String(e.message) } };
      }
    });
    return send(res, 200, Array.isArray(body) ? out : out[0]);
  }

  // ---- Nimiq RPC
  if (p === "/nimiq" && req.method === "POST") {
    if (body.method === "getBlockNumber") return send(res, 200, { jsonrpc: "2.0", id: body.id, result: { data: 1000, metadata: null } });
    if (body.method === "getAccountByAddress") {
      return send(res, 200, { jsonrpc: "2.0", id: body.id, result: { data: { address: body.params?.[0], balance: 250_000_000, type: "basic" }, metadata: { blockNumber: 1000 } } });
    }
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
    if (body.method === "eth_call") {
      try {
        return ok(polygonCall(body.params[0].to, body.params[0].data));
      } catch (e) {
        return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: 3, message: String(e.message) } });
      }
    }
    if (body.method === "eth_getBalance") return ok(`0x${defi.pol.toString(16)}`);
    if (body.method === "eth_chainId") return ok("0x89");
    return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`mock providers on http://localhost:${PORT}`));
export const POLYGON_HEAD = polygonHead;
