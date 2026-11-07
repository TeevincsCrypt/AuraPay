import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { listLocks, savingsStatus } from "@/lib/server/savings";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Savings configuration and your locks (refreshed from Polygon where needed). */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "savings:list", 120, 60);
  const user = await requireUser();
  const info = await savingsStatus();
  return json({ savings: info, locks: info.enabled ? await listLocks(user.id) : [] });
});
