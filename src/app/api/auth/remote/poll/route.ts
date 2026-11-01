import { z } from "zod";
import { pollRemoteSignIn } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().uuid(), pollToken: z.string().min(20).max(100) });

/** The waiting browser polls this; once approved it receives its own session cookie (single use). */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:poll", 90, 60);
  const { id, pollToken } = await parseBody(req, Body);
  return json(await pollRemoteSignIn(id, pollToken, req.headers.get("user-agent")));
});
