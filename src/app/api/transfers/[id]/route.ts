import { z } from "zod";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { advanceTransfer } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

/** Returns the transfer after re-checking it on-chain if still pending. */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "transfers:get", 120, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("TRANSFER_NOT_FOUND", "Transfer not found.", 404);
  const user = await requireUser();
  return json({ transfer: await advanceTransfer(user.id, id) });
});
