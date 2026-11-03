import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { recordRelease } from "@/lib/server/savings";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ txHash: z.string().trim().length(66) });

/** Records a release() sent from your wallet after the unlock time; verified from the receipt. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "savings:release", 30, 60);
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Savings lock not found.", 404);
  const { txHash } = await parseBody(req, Body);
  return json({ lock: await recordRelease(user.id, id, txHash) });
});
