import "server-only";
import type { MarketStatus, PricePoint, StockQuote } from "@/lib/shared/types";
import { STOCK_TOKENS } from "@/lib/shared/stock-tokens";
import { STOCK_REFS, type StockRef } from "@/lib/shared/stocks";
import { coingecko, tokenPrices } from "./coingecko";
import { config } from "./config";
import { errorMessage, log } from "./log";

/**
 * Market data — real sources only:
 *   - Stock quotes: Finnhub (FINNHUB_API_KEY) for the listed share price.
 *   - Without Finnhub, the live market price of the tokenised stock AuraPay buys
 *     (CoinGecko), clearly labelled "tokenised price".
 *   - History: Twelve Data (TWELVEDATA_API_KEY) or CoinGecko token market charts.
 * If a source fails, the value is reported unavailable — never invented.
 */

export type { StockRef } from "@/lib/shared/stocks";

export type HistoryRange = "1W" | "1M" | "3M" | "1Y";

const g = globalThis as unknown as { __apMkt?: Map<string, { at: number; value: unknown }> };
const cache = (g.__apMkt ??= new Map());

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function marketDataSource(): "finnhub" | "tokenized" {
  return config.market.finnhubKey ? "finnhub" : "tokenized";
}

/** Supported stocks come from code, so market data works even before the database is reachable. */
export async function stockRefs(): Promise<StockRef[]> {
  return STOCK_REFS;
}

// ---------------------------------------------------------------------------
// Finnhub
// ---------------------------------------------------------------------------

