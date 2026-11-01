import "server-only";
import type { BillerDTO, CountryServices, OperatorDTO, OperatorProduct } from "@/lib/shared/types";
import { config } from "../config";
import { reloadlyRequest } from "./client";

/** Raw Reloadly operator shape (subset we rely on). */
export interface RawOperator {
  id?: number;
  operatorId?: number;
  name: string;
  bundle?: boolean;
  data?: boolean;
  pin?: boolean;
  supportsLocalAmounts?: boolean;
  denominationType?: "FIXED" | "RANGE";
  senderCurrencyCode?: string;
  destinationCurrencyCode?: string;
  destinationCurrencySymbol?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  localMinAmount?: number | null;
  localMaxAmount?: number | null;
  fx?: { rate?: number; currencyCode?: string } | null;
  logoUrls?: string[];
  fixedAmounts?: number[];
  fixedAmountsDescriptions?: Record<string, string> | unknown[];
  localFixedAmounts?: number[];
  localFixedAmountsDescriptions?: Record<string, string> | unknown[];
  suggestedAmounts?: number[];
  country?: { isoName?: string; name?: string };
  status?: string;
}

export interface RawBiller {
  id: number;
  name: string;
  countryIsoCode?: string;
  countryCode?: string;
  type: string;
  serviceType: string;
  localAmountSupported?: boolean;
  localTransactionCurrencyCode?: string;
  minLocalTransactionAmount?: number | null;
  maxLocalTransactionAmount?: number | null;
  localTransactionFee?: number | null;
  internationalAmountSupported?: boolean;
  internatonalAmountSupported?: boolean; // sic — spelled this way in Reloadly's spec example
  internationalTransactionCurrencyCode?: string;
  minInternationalTransactionAmount?: number | null;
  maxInternationalTransactionAmount?: number | null;
  fx?: { rate?: number; currencyCode?: string } | { rate?: number; curencyCode?: string }[] | null;
}

