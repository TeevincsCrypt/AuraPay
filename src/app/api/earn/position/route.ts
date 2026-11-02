import { z } from "zod";
import { verifiedEvmAddresses } from "@/lib/server/auth/challenges";
import { earnPosition } from "@/lib/server/defi/polygon";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { errorMessage } from "@/lib/server/log";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Query = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

/** Live Aave position for one of the user's verified Polygon wallets. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "earn:position", 60, 60);
  const user = await requireUser();
  const { address } = parseQuery(req.url, Query);
  if (!(await verifiedEvmAddresses(user.id)).includes(address.toLowerCase())) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet first.", 422);
  try {
    return json({ position: await earnPosition(address) });
  } catch (err) {
    throw new AppError("CHAIN_UNAVAILABLE", `Couldn't read your position from Polygon: ${errorMessage(err)}`, 503);
  }
});
