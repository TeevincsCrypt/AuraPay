import { z } from "zod";
import { approveRemoteSignIn } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const Hex = z.string().trim().regex(/^(0x)?[0-9a-fA-F]+$/).max(200);
const Body = z.object({ code: z.string().max(20), publicKey: Hex, signature: Hex });

/** Called inside Nimiq Pay after the user signs the remote request's message. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:approve", 10, 60);
  const { code, publicKey, signature } = await parseBody(req, Body);
  const user = await approveRemoteSignIn(code, publicKey, signature, req.headers.get("user-agent"));
  return json({ approved: true, user: { address: user.nimiqAddress } });
});
