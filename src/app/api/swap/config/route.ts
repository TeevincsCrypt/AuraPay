import { swapConfig } from "@/lib/server/defi/polygon";
import { enforceRateLimit, handler, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Whether the QuickSwap NIM ↔ USDT swap is available (NIM on Polygon + a pool with liquidity). */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "swap:config", 60, 60);
  return json({ swap: await swapConfig() });
});
