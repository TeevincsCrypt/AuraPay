import { z } from "zod";
import { completeLocalSignIn } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const Hex = z.string().trim().regex(/^(0x)?[0-9a-fA-F]+$/).max(200);
const Body = z.object({ challengeId: z.string().uuid(), publicKey: Hex, signature: Hex });

/** Completes an in-app sign-in with the result of nimiq.sign(message). */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:verify", 20, 60);
  const { challengeId, publicKey, signature } = await parseBody(req, Body);
  const user = await completeLocalSignIn(challengeId, publicKey, signature, req.headers.get("user-agent"));
  return json({ user: { address: user.nimiqAddress } });
});
