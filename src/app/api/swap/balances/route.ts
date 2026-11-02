import { z } from "zod";
import { verifiedEvmAddresses } from "@/lib/server/auth/challenges";
import { swapBalances } from "@/lib/server/defi/polygon";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Query = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "swap:balances", 60, 60);
  const user = await requireUser();
  const { address } = parseQuery(req.url, Query);
  if (!(await verifiedEvmAddresses(user.id)).includes(address.toLowerCase())) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet first.", 422);
  return json({ balances: await swapBalances(address) });
});
