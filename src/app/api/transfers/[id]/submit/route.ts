import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { submitTransfer } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

const Body = z.object({ txHash: z.string().trim().min(64).max(80) });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "transfers:submit", 30, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("TRANSFER_NOT_FOUND", "Transfer not found.", 404);
  const user = await requireUser();
  const { txHash } = await parseBody(req, Body);
  return json({ transfer: await submitTransfer(user.id, id, txHash) });
});