async function finnhub<T>(path: string): Promise<T> {
  const res = await fetch(`https://finnhub.io/api/v1${path}`, {
    headers: { "X-Finnhub-Token": config.market.finnhubKey!, Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (res.status === 429) throw new Error("Finnhub rate limit reached");
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface FinnhubQuote { c: number; d: number | null; dp: number | null; h: number; l: number; o: number; pc: number; t: number }
interface FinnhubProfile { logo?: string }

function tokenInfo(symbol: string) {
  const t = STOCK_TOKENS[symbol]?.primary;
  return t ? { symbol: t.symbol, chainId: t.chainId, issuer: t.issuer, address: t.address, coingeckoId: t.coingeckoId } : null;
}

const empty = (ref: StockRef): StockQuote => ({
  ...ref,
  logoUrl: null,
  price: null,
  change: null,
  changePercent: null,
  dayHigh: null,
  dayLow: null,
  open: null,
  previousClose: null,
  asOf: null,
  source: "unavailable",
  token: tokenInfo(ref.symbol),
  tokenPriceUsd: null,
});

async function finnhubQuote(ref: StockRef): Promise<StockQuote> {
  const [q, profile] = await Promise.all([
    cached(`q:${ref.symbol}`, 30_000, () => finnhub<FinnhubQuote>(`/quote?symbol=${ref.symbol}`)),
    cached(`p:${ref.symbol}`, 24 * 3600_000, () => finnhub<FinnhubProfile>(`/stock/profile2?symbol=${ref.symbol}`)).catch(() => ({}) as FinnhubProfile),
  ]);
  if (!q || !(q.c > 0)) return empty(ref);
  return {
    ...empty(ref),
    logoUrl: profile.logo || null,
    price: q.c,
    change: q.d,
    changePercent: q.dp,
    dayHigh: q.h,
    dayLow: q.l,
    open: q.o,
    previousClose: q.pc,
    asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
    source: "finnhub",
  };
}

export async function getQuotes(): Promise<StockQuote[]> {
  const refs = await stockRefs();
  const ids = refs.map((r) => STOCK_TOKENS[r.symbol]?.primary.coingeckoId).filter(Boolean) as string[];
  const tp = await tokenPrices(ids).catch((err) => {
    log.warn("market.token_prices_failed", { error: errorMessage(err) });
    return new Map();
  });

  return Promise.all(
    refs.map(async (ref) => {
      const token = STOCK_TOKENS[ref.symbol]?.primary;
      const tPrice = token ? tp.get(token.coingeckoId) : undefined;
      let quote: StockQuote;
      if (config.market.finnhubKey) {
        quote = await finnhubQuote(ref).catch((err) => {
          log.warn("market.quote_failed", { symbol: ref.symbol, error: errorMessage(err) });
          return empty(ref);
        });
      } else if (tPrice) {
        const prev = tPrice.change24h !== null ? tPrice.usd / (1 + tPrice.change24h / 100) : null;
        quote = {
          ...empty(ref),
          price: tPrice.usd,
          change: prev !== null ? tPrice.usd - prev : null,
          changePercent: tPrice.change24h,
          previousClose: prev,
          asOf: new Date().toISOString(),
          source: "tokenized",
        };
      } else {
        quote = empty(ref);
      }
      quote.tokenPriceUsd = tPrice?.usd ?? null;
      return quote;
    }),
  );
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  return (await getQuotes()).find((q) => q.symbol === symbol.toUpperCase()) ?? null;
}

const TD_SPEC: Record<HistoryRange, { interval: string; outputsize: number; cgDays: number }> = {
  "1W": { interval: "1h", outputsize: 45, cgDays: 7 },
  "1M": { interval: "1day", outputsize: 23, cgDays: 30 },
  "3M": { interval: "1day", outputsize: 66, cgDays: 90 },
  "1Y": { interval: "1week", outputsize: 52, cgDays: 365 },
};

export async function getHistory(
  symbol: string,
  range: HistoryRange,
): Promise<{ points: PricePoint[]; source: "twelvedata" | "coingecko" | "unavailable"; reason?: string }> {
  const sym = symbol.toUpperCase();
  const spec = TD_SPEC[range];
  try {
    if (config.market.twelveDataKey) {
      const points = await cached(`h:${sym}:${range}`, 30 * 60_000, async () => {
        const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${spec.interval}&outputsize=${spec.outputsize}&apikey=${config.market.twelveDataKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
        const body = (await res.json()) as { status?: string; message?: string; values?: { datetime: string; close: string }[] };
        if (!res.ok || body.status === "error" || !body.values) throw new Error(body.message ?? `Twelve Data HTTP ${res.status}`);
        return body.values
          .map((v) => ({ t: new Date(v.datetime.length > 10 ? v.datetime.replace(" ", "T") + "Z" : `${v.datetime}T00:00:00Z`).toISOString(), c: Number(v.close) }))
          .filter((p) => Number.isFinite(p.c))
          .reverse();
      });
      return { points, source: "twelvedata" };
    }
    const id = STOCK_TOKENS[sym]?.primary.coingeckoId;
    if (!id) return { points: [], source: "unavailable", reason: "No price history source for this stock." };
    const body = await coingecko<{ prices?: [number, number][] }>(`/coins/${id}/market_chart?vs_currency=usd&days=${spec.cgDays}`, 15 * 60_000);
    const raw = (body.prices ?? []).filter((p) => Number.isFinite(p[1]) && p[1] > 0);
    // Downsample to ≤ 90 points for a clean chart.
    const step = Math.max(1, Math.ceil(raw.length / 90));
    const points = raw.filter((_, i) => i % step === 0 || i === raw.length - 1).map(([t, c]) => ({ t: new Date(t).toISOString(), c }));
    return { points, source: "coingecko" };
  } catch (err) {
    log.warn("market.history_failed", { symbol: sym, error: errorMessage(err) });
    return { points: [], source: "unavailable", reason: "Price history is temporarily unavailable." };
  }
}

export async function getMarketStatus(): Promise<MarketStatus> {
  if (!config.market.finnhubKey) return { isOpen: null, session: null, source: "unavailable" };
  try {
    const s = await cached("status", 60_000, () => finnhub<{ isOpen: boolean; session: string | null }>("/stock/market-status?exchange=US"));
    return { isOpen: s.isOpen, session: s.session ?? null, source: "finnhub" };
  } catch {
    return { isOpen: null, session: null, source: "unavailable" };
  }
}
