import { z } from "zod";
import { getCircle } from "@/lib/server/circles";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "circles:get", 120, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("CIRCLE_NOT_FOUND", "Savings circle not found.", 404);
  const user = await requireUser();
  return json({ circle: await getCircle(user.id, id) });
});
