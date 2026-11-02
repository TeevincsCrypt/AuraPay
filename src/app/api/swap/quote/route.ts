import { z } from "zod";
import { swapConfig, swapQuote } from "@/lib/server/defi/polygon";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { toUnits } from "@/lib/shared/polygon-defi";

export const dynamic = "force-dynamic";

const Query = z.object({ direction: z.enum(["NIM_USDT", "USDT_NIM"]), amount: z.string().regex(/^\d+(\.\d+)?$/) });

/** Live QuickSwap quote from the router's getAmountsOut. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "swap:quote", 120, 60);
  const { direction, amount } = parseQuery(req.url, Query);
  const cfg = await swapConfig();
  if (!cfg.enabled) throw new AppError("SWAP_UNAVAILABLE", cfg.reason ?? "Swap is unavailable.", 409);
  const units = toUnits(amount, direction === "NIM_USDT" ? cfg.nimDecimals ?? 18 : 6);
  if (units <= 0n) throw new AppError("INVALID_AMOUNT", "Enter an amount.", 422);
  return json({ quote: await swapQuote(direction, units), nimDecimals: cfg.nimDecimals });
});
