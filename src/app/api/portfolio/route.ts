import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { brokerageStatus, getPortfolio } from "@/lib/server/investing";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "portfolio", 60, 60);
  const user = await requireUser();
  return json({ portfolio: await getPortfolio(user.id), brokerage: brokerageStatus() });
});
