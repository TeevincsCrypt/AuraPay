import { getDb, iso, numOrNull } from "@/lib/server/db";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "beneficiaries", 60, 60);
  const user = await requireUser();
  const db = await getDb();
  const rows = await db.query(
    "select * from saved_beneficiaries where user_id = $1 order by coalesce(last_used_at, created_at) desc limit 50",
    [user.id],
  );
  return json({
    beneficiaries: rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as "phone" | "meter",
      countryCode: String(r.country_code),
      label: String(r.label),
      value: String(r.value),
      operatorId: numOrNull(r.operator_id),
      operatorName: (r.operator_name as string) ?? null,
      lastUsedAt: iso(r.last_used_at),
    })),
  });
});
