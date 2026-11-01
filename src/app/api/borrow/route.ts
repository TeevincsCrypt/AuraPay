import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { getBorrowOverview } from "@/lib/server/lending";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "borrow", 60, 60);
  const user = await requireUser();
  return json(await getBorrowOverview(user.id));
});
