import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { recordLendingAction, refreshLendingAction } from "@/lib/server/lending";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["approve", "supply", "withdraw", "borrow", "repay", "set_collateral"]),
  reserveId: z.number().int().min(0).max(1000).nullable(),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  amountAtomic: z.string().regex(/^\d{1,78}$/).nullable(),
});

/** Records an Aave V4 transaction the user's wallet submitted; verified via its on-chain receipt. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "borrow:action", 30, 60);
  const user = await requireUser();
  return json(await recordLendingAction(user.id, await parseBody(req, Body)), { status: 201 });
});

const Query = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "borrow:action", 120, 60);
  const user = await requireUser();
  const { txHash } = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return json(await refreshLendingAction(user.id, txHash));
});
