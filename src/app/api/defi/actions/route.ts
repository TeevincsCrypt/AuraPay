import { z } from "zod";
import { SWAP_DIRECTIONS } from "@/lib/shared/polygon-defi";
import { recordAction } from "@/lib/server/defi/polygon";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["earn_supply", "earn_withdraw", "swap"]),
  txHash: z.string().trim().min(66).max(66),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  direction: z.enum(SWAP_DIRECTIONS).optional(),
});

/** Records a wallet-sent Aave/QuickSwap transaction; it's verified from its Polygon receipt. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "defi:record", 30, 60);
  const user = await requireUser();
  const body = await parseBody(req, Body);
  return json({ action: await recordAction(user.id, body) }, { status: 201 });
});
