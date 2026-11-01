import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { submitSchedulePayment } from "@/lib/server/orders/schedules";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ txHash: z.string().trim().min(64).max(80) });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "schedules:pay", 20, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("SCHEDULE_NOT_FOUND", "Schedule not found.", 404);
  const user = await requireUser();
  const { txHash } = await parseBody(req, Body);
  return json({ schedule: await submitSchedulePayment(user.id, id, txHash) });
});
