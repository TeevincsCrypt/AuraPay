import "server-only";
import { config } from "./config";
import { coingecko } from "./coingecko";
import { getDb } from "./db";
import { log, errorMessage } from "./log";

/**
 * USD exchange rates for NIM and USDT from CoinGecko.
 *
 * There is deliberately no hard-coded fallback price: if the rate source is
 * unreachable, NIM payments are unavailable rather than priced from stale or
 * invented numbers.
 */

export interface Rates {
  nimUsd: number;
  usdtUsd: number;
  source: string;
  fetchedAt: number;
}

const COINGECKO_IDS = { NIM: "nimiq-2", USDT: "tether" } as const;
const TTL_MS = 60_000;

const g = globalThis as unknown as { __apRates?: { value?: Rates; error?: string; at: number } };

async function fetchRates(): Promise<Rates> {
  const body = await coingecko<Record<string, { usd?: number }>>(
    `/simple/price?ids=${COINGECKO_IDS.NIM},${COINGECKO_IDS.USDT}&vs_currencies=usd`,
    TTL_MS,
  );
  const nimUsd = body[COINGECKO_IDS.NIM]?.usd;
  const usdtUsd = body[COINGECKO_IDS.USDT]?.usd;
  if (!nimUsd || nimUsd <= 0) throw new Error("CoinGecko returned no NIM price");
  if (!usdtUsd || usdtUsd <= 0) throw new Error("CoinGecko returned no USDT price");
  return { nimUsd, usdtUsd, source: "coingecko", fetchedAt: Date.now() };
}

export async function getRates(): Promise<Rates> {
  const c = g.__apRates;
  if (c?.value && Date.now() - c.at < TTL_MS) return c.value;
  try {
    const value = await fetchRates();
    g.__apRates = { value, at: Date.now() };
    void persistRates(value);
    return value;
  } catch (err) {
    log.warn("rates.fetch_failed", { error: errorMessage(err) });
    // A recently fetched rate (< 5 min) may still be used; otherwise fail loudly.
    if (c?.value && Date.now() - c.value.fetchedAt < 5 * 60_000) return c.value;
    g.__apRates = { error: errorMessage(err), at: Date.now() };
    throw new Error("Exchange rates are currently unavailable.");
  }
}

export async function getRatesSafe(): Promise<{ rates?: Rates; error?: string }> {
  try {
    return { rates: await getRates() };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function persistRates(r: Rates) {
  try {
    const db = await getDb();
    await db.query(
      `insert into exchange_rates (base, quote, rate, source) values ('NIM','USD',$1,$3), ('USDT','USD',$2,$3)`,
      [r.nimUsd, r.usdtUsd, r.source],
    );
  } catch (err) {
    log.warn("rates.persist_failed", { error: errorMessage(err) });
  }
}

/**
 * Converts a USD total into the pay currency, rounding *up* in the smallest unit.
 * USDT amounts additionally carry a per-order tag in the last 4 decimals
 * (≤ 0.0099 USDT) so that an on-chain transfer maps to exactly one order.
 */
export function convertUsd(
  totalUsd: number,
  currency: "NIM" | "USDT",
  rates: Rates,
  opts: { usdtTag?: number } = {},
): { amount: number; atomic: string; rate: number } {
  if (currency === "NIM") {
    const withBuffer = totalUsd * (1 + config.pricing.nimSlippageBps / 10_000);
    const luna = Math.ceil((withBuffer / rates.nimUsd) * 1e5);
    return { amount: luna / 1e5, atomic: String(luna), rate: rates.nimUsd };
  }
  // Treat USDT at its market price, but never price it above $1 in the user's favour-to-merchant direction.
  const usdtPrice = Math.min(rates.usdtUsd, 1);
  const cents = Math.ceil((totalUsd / usdtPrice) * 100); // whole cents
  const tag = Math.max(1, Math.min(99, opts.usdtTag ?? 1)); // 0.0001 – 0.0099
  const units = BigInt(cents) * 10_000n + BigInt(tag); // 6 decimals
  return { amount: Number(units) / 1e6, atomic: units.toString(), rate: usdtPrice };
}
