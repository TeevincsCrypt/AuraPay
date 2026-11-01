import { z } from "zod";
import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, parseBody, requireAdmin } from "@/lib/server/http";
import { adminRefundSchedule } from "@/lib/server/orders/schedules";

export const dynamic = "force-dynamic";

const Body = z.object({ refundTxHash: z.string().trim().min(64).max(80) });

/** Records the refund of a cancelled schedule's unused runs, verified on-chain first. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  const { id } = await ctx.params;
  const { refundTxHash } = await parseBody(req, Body);
  return json({ schedule: await adminRefundSchedule(id, refundTxHash) });
});
