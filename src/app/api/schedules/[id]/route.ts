import { z } from "zod";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { advanceSchedule } from "@/lib/server/orders/schedules";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Returns the schedule after advancing it (payment verification, a due first run). */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "schedules:get", 120, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("SCHEDULE_NOT_FOUND", "Schedule not found.", 404);
  const user = await requireUser();
  return json({ schedule: await advanceSchedule(user.id, id) });
});
