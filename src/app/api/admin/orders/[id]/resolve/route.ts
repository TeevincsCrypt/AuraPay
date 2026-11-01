import { z } from "zod";
import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, parseBody, requireAdmin } from "@/lib/server/http";
import { adminResolve } from "@/lib/server/orders/utility";

export const dynamic = "force-dynamic";

const Body = z.object({ status: z.enum(["successful", "failed"]), note: z.string().trim().min(3).max(400) });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  const { id } = await ctx.params;
  const { status, note } = await parseBody(req, Body);
  return json({ order: await adminResolve(id, status, note) });
});
