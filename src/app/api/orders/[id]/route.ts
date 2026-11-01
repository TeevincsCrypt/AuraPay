import { z } from "zod";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { getOrder } from "@/lib/server/orders/utility";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Returns the order after advancing it (payment verification / provider status polling). */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "orders:get", 120, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  const user = await requireUser();
  return json({ order: await getOrder(user.id, id) });
});
