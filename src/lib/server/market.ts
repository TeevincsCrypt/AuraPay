import "server-only";
import type { MarketStatus, PricePoint, StockQuote } from "@/lib/shared/types";
import { config } from "./config";
import { getDb } from "./db";
import { log, errorMessage } from "./log";

/**
 * Market data. This module only provides *prices*; it never implies ownership.
 *
 *   - Quotes, company profiles and US market status: Finnhub (FINNHUB_API_KEY)
 *   - Historical prices: Twelve Data (TWELVEDATA_API_KEY)
 *   - Without keys, development/demo modes use a clearly labelled DEMO snapshot.
 *     Production never shows demo prices.
 */

export interface StockRef {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  description: string;
}

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

export function marketDataMode(): "live" | "demo" | "unavailable" {
  if (config.market.finnhubKey) return "live";
  return config.simulatorsAllowed ? "demo" : "unavailable";
}

export async function stockRefs(): Promise<StockRef[]> {
  return cached("refs", 10 * 60_000, async () => {
    const db = await getDb();
    return db.query<StockRef & Record<string, unknown>>(
      "select symbol, name, exchange, sector, description from stocks where is_active order by sort_order",
    );
  });
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
interface FinnhubProfile { logo?: string; name?: string; weburl?: string; marketCapitalization?: number }

async function liveQuote(ref: StockRef): Promise<StockQuote> {
  const [q, profile] = await Promise.all([
    cached(`q:${ref.symbol}`, 30_000, () => finnhub<FinnhubQuote>(`/quote?symbol=${ref.symbol}`)),
    cached(`p:${ref.symbol}`, 24 * 3600_000, () => finnhub<FinnhubProfile>(`/stock/profile2?symbol=${ref.symbol}`)).catch(() => ({}) as FinnhubProfile),
  ]);
  const valid = q && q.c > 0;
  return {
    ...ref,
    logoUrl: profile.logo || null,
    price: valid ? q.c : null,
    change: valid ? q.d : null,
    changePercent: valid ? q.dp : null,
    dayHigh: valid ? q.h : null,
    dayLow: valid ? q.l : null,
    open: valid ? q.o : null,
    previousClose: valid ? q.pc : null,
    asOf: valid && q.t ? new Date(q.t * 1000).toISOString() : null,
    source: valid ? "finnhub" : "unavailable",
  };
}

// ---------------------------------------------------------------------------
// Demo snapshot (development/demo only, always labelled DEMO in the UI)
// ---------------------------------------------------------------------------

const DEMO_PRICES: Record<string, [number, number]> = {
  // symbol: [illustrative price, illustrative previous close]
  NVDA: [182.4, 179.9], AAPL: [231.2, 232.6], MSFT: [428.5, 424.1], TSLA: [262.3, 268.9], AMZN: [196.8, 194.2],
  GOOGL: [171.4, 170.1], META: [589.0, 581.3], AMD: [158.7, 161.2], NFLX: [702.5, 695.0], COIN: [214.6, 205.3],
};

function seeded(symbol: string) {
  let h = 2166136261;
  for (const ch of symbol) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function demoQuote(ref: StockRef): StockQuote {
  const [price, pc] = DEMO_PRICES[ref.symbol] ?? [100, 100];
  return {
    ...ref,
    logoUrl: null,
    price,
    change: +(price - pc).toFixed(2),
    changePercent: +(((price - pc) / pc) * 100).toFixed(2),
    dayHigh: +(Math.max(price, pc) * 1.008).toFixed(2),
    dayLow: +(Math.min(price, pc) * 0.992).toFixed(2),
    open: pc,
    previousClose: pc,
    asOf: null,
    source: "demo",
  };
}

function demoHistory(symbol: string, points: number, stepDays: number): PricePoint[] {
  const [end] = DEMO_PRICES[symbol] ?? [100];
  const rand = seeded(symbol + points);
  const series: number[] = [end];
  for (let i = 1; i < points; i++) series.push(series[i - 1] / (1 + (rand() - 0.48) * 0.035));
  series.reverse();
  const now = Date.now();
  return series.map((c, i) => ({ t: new Date(now - (points - 1 - i) * stepDays * 86400_000).toISOString(), c: +c.toFixed(2) }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function unavailableQuote(ref: StockRef): StockQuote {
  return { ...ref, logoUrl: null, price: null, change: null, changePercent: null, dayHigh: null, dayLow: null, open: null, previousClose: null, asOf: null, source: "unavailable" };
}

export async function getQuotes(): Promise<StockQuote[]> {
  const refs = await stockRefs();
  const mode = marketDataMode();
  if (mode === "demo") return refs.map(demoQuote);
  if (mode === "unavailable") return refs.map(unavailableQuote);
  return Promise.all(
    refs.map((r) =>
      liveQuote(r).catch((err) => {
        log.warn("market.quote_failed", { symbol: r.symbol, error: errorMessage(err) });
        return unavailableQuote(r);
      }),
    ),
  );
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  const ref = (await stockRefs()).find((r) => r.symbol === symbol.toUpperCase());
  if (!ref) return null;
  const mode = marketDataMode();
  if (mode === "demo") return demoQuote(ref);
  if (mode === "unavailable") return unavailableQuote(ref);
  try {
    return await liveQuote(ref);
  } catch (err) {
    log.warn("market.quote_failed", { symbol, error: errorMessage(err) });
    return unavailableQuote(ref);
  }
}

const RANGE_SPEC: Record<HistoryRange, { interval: string; outputsize: number; demoPoints: number; demoStep: number }> = {
  "1W": { interval: "1h", outputsize: 45, demoPoints: 35, demoStep: 0.2 },
  "1M": { interval: "1day", outputsize: 23, demoPoints: 23, demoStep: 1.3 },
  "3M": { interval: "1day", outputsize: 66, demoPoints: 66, demoStep: 1.37 },
  "1Y": { interval: "1week", outputsize: 52, demoPoints: 52, demoStep: 7 },
};

export async function getHistory(symbol: string, range: HistoryRange): Promise<{ points: PricePoint[]; source: "twelvedata" | "demo" | "unavailable"; reason?: string }> {
  const spec = RANGE_SPEC[range];
  const sym = symbol.toUpperCase();
  if (!config.market.twelveDataKey) {
    if (config.simulatorsAllowed) return { points: demoHistory(sym, spec.demoPoints, spec.demoStep), source: "demo" };
    return { points: [], source: "unavailable", reason: "Price history provider is not configured." };
  }
  try {
    const points = await cached(`h:${sym}:${range}`, 30 * 60_000, async () => {
      const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${spec.interval}&outputsize=${spec.outputsize}&apikey=${config.market.twelveDataKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      const body = (await res.json()) as { status?: string; message?: string; values?: { datetime: string; close: string }[] };
      if (!res.ok || body.status === "error" || !body.values) throw new Error(body.message ?? `Twelve Data HTTP ${res.status}`);
      return body.values
        .map((v) => ({ t: new Date(v.datetime.replace(" ", "T") + (v.datetime.length > 10 ? "" : "T00:00:00") + "Z").toISOString(), c: Number(v.close) }))
        .filter((p) => Number.isFinite(p.c))
        .reverse();
    });
    return { points, source: "twelvedata" };
  } catch (err) {
    log.warn("market.history_failed", { symbol: sym, error: errorMessage(err) });
    return { points: [], source: "unavailable", reason: "Price history is temporarily unavailable." };
  }
}

export async function getMarketStatus(): Promise<MarketStatus> {
  const mode = marketDataMode();
  if (mode !== "live") return { isOpen: null, session: null, source: mode === "demo" ? "demo" : "unavailable" };
  try {
    const s = await cached("status", 60_000, () => finnhub<{ isOpen: boolean; session: string | null }>("/stock/market-status?exchange=US"));
    return { isOpen: s.isOpen, session: s.session ?? null, source: "finnhub" };
  } catch {
    return { isOpen: null, session: null, source: "unavailable" };
  }
}
