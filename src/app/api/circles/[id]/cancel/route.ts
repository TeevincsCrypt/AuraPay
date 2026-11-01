import { z } from "zod";
import { cancelCircle } from "@/lib/server/circles";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "circles:cancel", 20, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("CIRCLE_NOT_FOUND", "Savings circle not found.", 404);
  const user = await requireUser();
  return json({ circle: await cancelCircle(user.id, id) });
});