// ---------------------------------------------------------------------------
// Small TTL cache for catalogue reads (not for transactions).
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __rlCache?: Map<string, { at: number; value: unknown }> };
const cache = (g.__rlCache ??= new Map());
const TTL = 10 * 60_000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${config.reloadly.mode}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await fn();
  cache.set(k, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function descMap(d: RawOperator["fixedAmountsDescriptions"]): Record<string, string> {
  return d && !Array.isArray(d) && typeof d === "object" ? (d as Record<string, string>) : {};
}

function lookupDesc(map: Record<string, string>, amount: number): string | null {
  return map[amount.toFixed(2)] ?? map[String(amount)] ?? map[amount.toFixed(1)] ?? null;
}

export function normaliseOperator(op: RawOperator): OperatorDTO {
  const id = op.operatorId ?? op.id ?? 0;
  const fxRate = op.fx?.rate && op.fx.rate > 0 ? op.fx.rate : null;
  const fixed = [...(op.fixedAmounts ?? [])].sort((a, b) => a - b);
  const localFixed = [...(op.localFixedAmounts ?? [])].sort((a, b) => a - b);
  const descs = descMap(op.fixedAmountsDescriptions);
  const localDescs = descMap(op.localFixedAmountsDescriptions);
  const pairByIndex = localFixed.length === fixed.length;

  const products: OperatorProduct[] = fixed.map((amount, i) => {
    const localAmount = pairByIndex ? localFixed[i] : fxRate ? Math.round(amount * fxRate * 100) / 100 : null;
    return {
      code: amount.toFixed(2),
      senderAmount: amount,
      localAmount,
      description: lookupDesc(descs, amount) ?? (localAmount !== null ? lookupDesc(localDescs, localAmount) : null),
    };
  });

  return {
    code: String(id),
    name: op.name,
    logoUrl: op.logoUrls?.[0] ?? null,
    isData: Boolean(op.data),
    isBundle: Boolean(op.bundle),
    denominationType: op.denominationType === "RANGE" ? "RANGE" : "FIXED",
    supportsLocalAmounts: Boolean(op.supportsLocalAmounts),
    senderCurrency: op.senderCurrencyCode ?? "USD",
    localCurrency: op.destinationCurrencyCode ?? op.fx?.currencyCode ?? "",
    localCurrencySymbol: op.destinationCurrencySymbol ?? null,
    fxRate,
    minAmount: op.minAmount ?? null,
    maxAmount: op.maxAmount ?? null,
    localMinAmount: op.localMinAmount ?? null,
    localMaxAmount: op.localMaxAmount ?? null,
    products,
    suggestedAmounts: op.suggestedAmounts ?? [],
  };
}

function billerFx(b: RawBiller): number | null {
  const fx = b.fx;
  if (!fx) return null;
  if (Array.isArray(fx)) {
    const r = fx.find((x) => typeof x?.rate === "number")?.rate;
    return r && r > 0 ? r : null;
  }
  return fx.rate && fx.rate > 0 ? fx.rate : null;
}

export function normaliseBiller(b: RawBiller): BillerDTO {
  return {
    code: String(b.id),
    name: b.name,
    countryCode: (b.countryIsoCode ?? b.countryCode ?? "").toUpperCase(),
    type: b.type,
    serviceType: b.serviceType,
    localCurrency: b.localTransactionCurrencyCode ?? "",
    localAmountSupported: Boolean(b.localAmountSupported),
    minLocalAmount: b.minLocalTransactionAmount ?? null,
    maxLocalAmount: b.maxLocalTransactionAmount ?? null,
    localFee: b.localTransactionFee ?? null,
    senderCurrency: b.internationalTransactionCurrencyCode ?? null,
    minSenderAmount: b.minInternationalTransactionAmount ?? null,
    maxSenderAmount: b.maxInternationalTransactionAmount ?? null,
    fxRate: billerFx(b),
  };
}

export const isDataOperator = (o: OperatorDTO) => o.isData || o.isBundle;
export const isAirtimeOperator = (o: OperatorDTO) => !o.isData && !o.isBundle;

// ---------------------------------------------------------------------------
// Catalogue queries
// ---------------------------------------------------------------------------

const OPERATOR_QS = "includeBundles=true&includeData=true&includePin=false&suggestedAmounts=true";

export async function operatorsForCountry(countryCode: string): Promise<OperatorDTO[]> {
  return cached(`ops:${countryCode}`, async () => {
    const raw = await reloadlyRequest<RawOperator[]>("airtime", "GET", `/operators/countries/${encodeURIComponent(countryCode)}?${OPERATOR_QS}`);
    return (Array.isArray(raw) ? raw : [])
      .filter((o) => !o.status || o.status === "ACTIVE")
      .map(normaliseOperator);
  });
}

/** Fetch a single operator fresh (used for pricing — never trust client-sent prices). */
export async function operatorById(id: number): Promise<{ raw: RawOperator; dto: OperatorDTO }> {
  const raw = await reloadlyRequest<RawOperator>("airtime", "GET", `/operators/${id}?suggestedAmounts=true&includeBundles=true&includeData=true`);
  return { raw, dto: normaliseOperator(raw) };
}

export async function detectOperator(phone: string, countryCode: string): Promise<OperatorDTO | null> {
  try {
    const raw = await reloadlyRequest<RawOperator>(
      "airtime",
      "GET",
      `/operators/auto-detect/phone/${encodeURIComponent(phone)}/countries/${encodeURIComponent(countryCode)}?suggestedAmounts=true`,
    );
    return raw && raw.name ? normaliseOperator(raw) : null;
  } catch {
    return null;
  }
}

export async function electricityBillers(countryCode: string): Promise<BillerDTO[]> {
  return cached(`billers:${countryCode}`, async () => {
    const res = await reloadlyRequest<{ content?: RawBiller[] } | RawBiller[]>(
      "utilities",
      "GET",
      `/billers?type=ELECTRICITY_BILL_PAYMENT&countryISOCode=${encodeURIComponent(countryCode)}&size=200`,
    );
    const list = Array.isArray(res) ? res : res.content ?? [];
    return list.map(normaliseBiller);
  });
}

export async function billerById(id: number): Promise<(BillerDTO & { id: number }) | null> {
  const res = await reloadlyRequest<{ content?: RawBiller[] } | RawBiller[]>("utilities", "GET", `/billers?id=${id}`);
  const list = Array.isArray(res) ? res : res.content ?? [];
  const b = list.find((x) => x.id === id);
  return b ? { ...normaliseBiller(b), id: b.id } : null;
}

export async function countryServices(countryCode: string): Promise<CountryServices> {
  const [ops, billers] = await Promise.all([
    operatorsForCountry(countryCode).catch((e) => {
      if ((e as { status?: number }).status === 404) return [] as OperatorDTO[];
      throw e;
    }),
    electricityBillers(countryCode).catch(() => [] as BillerDTO[]),
  ]);
  return {
    countryCode,
    airtime: ops.some(isAirtimeOperator),
    data: ops.some(isDataOperator),
    electricity: billers.length > 0,
    operatorCount: ops.length,
    billerCount: billers.length,
  };
}

export async function accountBalance(product: "airtime" | "utilities") {
  return reloadlyRequest<{ balance: number; currencyCode: string; currencyName?: string; updatedAt?: string }>(
    product,
    "GET",
    "/accounts/balance",
  );
}
