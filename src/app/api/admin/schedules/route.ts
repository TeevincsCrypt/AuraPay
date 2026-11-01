import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, requireAdmin } from "@/lib/server/http";
import { adminListSchedules } from "@/lib/server/orders/schedules";

export const dynamic = "force-dynamic";

/** Schedules needing operator attention: refunds owed after cancellation, or payment problems. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  return json({ schedules: await adminListSchedules() });
});
