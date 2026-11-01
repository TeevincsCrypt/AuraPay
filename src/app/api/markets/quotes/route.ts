import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { getMarketStatus, getQuotes, marketDataSource } from "@/lib/server/market";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "markets", 60, 60);
  const [quotes, market] = await Promise.all([getQuotes(), getMarketStatus()]);
  return json({ source: marketDataSource(), market, quotes });
});
