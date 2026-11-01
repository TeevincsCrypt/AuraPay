import "server-only";
import { config, testOverride } from "../config";
import { log } from "../log";

/**
 * Reloadly REST client (Airtime + Utility Payments).
 *
 * Endpoints follow Reloadly's published OpenAPI specs:
 *   github.com/Reloadly/reloadly-airtime-documentation
 *   github.com/Reloadly/reloadly-utility-payments-documentation
 *
 * - OAuth2 client-credentials tokens are cached per product audience and
 *   refreshed shortly before `expires_in` elapses (single-flight).
 * - 401s invalidate the cached token and retry once.
 * - 429s and transient 5xx on *reads* retry with backoff.
 * - Money-moving POSTs (/topups, /pay) are never retried automatically: an
 *   uncertain outcome is surfaced so the order goes to reconciliation.
 */

export type ReloadlyProduct = "airtime" | "utilities";

// Test-only overrides (local mock server); honoured only with AURAPAY_TEST_MODE=true.
const override = testOverride;

const AUTH_URL = override("RELOADLY_AUTH_URL_OVERRIDE") ?? "https://auth.reloadly.com/oauth/token";

function baseUrl(product: ReloadlyProduct): string {
  const o = override(product === "airtime" ? "RELOADLY_AIRTIME_URL_OVERRIDE" : "RELOADLY_UTILITIES_URL_OVERRIDE");
  if (o) return o;
  const sandbox = config.reloadly.mode === "sandbox";
  if (product === "airtime") return sandbox ? "https://topups-sandbox.reloadly.com" : "https://topups.reloadly.com";
  return sandbox ? "https://utilities-sandbox.reloadly.com" : "https://utilities.reloadly.com";
}

const ACCEPT: Record<ReloadlyProduct, string> = {
  airtime: "application/com.reloadly.topups-v1+json",
  utilities: "application/com.reloadly.utilities-v1+json",
};

export class ReloadlyError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | null,
    message: string,
    /** True when the request may or may not have been executed by the provider. */
    public readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const g = globalThis as unknown as {
  __reloadlyTokens?: Map<string, CachedToken>;
  __reloadlyInflight?: Map<string, Promise<CachedToken>>;
};
const tokens = (g.__reloadlyTokens ??= new Map());
const inflight = (g.__reloadlyInflight ??= new Map());

async function fetchToken(product: ReloadlyProduct): Promise<CachedToken> {
  const { clientId, clientSecret } = config.reloadly;
  if (!clientId || !clientSecret) {
    throw new ReloadlyError(0, "NOT_CONFIGURED", "Reloadly credentials are not configured.");
  }
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      audience: baseUrl(product),
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    errorCode?: string;
    message?: string;
  };
  if (!res.ok || !body.access_token) {
    log.error("reloadly.auth_failed", { product, status: res.status, errorCode: body.errorCode });
    throw new ReloadlyError(res.status, body.errorCode ?? "AUTH_FAILED", body.message ?? "Reloadly authentication failed.");
  }
  const ttlMs = Math.max(60, body.expires_in ?? 3600) * 1000;
  // Refresh 5 minutes (or 10% of lifetime) before expiry.
  const skew = Math.min(5 * 60_000, ttlMs * 0.1);
  log.info("reloadly.token_issued", { product, expiresInSeconds: body.expires_in });
  return { token: body.access_token, expiresAt: Date.now() + ttlMs - skew };
}

async function getToken(product: ReloadlyProduct, force = false): Promise<string> {
  const key = `${config.reloadly.mode}:${product}`;
  const cached = tokens.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
  let p = inflight.get(key);
  if (!p) {
    p = fetchToken(product).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const t = await p;
  tokens.set(key, t);
  return t.token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function reloadlyRequest<T>(
  product: ReloadlyProduct,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl(product)}${path}`;
  const isRead = method === "GET";
  let authRetried = false;

  for (let attempt = 0; attempt < (isRead ? 3 : 1) + 1; attempt++) {
    const token = await getToken(product, false);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: ACCEPT[product],
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(isRead ? 15_000 : 45_000),
        cache: "no-store",
      });
    } catch (err) {
      if (!isRead) {
        // The provider may have received and executed the request.
        throw new ReloadlyError(0, "NETWORK_ERROR", "Network error talking to Reloadly.", true);
      }
      if (attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new ReloadlyError(0, "NETWORK_ERROR", `Network error talking to Reloadly: ${(err as Error).message}`);
    }

    if (res.status === 401 && !authRetried) {
      authRetried = true;
      tokens.delete(`${config.reloadly.mode}:${product}`);
      await getToken(product, true);
      attempt--; // auth retry does not consume a backoff attempt
      continue;
    }

    if (res.status === 429 && isRead && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt);
      continue;
    }

    if (res.status >= 500 && isRead && attempt < 2) {
      await sleep(400 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    if (!res.ok) {
      const e = (data ?? {}) as { errorCode?: string | null; message?: string; error?: string };
      log.warn("reloadly.request_failed", { product, method, path: path.split("?")[0], status: res.status, errorCode: e.errorCode });
      // A 5xx on a money-moving call is ambiguous.
      throw new ReloadlyError(
        res.status,
        e.errorCode ?? (res.status === 429 ? "TOO_MANY_REQUESTS" : null),
        e.message || e.error || `Reloadly returned HTTP ${res.status}`,
        !isRead && res.status >= 500,
      );
    }
    return data as T;
  }
  throw new ReloadlyError(0, "RETRIES_EXHAUSTED", "Reloadly is not responding. Please try again shortly.");
}

/** Maps provider error codes to messages that are safe and helpful for end users. */
export function friendlyReloadlyMessage(err: ReloadlyError): string {
  switch (err.errorCode) {
    case "INVALID_RECIPIENT_PHONE":
    case "INVALID_PHONE_NUMBER":
      return "That phone number isn't valid for the selected operator.";
    case "COUNTRY_NOT_SUPPORTED":
      return "This country isn't currently supported by our provider.";
    case "OPERATOR_NOT_IN_SERVICE":
    case "OPERATOR_UNAVAILABLE_OR_CURRENTLY_INACTIVE":
    case "OPERATOR_NOT_FOUND":
      return "This operator is currently unavailable.";
    case "INSUFFICIENT_BALANCE":
    case "INSUFFICIENT_FUNDS":
      return "This service is temporarily unavailable (provider float is low). You have not been charged for a new order.";
    case "PHONE_RECENTLY_RECHARGED":
      return "This number was just topped up with the same amount. Please wait a few minutes before trying again.";
    case "IMPOSSIBLE_AMOUNT":
    case "INVALID_AMOUNT_FOR_OPERATOR":
    case "AMOUNT_OUT_OF_RANGE":
      return "That amount isn't accepted by the operator.";
    case "TRANSACTION_CANNOT_BE_PROCESSED_AT_THE_MOMENT":
      return "The operator can't process this right now. Please try again later.";
    case "TOO_MANY_REQUESTS":
      return "The provider is busy. Please try again in a moment.";
    case "NOT_CONFIGURED":
      return "The utility provider is not connected.";
    default:
      return err.message || "The utility provider returned an error.";
  }
}
