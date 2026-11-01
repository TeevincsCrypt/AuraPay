import "server-only";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import type { BillerDTO, BillerService, CountryServices, OperatorDTO, UtilityService } from "@/lib/shared/types";
import { countryByCode } from "@/lib/shared/countries";
import { config } from "../config";
import { AppError } from "../http";

/**
 * Utility-provider interface. The order engine (orders/utility.ts) owns quotes,
 * on-chain payment verification, the state machine and the ledger; a provider only
 * lists products, prices them in USD, submits paid orders and reports their status.
 */

export interface PriceInput {
  service: UtilityService;
  countryCode: string;
  operatorCode: string;
  productCode?: string;
  recipient: string;
  amount: number;
  amountCurrency: "local" | "sender";
}

export interface Priced {
  operatorName: string;
  operatorCode: string;
  itemCode: string | null;
  productDescription: string | null;
  amountLocal: number | null;
  localCurrency: string | null;
  /** Amount in the provider account's (sender) currency, USD. */
  amountSender: number;
  senderCurrency: string;
  useLocalAmount: boolean;
  /** What the provider will charge AuraPay, in USD. */
  providerCostUsd: number;
  /** Normalised recipient (E.164 digits for phones, cleaned meter number). */
  recipient: string;
}

/** The subset of an order a provider needs to fulfil or poll it. */
export interface ProviderOrder {
  ref: string;
  service: UtilityService;
  countryCode: string;
  operatorCode: string;
  itemCode: string | null;
  recipient: string;
  amountLocal: number | null;
  amountSender: number;
  useLocalAmount: boolean;
  providerTransactionId: string | null;
}

export interface ProviderOutcome {
  next: "successful" | "provider_pending" | "requires_review" | "unchanged";
  providerTransactionId?: string | null;
  providerStatus?: string | null;
  providerResponse?: unknown;
  deliveryDetails?: Record<string, unknown> | null;
  reason?: string | null;
}

/** Errors a provider raises; `outcomeUnknown` means the request may have been executed. */
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 502,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

export interface UtilityProvider {
  id: "flutterwave" | "reloadly";
  label: string;
  environment: "sandbox" | "production";
  countryServices(countryCode: string): Promise<CountryServices>;
  operators(countryCode: string, service: "airtime" | "data"): Promise<OperatorDTO[]>;
  detectOperator(e164: string, countryCode: string): Promise<OperatorDTO | null>;
  billers(countryCode: string, service: BillerService): Promise<BillerDTO[]>;
  /** Local currency units per 1 USD at the provider's rate (what bills are priced at), or null. */
  fxPerUsd(currency: string): Promise<number | null>;
  price(input: PriceInput): Promise<Priced>;
  submit(order: ProviderOrder): Promise<ProviderOutcome>;
  poll(order: ProviderOrder): Promise<ProviderOutcome>;
}

export function normalisePhone(raw: string, countryCode: string): string {
  const parsed = parsePhoneNumberFromString(raw, countryCode as CountryCode);
  if (!parsed || !parsed.isValid() || parsed.country !== countryCode) {
    throw new AppError("INVALID_PHONE", `Enter a valid ${countryByCode(countryCode)?.name ?? ""} mobile number.`.replace("  ", " "), 422);
  }
  return parsed.number.replace("+", ""); // E.164 digits
}

export const roundUpCents = (v: number) => Math.ceil(v * 100 - 1e-9) / 100;

/** Converts provider errors into user-facing API errors. */
export function toAppError(err: unknown): unknown {
  if (err instanceof ProviderError) return new AppError(err.code, err.message, err.httpStatus);
  return err;
}

let cached: { key: string; provider: UtilityProvider } | null = null;

/** The active provider, or null when none is configured. */
export async function getUtilityProvider(): Promise<UtilityProvider | null> {
  const id = config.utilityProvider;
  if (!id) return null;
  const key = `${id}:${id === "flutterwave" ? config.flutterwave.mode : config.reloadly.mode}`;
  if (cached?.key === key) return cached.provider;
  const provider = id === "flutterwave" ? (await import("./flutterwave")).flutterwaveProvider() : (await import("./reloadly")).reloadlyProvider();
  cached = { key, provider };
  return provider;
}

export async function requireUtilityProvider(): Promise<UtilityProvider> {
  const p = await getUtilityProvider();
  if (!p) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
  return p;
}

/** Environment of the active provider (sandbox/test vs production). */
export function utilityEnvironment(): "sandbox" | "production" {
  const id = config.utilityProvider;
  if (id === "flutterwave") return config.flutterwave.mode;
  return config.reloadly.mode;
}
