import { config } from "@/lib/server/config";
import { enforceRateLimit, handler, json, requireAdmin } from "@/lib/server/http";
import { adminListReview } from "@/lib/server/orders/utility";

export const dynamic = "force-dynamic";

/** Orders needing attention: requires_review, provider_pending, payment_pending. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "admin", 30, 60);
  requireAdmin(req, config.adminToken);
  return json({ orders: await adminListReview() });
});
