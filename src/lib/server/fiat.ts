import "server-only";
import { coingecko } from "./coingecko";
import { errorMessage, log } from "./log";
import { getUtilityProvider } from "./utilities/provider";

/**
 * Local (fiat) currency per 1 USD, for showing amounts in the user's currency.
 * Primary source: the bill provider's own rate (Flutterwave), i.e. the rate bills are
 * actually priced at. Fallback: CoinGecko's USDT price in that currency. No invented rates:
 * if neither answers, the local amount is simply not shown.
 */

export const DISPLAY_CURRENCIES = ["USD", "NGN", "GHS", "KES", "UGX", "ZAR", "TZS"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

const TTL = 10 * 60_000;
const g = globalThis as unknown as { __apFiat?: Map<string, { at: number; perUsd: number; source: string }> };
const cache = (g.__apFiat ??= new Map());

export async function localPerUsd(currency: DisplayCurrency): Promise<{ perUsd: number; source: string } | null> {
  if (currency === "USD") return { perUsd: 1, source: "fixed" };
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let out: { perUsd: number; source: string } | null = null;
  try {
    const provider = await getUtilityProvider();
    const r = provider ? await provider.fxPerUsd(currency) : null;
    if (r && r > 0) out = { perUsd: r, source: provider!.id };
  } catch (err) {
    log.warn("fiat.provider_rate_failed", { currency, error: errorMessage(err) });
  }
  if (!out) {
    try {
      const body = await coingecko<Record<string, Record<string, number>>>(`/simple/price?ids=tether&vs_currencies=${currency.toLowerCase()}`, TTL);
      const v = body.tether?.[currency.toLowerCase()];
      if (v && v > 0) out = { perUsd: v, source: "coingecko" };
    } catch (err) {
      log.warn("fiat.coingecko_rate_failed", { currency, error: errorMessage(err) });
    }
  }
  if (out) cache.set(currency, { ...out, at: Date.now() });
  return out ?? (hit ? { perUsd: hit.perUsd, source: hit.source } : null);
}
