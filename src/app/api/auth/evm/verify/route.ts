import { z } from "zod";
import { completeEvmLink } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(300) });

export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:evm", 20, 60);
  const user = await requireUser();
  const { challengeId, signature } = await parseBody(req, Body);
  return json(await completeEvmLink(user, challengeId, signature));
});
