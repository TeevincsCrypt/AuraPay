import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { getPortfolio, investingStatus } from "@/lib/server/investing";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Holdings read on-chain from the user's verified wallets (plus collateral supplied to Aave). */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "portfolio", 30, 60);
  const user = await requireUser();
  return json({ portfolio: await getPortfolio(user.id), investing: investingStatus() });
});
