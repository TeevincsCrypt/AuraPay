import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { setUsername } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

const Body = z.object({ username: z.string().trim().min(1).max(32) });

/** Claims (or changes) the signed-in user's @username. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "me:username", 10, 60);
  const user = await requireUser();
  const { username } = await parseBody(req, Body);
  return json({ profile: await setUsername(user.id, username) });
});
