import "server-only";
import type { BillerDTO, CountryServices, OperatorDTO, OperatorProduct } from "@/lib/shared/types";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { countryByCode } from "@/lib/shared/countries";
import { networkFromName, networkFromNumber } from "./networks";
import { config, testOverride } from "../config";
import { AppError } from "../http";
import { errorMessage, log } from "../log";
import { normalisePhone, ProviderError, roundUpCents, type PriceInput, type Priced, type ProviderOrder, type ProviderOutcome, type UtilityProvider } from "./provider";

/**
 * Flutterwave Bills (v3) behind the utility-provider interface.
 *
 * Endpoints, from Flutterwave's official SDKs (Flutterwave/Node-v3, Flutterwave/PHP-v3):
 *   GET  /v3/bill-categories?country=XX&airtime=1 | data_bundle=1 | power=1   catalogue
 *   GET  /v3/bill-items/{item_code}/validate?code={biller_code}&customer=…     customer/meter check
 *   POST /v3/billers/{biller_code}/items/{item_code}/payment                    pay {country, customer_id, amount, reference}
 *   GET  /v3/bills/{reference}?verbose=1                                        status
 *   GET  /v3/transfers/rates?amount=&destination_currency=&source_currency=USD  FX (USD needed for a local amount)
 *
 * Bills are priced and charged in local currency from the Flutterwave balance. AuraPay
 * prices them in USD with Flutterwave's own rate for the exact amount. `reference` is the
 * AuraPay order ref, which Flutterwave rejects if reused. Test keys (FLWSECK_TEST-…) run
 * in test mode: nothing is delivered and orders are labelled TEST.
 */

interface FlwResponse<T> {
  status: "success" | "error" | string;
  message?: string;
  data: T;
}

interface FlwItem {
  id: number;
  biller_code: string;
  name: string;
  country: string;
  is_airtime?: boolean;
  biller_name?: string;
  item_code: string;
  short_name?: string;
  fee?: number;
  label_name?: string;
  amount?: number;
  validity_period?: string | number | null;
}

