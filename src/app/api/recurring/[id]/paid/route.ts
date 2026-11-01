import { z } from "zod";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { markRecurringPaid } from "@/lib/server/recurring";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Settles the current due date if a matching verified payment exists. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "recurring:paid", 30, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Reminder not found.", 404);
  const user = await requireUser();
  return json({ item: await markRecurringPaid(user.id, id) });
});
