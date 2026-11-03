import { z } from "zod";
import { enabledPair, swapQuote } from "@/lib/server/defi/polygon";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { directionAssets, SWAP_DIRECTIONS, toUnits } from "@/lib/shared/polygon-defi";

export const dynamic = "force-dynamic";

const Query = z.object({ direction: z.enum(SWAP_DIRECTIONS), amount: z.string().regex(/^\d+(\.\d+)?$/) });

/** Live QuickSwap quote from the router's getAmountsOut. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "swap:quote", 120, 60);
  const { direction, amount } = parseQuery(req.url, Query);
  const cfg = await enabledPair(direction);
  const units = toUnits(amount, directionAssets(direction).from === "USDT" ? 6 : cfg.decimals);
  if (units <= 0n) throw new AppError("INVALID_AMOUNT", "Enter an amount.", 422);
  return json({ quote: await swapQuote(direction, units) });
});
