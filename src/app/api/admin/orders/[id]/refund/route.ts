import { z } from "zod";
import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, parseBody, requireAdmin } from "@/lib/server/http";
import { adminRecordRefund } from "@/lib/server/orders/utility";

export const dynamic = "force-dynamic";

const Body = z.object({ refundTxHash: z.string().trim().min(64).max(80) });

/**
 * Records a refund for an order requiring review. The operator sends the refund
 * from the merchant wallet (AuraPay never holds signing keys server-side), then
 * submits the tx hash here; it is verified on-chain before the order is marked refunded.
 */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  const { id } = await ctx.params;
  const { refundTxHash } = await parseBody(req, Body);
  return json({ order: await adminRecordRefund(id, refundTxHash) });
});
