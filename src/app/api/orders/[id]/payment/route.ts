import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { submitPayment } from "@/lib/server/orders/utility";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ txHash: z.string().trim().max(80).optional() });

/**
 * Registers the wallet transaction for an order. The client's word is never
 * trusted: the server verifies the transaction on-chain before fulfilment.
 */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "orders:pay", 20, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  const user = await requireUser();
  const { txHash } = await parseBody(req, Body);
  return json({ order: await submitPayment(user.id, id, txHash) });
});
