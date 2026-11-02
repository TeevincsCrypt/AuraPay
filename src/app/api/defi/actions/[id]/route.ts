import { z } from "zod";
import { getAction } from "@/lib/server/defi/polygon";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "defi:get", 120, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Not found.", 404);
  const user = await requireUser();
  return json({ action: await getAction(user.id, id) });
});
