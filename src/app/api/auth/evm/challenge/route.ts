import { z } from "zod";
import { createEvmLinkChallenge } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody, publicOrigin } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

/** Message for personal_sign that proves control of an EVM address (USDT on Polygon). */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:evm", 20, 60);
  const user = await requireUser();
  const { address } = await parseBody(req, Body);
  return json(await createEvmLinkChallenge(user, address, new URL(publicOrigin(req)).host));
});
