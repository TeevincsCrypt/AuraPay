import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Central runtime configuration.
 *
 * Every integration reports its *actual* availability from here. Nothing in the
 * app may silently fall back to simulated behaviour: simulated features are only
 * enabled by explicit mode rules below and are always labelled in the UI.
 */

export type AppMode = "development" | "demo" | "sandbox" | "production";
export type ReloadlyMode = "sandbox" | "production";
export type NimiqNetwork = "mainnet" | "testnet";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function bool(name: string, fallback = false): boolean {
  const v = env(name);
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = env(name);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = env(name)?.toLowerCase();
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

const appMode = oneOf<AppMode>(
  "APP_MODE",
  ["development", "demo", "sandbox", "production"],
  process.env.NODE_ENV === "production" ? "demo" : "development",
);

let ephemeralSessionSecret: string | undefined;

export const config = {
  appMode,
  isProduction: appMode === "production",
  /** Simulators (demo payments, paper investing, lending simulator) are never available in production. */
  simulatorsAllowed: appMode === "development" || appMode === "demo",

  sessionSecret(): string {
    const s = env("SESSION_SECRET");
    if (s && s.length >= 32) return s;
    if (appMode === "production" || appMode === "sandbox") {
      throw new Error("SESSION_SECRET (>= 32 chars) is required in sandbox and production modes.");
    }
    // Development/demo only: random per-process secret (sessions reset on restart).
    ephemeralSessionSecret ??= randomBytes(32).toString("hex");
    return ephemeralSessionSecret;
  },
  sessionSecretConfigured: (env("SESSION_SECRET")?.length ?? 0) >= 32,

  databaseUrl: env("DATABASE_URL"),
  /** Directory for the embedded PGlite fallback. Empty = in-memory. */
  pgliteDir: env("PGLITE_DIR") === "memory" ? undefined : env("PGLITE_DIR") ?? (process.env.VERCEL ? undefined : ".data/pglite"),

  adminToken: env("ADMIN_API_TOKEN"),

  reloadly: {
    clientId: env("RELOADLY_CLIENT_ID"),
    clientSecret: env("RELOADLY_CLIENT_SECRET"),
    mode: oneOf<ReloadlyMode>("RELOADLY_MODE", ["sandbox", "production"], "sandbox"),
    get configured() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  nimiq: {
    network: oneOf<NimiqNetwork>("NIMIQ_NETWORK", ["mainnet", "testnet"], "testnet"),
    merchantAddress: env("NIMIQ_MERCHANT_ADDRESS"),
    /** JSON-RPC endpoint of a Nimiq Albatross node used to verify payments. */
    rpcUrl:
      env("NIMIQ_RPC_URL") ??
      // The open server documented on nimiq.dev (testing/prototyping only). Testnet has no default.
      (oneOf<NimiqNetwork>("NIMIQ_NETWORK", ["mainnet", "testnet"], "testnet") === "mainnet"
        ? "https://rpc.nimiqwatch.com"
        : undefined),
    rpcAuth: env("NIMIQ_RPC_AUTH"), // optional "user:password" for a private node
    minConfirmations: int("NIMIQ_MIN_CONFIRMATIONS", 2),
  },

  polygon: {
    merchantAddress: env("POLYGON_MERCHANT_ADDRESS")?.toLowerCase(),
    rpcUrl: env("POLYGON_RPC_URL") ?? "https://polygon-bor-rpc.publicnode.com",
    usdtContract: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    chainIdHex: "0x89",
    minConfirmations: int("POLYGON_MIN_CONFIRMATIONS", 10),
  },

  /** Allow real-value (mainnet) payments to fund sandbox/test top-ups. Off by default. */
  allowRealPaymentsForSandbox: bool("ALLOW_REAL_PAYMENTS_FOR_SANDBOX"),

  pricing: {
    serviceFeeBps: int("AURAPAY_SERVICE_FEE_BPS", 150), // 1.5%
    minServiceFeeUsd: Number(env("AURAPAY_MIN_SERVICE_FEE_USD") ?? "0.10"),
    quoteTtlSeconds: int("QUOTE_TTL_SECONDS", 600),
    /** Extra headroom on NIM quotes to absorb price movement during the quote window. */
    nimSlippageBps: int("NIM_SLIPPAGE_BPS", 100),
  },

  rates: {
    coingeckoApiKey: env("COINGECKO_API_KEY"),
    coingeckoPro: bool("COINGECKO_PRO"),
  },

  market: {
    finnhubKey: env("FINNHUB_API_KEY"),
    twelveDataKey: env("TWELVEDATA_API_KEY"),
  },

  brokerage: {
    provider: env("BROKERAGE_PROVIDER"), // e.g. "alpaca" | "dinari" once contracted
  },

  lending: {
    provider: env("LENDING_PROVIDER"),
    simulatorApr: Number(env("SIM_LOAN_APR") ?? "0.12"),
    maxLtv: Number(env("SIM_MAX_LTV") ?? "0.40"),
    liquidationLtv: Number(env("SIM_LIQUIDATION_LTV") ?? "0.60"),
  },
} as const;

export function reloadlyEnvironmentLabel(): "sandbox" | "production" {
  return config.reloadly.mode;
}
