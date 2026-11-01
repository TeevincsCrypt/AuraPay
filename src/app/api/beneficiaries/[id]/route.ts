import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const DELETE = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "beneficiaries", 60, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Not found.", 404);
  const user = await requireUser();
  const db = await getDb();
  const rows = await db.query("delete from saved_beneficiaries where id = $1 and user_id = $2 returning id", [id, user.id]);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Not found.", 404);
  return json({ ok: true });
});
