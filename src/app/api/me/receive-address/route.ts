import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { setReceiveEvmAddress } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

const Body = z.object({ address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/) });

/** Chooses which verified EVM wallet receives USDT sent to the user's @username. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "me:receive", 10, 60);
  const user = await requireUser();
  const { address } = await parseBody(req, Body);
  return json({ profile: await setReceiveEvmAddress(user.id, address) });
});
