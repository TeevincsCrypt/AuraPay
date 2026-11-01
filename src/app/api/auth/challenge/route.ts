import { z } from "zod";
import { createSignInChallenge } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json, parseBody, publicOrigin } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const Body = z.object({ mode: z.enum(["local", "remote"]) });

/**
 * Starts a Nimiq Pay sign-in.
 *  local  → returns the message to sign with nimiq.sign() in this browser.
 *  remote → returns a short code + deep link to approve inside Nimiq Pay, and a
 *           secret poll token (only this browser can collect the resulting session).
 */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "auth:challenge", 20, 60);
  const { mode } = await parseBody(req, Body);
  const origin = publicOrigin(req);
  const host = new URL(origin).host;
  const ch = await createSignInChallenge(mode, host, req.headers.get("user-agent"));
  if (mode === "local") return json({ id: ch.id, message: ch.message, expiresAt: ch.expiresAt });
  const approvePath = `/auth/approve?code=${encodeURIComponent(ch.code!)}`;
  return json({
    id: ch.id,
    code: ch.code,
    pollToken: ch.pollToken,
    expiresAt: ch.expiresAt,
    // Nimiq Pay's mini-app deep link keeps path + query (nimiq-pay-app mini-app-deeplink.ts).
    deepLink: `https://nimpay.app/miniapps/open/${host}${approvePath}`,
    approveUrl: `${origin}${approvePath}`,
  });
});
