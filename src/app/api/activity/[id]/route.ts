import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { mapLedgerRow } from "@/lib/server/ledger";
import { getOrder } from "@/lib/server/orders/utility";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "activity", 60, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Not found.", 404);
  const user = await requireUser();
  const db = await getDb();
  const rows = await db.query("select * from transactions where id = $1 and user_id = $2", [id, user.id]);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Not found.", 404);
  let item = mapLedgerRow(rows[0]);
  // For utility orders, include the live order (advancing it if still in flight).
  let order = null;
  if (item.sourceTable === "utility_orders" && item.category === "utility_purchase") {
    order = await getOrder(user.id, item.sourceId);
    const fresh = await db.query("select * from transactions where id = $1", [id]);
    item = mapLedgerRow(fresh[0]);
  }
  return json({ item, order });
});
