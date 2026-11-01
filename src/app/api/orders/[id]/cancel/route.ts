import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { cancelUnpaidOrder } from "@/lib/server/orders/utility";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.enum(["insufficient_funds", "cancelled"]) });

/** Closes an unpaid quote (only from "quoted"; anything paid is never affected). */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "orders:cancel", 30, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  const user = await requireUser();
  const { reason } = await parseBody(req, Body);
  return json({ order: await cancelUnpaidOrder(user.id, id, reason) });
});
