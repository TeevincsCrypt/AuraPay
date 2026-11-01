import { z } from "zod";
import { respondToInvite } from "@/lib/server/circles";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ accept: z.boolean() });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "circles:respond", 30, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("CIRCLE_NOT_FOUND", "Savings circle not found.", 404);
  const user = await requireUser();
  const { accept } = await parseBody(req, Body);
  return json({ circle: await respondToInvite(user.id, id, accept) });
});