class FlwError extends Error {
  constructor(public readonly status: number, message: string, public readonly outcomeUnknown = false) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function base(): string {
  return (testOverride("FLUTTERWAVE_URL_OVERRIDE") ?? "https://api.flutterwave.com").replace(/\/$/, "") + "/v3";
}

async function flw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<FlwResponse<T>> {
  const key = config.flutterwave.secretKey;
  if (!key) throw new ProviderError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
  const isRead = method === "GET";
  for (let attempt = 0; attempt < (isRead ? 3 : 1); attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(isRead ? 15_000 : 45_000),
        cache: "no-store",
      });
    } catch (err) {
      if (!isRead) throw new FlwError(0, "Network error talking to Flutterwave.", true);
      if (attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new FlwError(0, `Network error talking to Flutterwave: ${errorMessage(err)}`);
    }
    if (isRead && (res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    const text = await res.text().catch(() => "");
    let json: FlwResponse<T> | null = null;
    try {
      json = text ? (JSON.parse(text) as FlwResponse<T>) : null;
    } catch {}
    if (!res.ok || !json || json.status !== "success") {
      const msg = flwMessage(json, text) || `Flutterwave returned HTTP ${res.status}`;
      log.warn("flutterwave.request_failed", { method, path: path.split("?")[0], status: res.status, message: msg, body: text.slice(0, 300) });
      throw new FlwError(res.status, msg, !isRead && (res.status >= 500 || res.status === 0));
    }
    return json;
  }
  throw new FlwError(0, "Flutterwave is not responding. Please try again shortly.");
}

/** Flutterwave puts error text in different places depending on the endpoint. */
function flwMessage(json: unknown, text: string): string {
  const j = json as { message?: unknown; data?: { message?: unknown; response_message?: unknown } | null; error?: { message?: unknown } } | null;
  const candidates = [j?.message, j?.data?.message, j?.data?.response_message, j?.error?.message];
  const found = candidates.find((c) => typeof c === "string" && c.trim()) as string | undefined;
  if (found) return found.trim().slice(0, 200);
  // Plain-text or HTML error pages: keep a short, tag-free snippet.
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain && plain.length < 200 ? plain : "";
}

/** Phone formats Flutterwave accepts vary by endpoint: national (080…), +234…, 234…. */
function phoneFormats(e164Digits: string, cc: string): string[] {
  const parsed = parsePhoneNumberFromString(`+${e164Digits}`, cc as CountryCode);
  const national = parsed ? parsed.formatNational().replace(/[^\d]/g, "") : null;
  return [...new Set([national, `+${e164Digits}`, e164Digits].filter((v): v is string => Boolean(v)))];
}

function toProviderError(err: unknown): never {
  if (err instanceof ProviderError || err instanceof AppError) throw err;
  if (err instanceof FlwError) {
    if (err.status === 401) throw new ProviderError("PROVIDER_AUTH_FAILED", "Couldn't authenticate with Flutterwave. Check FLUTTERWAVE_SECRET_KEY.", 502);
    const m = err.message.toLowerCase();
    const friendly = /insufficient|balance/.test(m)
      ? "This service is temporarily unavailable (provider balance is low)."
      : /duplicate|already exist/.test(m)
        ? "This order was already submitted to the provider."
        : err.message;
    throw new ProviderError(/insufficient|balance/.test(m) ? "INSUFFICIENT_BALANCE" : "PROVIDER_ERROR", friendly, err.status === 404 ? 404 : 502, err.outcomeUnknown);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Catalogue (cached 10 minutes per country/category)
// ---------------------------------------------------------------------------

type Category = "airtime" | "data_bundle" | "power" | "cable" | "internet";
const g = globalThis as unknown as { __flwCache?: Map<string, { at: number; value: unknown }> };
const cache = (g.__flwCache ??= new Map());

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const k = `${config.flutterwave.mode}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await fn();
  cache.set(k, { at: Date.now(), value });
  return value;
}

async function items(countryCode: string, category: Category): Promise<FlwItem[]> {
  return cached(`items:${countryCode}:${category}`, 10 * 60_000, async () => {
    const r = await flw<FlwItem[]>("GET", `/bill-categories?country=${encodeURIComponent(countryCode)}&${category}=1`);
    return (Array.isArray(r.data) ? r.data : []).filter((i) => !i.country || i.country.toUpperCase() === countryCode);
  });
}

/** USD needed to deliver `localAmount` of `currency` (Flutterwave's rate). */
async function usdFor(localAmount: number, currency: string): Promise<number> {
  const r = await flw<{ rate?: number; source?: { currency: string; amount: number }; destination?: { currency: string; amount: number } }>(
    "GET",
    `/transfers/rates?amount=${encodeURIComponent(String(localAmount))}&destination_currency=${encodeURIComponent(currency)}&source_currency=USD`,
  );
  const usd = Number(r.data?.source?.amount);
  if (!(usd > 0) || r.data?.source?.currency?.toUpperCase() !== "USD") throw new ProviderError("RATES_UNAVAILABLE", "Couldn't get an exchange rate from the provider.", 503);
  return usd;
}

/** Local currency units per 1 USD, for display (cached). */
async function fxPerUsd(currency: string): Promise<number | null> {
  try {
    return await cached(`fx:${currency}`, 10 * 60_000, async () => {
      const sample = 1000;
      return sample / (await usdFor(sample, currency));
    });
  } catch {
    return null;
  }
}

const currencyOf = (cc: string) => countryByCode(cc)?.currency ?? "";

function itemLabel(i: FlwItem): string {
  return (i.short_name || i.biller_name || i.name || i.biller_code).trim();
}

/** Airtime operators: one per biller/item pair (variable amount in local currency). */
async function airtimeOperators(cc: string): Promise<OperatorDTO[]> {
  const list = (await items(cc, "airtime")).filter((i) => i.is_airtime !== false);
  const groups = new Map<string, FlwItem[]>();
  for (const i of list) groups.set(`${i.biller_code}:${i.item_code}`, [...(groups.get(`${i.biller_code}:${i.item_code}`) ?? []), i]);
  const fx = await fxPerUsd(currencyOf(cc));
  return [...groups.entries()].map(([code, group]) => {
    const names = [...new Set(group.map(itemLabel))];
    const nets = [...new Set(group.map((i) => networkFromName(`${i.biller_name ?? ""} ${i.name ?? ""} ${i.short_name ?? ""}`)).filter(Boolean))];
    return {
      code,
      // A network name where recognisable; Flutterwave's generic "AIRTIME" item serves every network.
      name: nets.length === 1 ? (nets[0] as string) : names.length === 1 && !/^airtime$/i.test(names[0]) ? names[0] : "All networks",
      logoUrl: null,
      isData: false,
      isBundle: false,
      denominationType: "RANGE" as const,
      supportsLocalAmounts: true,
      senderCurrency: "USD",
      localCurrency: currencyOf(cc),
      localCurrencySymbol: null,
      fxRate: fx,
      minAmount: null,
      maxAmount: null,
      localMinAmount: null,
      localMaxAmount: null,
      products: [],
      suggestedAmounts: [],
    };
  });
}

/** Data operators: bundles grouped by biller; each bundle is a fixed-price product. */
async function dataOperators(cc: string): Promise<OperatorDTO[]> {
  const list = (await items(cc, "data_bundle")).filter((i) => Number(i.amount) > 0);
  const fx = await fxPerUsd(currencyOf(cc));
  const groups = new Map<string, FlwItem[]>();
  for (const i of list) groups.set(i.biller_code, [...(groups.get(i.biller_code) ?? []), i]);
  return [...groups.entries()].map(([billerCode, group]) => {
    const products: OperatorProduct[] = group
      .sort((a, b) => Number(a.amount) - Number(b.amount))
      .map((i) => ({
        code: i.item_code,
        localAmount: Number(i.amount),
        senderAmount: fx ? roundUpCents(Number(i.amount) / fx) : 0,
        description: `${i.name}${i.validity_period ? ` · ${i.validity_period} days` : ""}`,
      }));
    // Flutterwave names each bundle (e.g. "MTN 100 MB DATA"); name the group by its network.
    const net = group.map((i) => networkFromName(`${i.biller_name ?? ""} ${i.name ?? ""} ${i.short_name ?? ""}`)).find(Boolean);
    const label = net ?? ((group[0].biller_name || group[0].short_name || billerCode).replace(/\s*\d.*$/i, "").replace(/\s*data.*$/i, "").trim() || billerCode);
    return {
      code: billerCode,
      name: `${label} Data`,
      logoUrl: null,
      isData: true,
      isBundle: false,
      denominationType: "FIXED" as const,
      supportsLocalAmounts: false,
      senderCurrency: "USD",
      localCurrency: currencyOf(cc),
      localCurrencySymbol: null,
      fxRate: fx,
      minAmount: null,
      maxAmount: null,
      localMinAmount: null,
      localMaxAmount: null,
      products,
      suggestedAmounts: [],
    };
  });
}

async function powerBillers(cc: string): Promise<BillerDTO[]> {
  const list = await items(cc, "power");
  const fx = await fxPerUsd(currencyOf(cc));
  return list.map((i) => ({
    products: [],
    code: `${i.biller_code}:${i.item_code}`,
    name: i.name || i.biller_name || i.biller_code,
    countryCode: cc,
    type: "ELECTRICITY_BILL_PAYMENT",
    serviceType: /postpaid/i.test(`${i.name} ${i.biller_name ?? ""}`) ? "POSTPAID" : "PREPAID",
    localCurrency: currencyOf(cc),
    localAmountSupported: true,
    minLocalAmount: null,
    maxLocalAmount: null,
    localFee: i.fee ? Number(i.fee) : null,
    senderCurrency: "USD",
    minSenderAmount: null,
    maxSenderAmount: null,
    fxRate: fx,
  }));
}

function emptyOperator(cc: string): OperatorDTO {
  return {
    code: "",
    name: "",
    logoUrl: null,
    isData: false,
    isBundle: false,
    denominationType: "RANGE",
    supportsLocalAmounts: true,
    senderCurrency: "USD",
    localCurrency: currencyOf(cc),
    localCurrencySymbol: null,
    fxRate: null,
    minAmount: null,
    maxAmount: null,
    localMinAmount: null,
    localMaxAmount: null,
    products: [],
    suggestedAmounts: [],
  };
}

/** The provider name shared by a group of packages (e.g. "DSTV" for "DStv Padi", "DStv Compact"). */
function groupName(group: FlwItem[], fallback: string): string {
  const names = [...new Set(group.map((i) => (i.biller_name || "").trim()).filter(Boolean))];
  if (names.length === 1) return names[0];
  const first = (group[0].biller_name || group[0].short_name || group[0].name || fallback).trim().split(/\s+/)[0];
  return first || fallback;
}

/** Cable TV / internet: billers (by biller code) with their fixed-price packages. */
async function packageBillers(cc: string, category: "cable" | "internet"): Promise<BillerDTO[]> {
  const list = (await items(cc, category)).filter((i) => Number(i.amount) > 0);
  const fx = await fxPerUsd(currencyOf(cc));
  const groups = new Map<string, FlwItem[]>();
  for (const i of list) groups.set(i.biller_code, [...(groups.get(i.biller_code) ?? []), i]);
  return [...groups.entries()].map(([billerCode, group]) => ({
    code: billerCode,
    name: groupName(group, billerCode),
    countryCode: cc,
    type: category === "cable" ? "CABLE_TV" : "INTERNET",
    serviceType: "PREPAID",
    localCurrency: currencyOf(cc),
    localAmountSupported: true,
    minLocalAmount: null,
    maxLocalAmount: null,
    localFee: group[0].fee ? Number(group[0].fee) : null,
    senderCurrency: "USD",
    minSenderAmount: null,
    maxSenderAmount: null,
    fxRate: fx,
    products: group
      .sort((a, b) => Number(a.amount) - Number(b.amount))
      .map((i) => ({
        code: i.item_code,
        localAmount: Number(i.amount),
        senderAmount: fx ? roundUpCents(Number(i.amount) / fx) : 0,
        description: `${i.name}${i.validity_period ? ` · ${i.validity_period} days` : ""}`,
      })),
  }));
}

// ---------------------------------------------------------------------------
// Validation, pricing, submission
// ---------------------------------------------------------------------------

interface ValidateData {
  response_code?: string;
  response_message?: string;
  name?: string | null;
  customer?: string;
  fee?: number;
  minimum?: number;
  maximum?: number;
}

/** Flutterwave customer check (phone for airtime/data, meter/account for electricity). */
async function validateCustomer(billerCode: string, itemCode: string, customer: string): Promise<ValidateData> {
  try {
    const r = await flw<ValidateData>("GET", `/bill-items/${encodeURIComponent(itemCode)}/validate?code=${encodeURIComponent(billerCode)}&customer=${encodeURIComponent(customer)}`);
    const d = r.data ?? {};
    if (d.response_code && d.response_code !== "00") {
      throw new AppError("CUSTOMER_INVALID", d.response_message || "The provider couldn't verify this customer.", 422);
    }
    return d;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof FlwError && err.status >= 400 && err.status < 500) {
      throw new AppError("CUSTOMER_INVALID", err.message || "The provider couldn't verify this customer.", 422);
    }
    return toProviderError(err);
  }
}

/**
 * Phone check for airtime. The number is already validated locally (libphonenumber), so a
 * provider-side validation problem is not fatal: we try each accepted format and otherwise
 * proceed without provider limits.
 */
async function validatePhone(billerCode: string, itemCode: string, e164Digits: string, cc: string): Promise<ValidateData> {
  for (const customer of phoneFormats(e164Digits, cc)) {
    try {
      return await validateCustomer(billerCode, itemCode, customer);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      log.warn("flutterwave.phone_validate_failed", { billerCode, itemCode, format: customer.startsWith("+") ? "+intl" : customer.startsWith("0") ? "national" : "intl", message: err.message });
    }
  }
  return {};
}

function splitCode(code: string): [string, string] {
  const [biller, item] = code.split(":");
  if (!biller || !item) throw new AppError("OPERATOR_NOT_FOUND", "Provider not found.", 404);
  return [biller, item];
}

async function price(input: PriceInput): Promise<Priced> {
  const cc = input.countryCode;
  const currency = currencyOf(cc);
  if (!currency) throw new AppError("COUNTRY_NOT_SUPPORTED", "Country not supported.", 422);

  if (input.service === "airtime") {
    const op = (await airtimeOperators(cc)).find((o) => o.code === input.operatorCode);
    if (!op) throw new AppError("OPERATOR_NOT_FOUND", "This operator isn't available.", 404);
    if (input.amountCurrency !== "local") throw new AppError("INVALID_AMOUNT_CURRENCY", `Enter the amount in ${currency}.`, 422);
    const recipient = normalisePhone(input.recipient, cc);
    const [biller, item] = splitCode(op.code);
    const v = await validatePhone(biller, item, recipient, cc);
    if (v.minimum && input.amount < v.minimum) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${v.minimum} ${currency}.`, 422);
    if (v.maximum && input.amount > v.maximum) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${v.maximum} ${currency}.`, 422);
    const cost = roundUpCents(await usdFor(input.amount + Number(v.fee ?? 0), currency));
    return { operatorName: op.name, operatorCode: op.code, itemCode: item, productDescription: null, amountLocal: input.amount, localCurrency: currency, amountSender: cost, senderCurrency: "USD", useLocalAmount: true, providerCostUsd: cost, recipient };
  }

  if (input.service === "data") {
    const op = (await dataOperators(cc)).find((o) => o.code === input.operatorCode);
    const product = op?.products.find((p) => p.code === input.productCode);
    if (!op || !product || product.localAmount === null) throw new AppError("INVALID_PRODUCT", "Select one of the available bundles.", 422);
    const recipient = normalisePhone(input.recipient, cc);
    const raw = (await items(cc, "data_bundle")).find((i) => i.item_code === product.code && i.biller_code === op.code);
    const cost = roundUpCents(await usdFor(product.localAmount + Number(raw?.fee ?? 0), currency));
    return { operatorName: op.name, operatorCode: op.code, itemCode: product.code, productDescription: product.description, amountLocal: product.localAmount, localCurrency: currency, amountSender: cost, senderCurrency: "USD", useLocalAmount: true, providerCostUsd: cost, recipient };
  }

  if (input.service === "cable" || input.service === "internet") {
    const biller = (await packageBillers(cc, input.service)).find((b) => b.code === input.operatorCode);
    const product = biller?.products.find((p) => p.code === input.productCode);
    if (!biller || !product || product.localAmount === null) throw new AppError("INVALID_PRODUCT", "Select one of the available packages.", 422);
    const account = input.recipient.replace(/[\s-]/g, "");
    if (!/^[0-9A-Za-z]{5,24}$/.test(account)) {
      throw new AppError("INVALID_ACCOUNT", input.service === "cable" ? "Enter a valid smartcard / IUC number." : "Enter a valid account number.", 422);
    }
    // The account is checked with the provider; the customer name is shown so the user can confirm.
    const v = await validateCustomer(biller.code, product.code, account);
    const fee = Number(v.fee ?? biller.localFee ?? 0);
    const cost = roundUpCents(await usdFor(product.localAmount + fee, currency));
    const customerName = v.name && v.name.trim() ? v.name.trim() : null;
    return {
      operatorName: biller.name,
      operatorCode: biller.code,
      itemCode: product.code,
      productDescription: `${product.description ?? "Package"}${customerName ? ` · ${customerName}` : ""}${fee ? ` · incl. fee ${fee} ${currency}` : ""}`,
      amountLocal: product.localAmount,
      localCurrency: currency,
      amountSender: cost,
      senderCurrency: "USD",
      useLocalAmount: true,
      providerCostUsd: cost,
      recipient: account,
    };
  }

  // Electricity
  const biller = (await powerBillers(cc)).find((b) => b.code === input.operatorCode);
  if (!biller) throw new AppError("BILLER_NOT_FOUND", "Electricity provider not found.", 404);
  const meter = input.recipient.replace(/[\s-]/g, "");
  if (!/^[0-9A-Za-z]{6,24}$/.test(meter)) throw new AppError("INVALID_METER", "Enter a valid meter or account number.", 422);
  if (input.amountCurrency !== "local") throw new AppError("INVALID_AMOUNT_CURRENCY", `Enter the amount in ${currency}.`, 422);
  const [billerCode, itemCode] = splitCode(biller.code);
  const v = await validateCustomer(billerCode, itemCode, meter);
  if (v.minimum && input.amount < v.minimum) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${v.minimum} ${currency}.`, 422);
  if (v.maximum && input.amount > v.maximum) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${v.maximum} ${currency}.`, 422);
  const fee = Number(v.fee ?? biller.localFee ?? 0);
  const cost = roundUpCents(await usdFor(input.amount + fee, currency));
  const customerName = v.name && v.name.trim() ? v.name.trim() : null;
  return {
    operatorName: biller.name,
    operatorCode: biller.code,
    itemCode,
    productDescription: `${biller.serviceType === "POSTPAID" ? "Postpaid" : "Prepaid"} electricity${customerName ? ` · ${customerName}` : ""}${fee ? ` · incl. fee ${fee} ${currency}` : ""}`,
    amountLocal: input.amount,
    localCurrency: currency,
    amountSender: cost,
    senderCurrency: "USD",
    useLocalAmount: true,
    providerCostUsd: cost,
    recipient: meter,
  };
}

interface PayData {
  phone_number?: string;
  amount?: number;
  network?: string;
  code?: string;
  tx_ref?: string;
  flw_ref?: string;
  reference?: string | null;
  status?: string;
  recharge_token?: string | null;
  token?: string | null;
  extra?: unknown;
}

function deliveryFrom(d: PayData | undefined): Record<string, unknown> {
  const extra = d?.extra;
  const tokenFromExtra = typeof extra === "string" ? extra : extra && typeof extra === "object" ? ((extra as Record<string, unknown>).token as string | undefined) : undefined;
  const token = d?.recharge_token || d?.token || tokenFromExtra || null;
  return { token, network: d?.network ?? null, flwRef: d?.flw_ref ?? null, txRef: d?.tx_ref ?? null };
}

function statusOf(raw: string | undefined): "successful" | "provider_pending" | "requires_review" | null {
  const s = (raw ?? "").toLowerCase();
  if (!s) return null;
  if (["success", "successful", "completed"].includes(s)) return "successful";
  if (["pending", "processing", "new"].includes(s)) return "provider_pending";
  if (["failed", "error", "reversed", "cancelled"].includes(s)) return "requires_review";
  return "provider_pending";
}

export function flutterwaveProvider(): UtilityProvider {
  return {
    id: "flutterwave",
    label: "Flutterwave",
    environment: config.flutterwave.mode,

    async countryServices(cc: string): Promise<CountryServices> {
      try {
        // Cable/internet failures don't hide the core services.
        const [a, d, p, tv, net] = await Promise.all([
          items(cc, "airtime"),
          items(cc, "data_bundle"),
          items(cc, "power"),
          items(cc, "cable").catch(() => [] as FlwItem[]),
          items(cc, "internet").catch(() => [] as FlwItem[]),
        ]);
        const dataCount = d.filter((i) => Number(i.amount) > 0).length;
        const tvCount = tv.filter((i) => Number(i.amount) > 0).length;
        const netCount = net.filter((i) => Number(i.amount) > 0).length;
        return {
          countryCode: cc,
          airtime: a.length > 0,
          data: dataCount > 0,
          electricity: p.length > 0,
          cable: tvCount > 0,
          internet: netCount > 0,
          operatorCount: a.length + dataCount,
          billerCount: p.length + tvCount + netCount,
        };
      } catch (err) {
        return toProviderError(err);
      }
    },
    operators: (cc, service) => (service === "data" ? dataOperators(cc) : airtimeOperators(cc)).catch(toProviderError),
    // Flutterwave has no lookup by number, so the network comes from the number prefix
    // (a suggestion: ported numbers can be changed by the user).
    async detectOperator(e164: string, cc: string): Promise<OperatorDTO | null> {
      const dial = countryByCode(cc)?.dialCode;
      const net = dial ? networkFromNumber(e164, cc, dial) : null;
      if (!net) return null;
      const airtime = await airtimeOperators(cc).catch(() => [] as OperatorDTO[]);
      const match = airtime.find((o) => networkFromName(o.name) === net);
      return match ?? { ...emptyOperator(cc), code: "", name: net };
    },
    fxPerUsd: (currency) => fxPerUsd(currency),
    billers: (cc, service) => (service === "electricity" ? powerBillers(cc) : packageBillers(cc, service)).catch(toProviderError),
    price: (input) => price(input).catch(toProviderError),

    async submit(order: ProviderOrder): Promise<ProviderOutcome> {
      const [billerCode, itemCode] = order.service === "electricity" ? splitCode(order.operatorCode) : [order.operatorCode.split(":")[0], order.itemCode ?? order.operatorCode.split(":")[1]];
      if (!billerCode || !itemCode) throw new ProviderError("PROVIDER_ERROR", "Order is missing provider codes.", 500);
      try {
        const pay = (customerId: string) =>
          flw<PayData>("POST", `/billers/${encodeURIComponent(billerCode)}/items/${encodeURIComponent(itemCode)}/payment`, {
            country: order.countryCode,
            customer_id: customerId,
            amount: order.amountLocal,
            reference: order.ref,
          });
        let r: FlwResponse<PayData> | null = null;
        // Meter / smartcard / account numbers are sent as entered; phone numbers try accepted formats.
        if (order.service === "electricity" || order.service === "cable" || order.service === "internet") r = await pay(order.recipient);
        else {
          const formats = [`+${order.recipient}`, ...phoneFormats(order.recipient, order.countryCode).filter((f) => f !== `+${order.recipient}`)];
          for (let i = 0; i < formats.length && !r; i++) {
            try {
              r = await pay(formats[i]);
            } catch (err) {
              // Only a definite 4xx about the customer is retried with the next format: nothing was charged.
              const retryable = err instanceof FlwError && err.status >= 400 && err.status < 500 && !err.outcomeUnknown && !/duplicate|already|insufficient|balance/i.test(err.message);
              if (!retryable || i === formats.length - 1) throw err;
              log.warn("flutterwave.pay_format_retry", { ref: order.ref, status: err.status, message: err.message });
            }
          }
        }
        if (!r) throw new FlwError(0, "No response from Flutterwave.");
        const d = r.data;
        const next = statusOf(d?.status) ?? "successful";
        return {
          next,
          providerTransactionId: d?.flw_ref || d?.tx_ref || order.ref,
          providerStatus: d?.status ?? r.message ?? "success",
          providerResponse: r,
          deliveryDetails: deliveryFrom(d),
          reason: next === "requires_review" ? `Provider reported ${d?.status}. Refund required.` : null,
        };
      } catch (err) {
        return toProviderError(err);
      }
    },

    async poll(order: ProviderOrder): Promise<ProviderOutcome> {
      try {
        const r = await flw<PayData & { product?: string }>("GET", `/bills/${encodeURIComponent(order.ref)}?verbose=1`);
        const next = statusOf(r.data?.status);
        if (next === "successful" || (!r.data?.status && r.data)) {
          return { next: "successful", providerStatus: r.data?.status ?? "success", providerResponse: r, deliveryDetails: deliveryFrom(r.data) };
        }
        if (next === "requires_review") return { next, providerStatus: r.data?.status ?? "failed", providerResponse: r, reason: `Provider reported ${r.data?.status}. Refund required.` };
        return { next: "unchanged", providerStatus: r.data?.status ?? "pending" };
      } catch (err) {
        if (err instanceof FlwError && err.status === 404) return { next: "unchanged", providerStatus: "pending" };
        return toProviderError(err);
      }
    },
  };
}
