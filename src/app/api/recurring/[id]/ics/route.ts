import { z } from "zod";
import { AppError, enforceRateLimit, handler, publicOrigin } from "@/lib/server/http";
import { recurringIcs } from "@/lib/server/recurring";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Calendar file (with repeat rule and alert) so the phone reminds the user. */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "recurring:ics", 30, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Reminder not found.", 404);
  const user = await requireUser();
  const body = await recurringIcs(user.id, id, publicOrigin(req));
  return new Response(body, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="aurapay-reminder.ics"`, "Cache-Control": "no-store" },
  });
});
