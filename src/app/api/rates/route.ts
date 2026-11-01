import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { DISPLAY_CURRENCIES, localPerUsd, type DisplayCurrency } from "@/lib/server/fiat";
import { getRatesSafe } from "@/lib/server/rates";

export const dynamic = "force-dynamic";

/** NIM and USDT in USD, plus (with ?fiat=NGN etc.) USD in a local currency. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "rates", 60, 60);
  const { rates, error } = await getRatesSafe();
  if (!rates) throw new AppError("RATES_UNAVAILABLE", error ?? "Exchange rates unavailable.", 503);
  const want = new URL(req.url).searchParams.get("fiat")?.toUpperCase();
  const fiatCode = want && (DISPLAY_CURRENCIES as readonly string[]).includes(want) ? (want as DisplayCurrency) : null;
  const fx = fiatCode ? await localPerUsd(fiatCode) : null;
  return json({
    nimUsd: rates.nimUsd,
    usdtUsd: rates.usdtUsd,
    source: rates.source,
    fetchedAt: new Date(rates.fetchedAt).toISOString(),
    fiat: fiatCode ? { currency: fiatCode, perUsd: fx?.perUsd ?? null, source: fx?.source ?? null } : null,
  });
});
