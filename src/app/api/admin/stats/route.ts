import { adminStats } from "@/lib/server/admin-stats";
import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, requireAdmin } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Operator dashboard: user counts, signups, activity and recent users. Needs ADMIN_API_TOKEN. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  return json({ stats: await adminStats() });
});
