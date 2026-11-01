import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { getRatesSafe } from "@/lib/server/rates";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "rates", 60, 60);
  const { rates, error } = await getRatesSafe();
  if (!rates) throw new AppError("RATES_UNAVAILABLE", error ?? "Exchange rates unavailable.", 503);
  return json({ nimUsd: rates.nimUsd, usdtUsd: rates.usdtUsd, source: rates.source, fetchedAt: new Date(rates.fetchedAt).toISOString() });
});
