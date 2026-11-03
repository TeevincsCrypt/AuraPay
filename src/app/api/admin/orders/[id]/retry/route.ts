import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, requireAdmin } from "@/lib/server/http";
import { adminRetry } from "@/lib/server/orders/utility";

export const dynamic = "force-dynamic";

/** Re-sends a paid order the provider rejected (nothing delivered), under a new provider reference. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  const { id } = await ctx.params;
  return json({ order: await adminRetry(id) });
});
