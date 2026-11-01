import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { resolveUsername } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

/** Receiving addresses for a @username. Signed-in users only, rate limited. */
export const GET = handler(async (req, ctx: { params: Promise<{ username: string }> }) => {
  enforceRateLimit(req, "users:resolve", 30, 60);
  await requireUser();
  const { username } = await ctx.params;
  return json({ user: await resolveUsername(decodeURIComponent(username)) });
});
