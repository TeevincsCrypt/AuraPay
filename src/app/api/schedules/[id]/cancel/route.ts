import { z } from "zod";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { cancelSchedule } from "@/lib/server/orders/schedules";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Stops future runs. Unused prepaid runs are owed back and refunded to the paying wallet. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "schedules:cancel", 20, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("SCHEDULE_NOT_FOUND", "Schedule not found.", 404);
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  return json({ schedule: await cancelSchedule(user.id, id, body.reason === "insufficient_funds" ? "insufficient_funds" : undefined) });
});
