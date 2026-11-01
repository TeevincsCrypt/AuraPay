import { lookupRemoteChallenge } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Shows the pending remote sign-in (message + requesting device) before approval in Nimiq Pay. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "auth:lookup", 20, 60);
  const code = new URL(req.url).searchParams.get("code") ?? "";
  return json(await lookupRemoteChallenge(code));
});
