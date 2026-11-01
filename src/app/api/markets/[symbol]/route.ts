import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { getHistory, getMarketStatus, getQuote, marketDataSource } from "@/lib/server/market";

export const dynamic = "force-dynamic";

const Query = z.object({ range: z.enum(["1W", "1M", "3M", "1Y"]).default("1M") });

export const GET = handler(async (req, ctx: { params: Promise<{ symbol: string }> }) => {
  enforceRateLimit(req, "markets", 60, 60);
  const { symbol } = await ctx.params;
  if (!/^[A-Za-z.]{1,8}$/.test(symbol)) throw new AppError("UNKNOWN_SYMBOL", "Unsupported stock.", 404);
  const { range } = parseQuery(req.url, Query);
  const quote = await getQuote(symbol);
  if (!quote) throw new AppError("UNKNOWN_SYMBOL", "Unsupported stock.", 404);
  const [history, market] = await Promise.all([getHistory(symbol, range), getMarketStatus()]);
  return json({ source: marketDataSource(), quote, history, market, range });
});
