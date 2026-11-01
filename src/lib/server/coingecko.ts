import "server-only";
import { config, testOverride } from "./config";

/** CoinGecko REST client (public or Demo/Pro key), with a short in-memory cache per URL. */

const g = globalThis as unknown as { __cgCache?: Map<string, { at: number; value: unknown }> };
const cache = (g.__cgCache ??= new Map());

export async function coingecko<T>(pathAndQuery: string, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(pathAndQuery);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const { coingeckoApiKey, coingeckoPro } = config.rates;
  const host = testOverride("COINGECKO_URL_OVERRIDE") || (coingeckoPro ? "https://pro-api.coingecko.com" : "https://api.coingecko.com");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (coingeckoApiKey) headers[coingeckoPro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = coingeckoApiKey;
  const res = await fetch(`${host}/api/v3${pathAndQuery}`, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!res.ok) {
    // Serve a recent value through short outages rather than failing outright.
    if (hit && Date.now() - hit.at < 10 * ttlMs) return hit.value as T;
    throw new Error(`CoinGecko HTTP ${res.status}`);
  }
  const value = (await res.json()) as T;
  cache.set(pathAndQuery, { at: Date.now(), value });
  return value;
}

export interface TokenPrice {
  usd: number;
  change24h: number | null;
}

/** USD prices (and 24h change) for CoinGecko ids, in one request. Missing ids are omitted. */
export async function tokenPrices(ids: string[]): Promise<Map<string, TokenPrice>> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return new Map();
  const body = await coingecko<Record<string, { usd?: number; usd_24h_change?: number }>>(
    `/simple/price?ids=${unique.join(",")}&vs_currencies=usd&include_24hr_change=true`,
  );
  const out = new Map<string, TokenPrice>();
  for (const id of unique) {
    const v = body[id];
    if (v?.usd && v.usd > 0) out.set(id, { usd: v.usd, change24h: typeof v.usd_24h_change === "number" ? v.usd_24h_change : null });
  }
  return out;
}
