import { z } from "zod";
import { verifiedEvmAddresses } from "@/lib/server/auth/challenges";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { vaultAllowance } from "@/lib/server/savings";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Query = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "savings:allowance", 60, 60);
  const user = await requireUser();
  const { address } = parseQuery(req.url, Query);
  if (!(await verifiedEvmAddresses(user.id)).includes(address.toLowerCase())) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet first.", 422);
  return json({ allowance: await vaultAllowance(address) });
});
