import "server-only";

/**
 * Central runtime configuration. AuraPay runs real integrations only: there are no
 * simulators and no demo data. Each integration reports its actual availability.
 */

export type ReloadlyMode = "sandbox" | "production";
export type NimiqNetwork = "mainnet" | "testnet";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Strips quotes people often paste around values in the Vercel UI. */
function unquote(v: string | undefined): string | undefined {
  if (!v) return v;
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2].trim() || undefined : v;
}

/**
 * Postgres connection string. DATABASE_URL is preferred; the names created by the
 * Supabase ↔ Vercel integration (POSTGRES_URL, the pooled connection) are accepted too.
 */
const DB_URL_VARS = ["DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL"] as const;
function databaseUrl(): { url?: string; from?: string } {
  for (const name of DB_URL_VARS) {
    const url = unquote(env(name));
    if (url) return { url, from: name };
  }
  return {};
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

const isProdRuntime = process.env.NODE_ENV === "production";
const nimiqNetwork = oneOf<NimiqNetwork>("NIMIQ_NETWORK", ["mainnet", "testnet"], "mainnet");

/**
 * Local mock providers (scripts/mock-providers.mjs) are only honoured when
 * AURAPAY_TEST_MODE=true, which is refused on Vercel production deployments.
 */
export const testMode = bool("AURAPAY_TEST_MODE") && process.env.VERCEL_ENV !== "production";

export const config = {
  isProdRuntime,
  testMode,

  /** Public origin used in sign-in messages and Nimiq Pay deep links, e.g. https://aurapay.app */
  appUrl: env("APP_URL"),

  databaseUrl: databaseUrl().url,
  databaseUrlSource: databaseUrl().from,
  /** Embedded PGlite is for local development only. */
  pgliteDir: env("PGLITE_DIR") === "memory" ? undefined : env("PGLITE_DIR") ?? ".data/pglite",
  allowEmbeddedDb: !isProdRuntime || testMode,

  adminToken: env("ADMIN_API_TOKEN"),
  /** Shared secret for the scheduled-bills runner (Vercel Cron sends it as a Bearer token). */
  cronSecret: env("CRON_SECRET"),

  reloadly: {
    clientId: env("RELOADLY_CLIENT_ID"),
    clientSecret: env("RELOADLY_CLIENT_SECRET"),
    mode: oneOf<ReloadlyMode>("RELOADLY_MODE", ["sandbox", "production"], "production"),
    get configured() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  flutterwave: {
    secretKey: env("FLUTTERWAVE_SECRET_KEY"),
    /** Test keys (FLWSECK_TEST-…) run in Flutterwave's test mode; nothing is delivered. */
    get mode(): ReloadlyMode {
      return (this.secretKey ?? "").startsWith("FLWSECK_TEST") ? "sandbox" : "production";
    },
    get configured() {
      return Boolean(this.secretKey);
    },
  },

  /** Active utility provider: UTILITY_PROVIDER if set, else whichever has credentials (Flutterwave first). */
  get utilityProvider(): "flutterwave" | "reloadly" | null {
    const forced = env("UTILITY_PROVIDER")?.toLowerCase();
    if (forced === "flutterwave" || forced === "reloadly") return forced;
    if (env("FLUTTERWAVE_SECRET_KEY")) return "flutterwave";
    if (env("RELOADLY_CLIENT_ID") && env("RELOADLY_CLIENT_SECRET")) return "reloadly";
    return null;
  },

  nimiq: {
    network: nimiqNetwork,
    merchantAddress: env("NIMIQ_MERCHANT_ADDRESS"),
    rpcUrl: env("NIMIQ_RPC_URL") ?? (nimiqNetwork === "mainnet" ? "https://rpc.nimiqwatch.com" : undefined),
    rpcAuth: env("NIMIQ_RPC_AUTH"),
    minConfirmations: int("NIMIQ_MIN_CONFIRMATIONS", 2),
  },

  polygon: {
    merchantAddress: env("POLYGON_MERCHANT_ADDRESS")?.toLowerCase(),
    rpcUrl: env("POLYGON_RPC_URL") ?? "https://polygon-bor-rpc.publicnode.com",
    usdtContract: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    chainIdHex: "0x89",
    minConfirmations: int("POLYGON_MIN_CONFIRMATIONS", 10),
  },

  /** RPC endpoints for chains where tokenised stocks and Aave V4 live. */
  rpc: {
    1: env("ETHEREUM_RPC_URL") ?? "https://ethereum-rpc.publicnode.com",
    137: env("POLYGON_RPC_URL") ?? "https://polygon-bor-rpc.publicnode.com",
    8453: env("BASE_RPC_URL") ?? "https://base-rpc.publicnode.com",
    42161: env("ARBITRUM_RPC_URL") ?? "https://arbitrum-one-rpc.publicnode.com",
  } as Record<number, string>,

  /** Allow real-value payments to fund SANDBOX (test) top-ups. Off by default. */
  allowRealPaymentsForSandbox: bool("ALLOW_REAL_PAYMENTS_FOR_SANDBOX"),

  pricing: {
    serviceFeeBps: int("AURAPAY_SERVICE_FEE_BPS", 150),
    minServiceFeeUsd: Number(env("AURAPAY_MIN_SERVICE_FEE_USD") ?? "0.10"),
    quoteTtlSeconds: int("QUOTE_TTL_SECONDS", 600),
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

  cow: {
    /** Optional partner fee on stock purchases (CoW Protocol partner fee), in BPS. */
    partnerFeeBps: int("COW_PARTNER_FEE_BPS", 0),
    partnerFeeRecipient: env("COW_PARTNER_FEE_RECIPIENT"),
    appCode: env("COW_APP_CODE") ?? "AuraPay",
  },
} as const;

/** A test-only override URL, honoured only when AURAPAY_TEST_MODE is on. */
export function testOverride(name: string): string | undefined {
  return testMode ? env(name) : undefined;
}
