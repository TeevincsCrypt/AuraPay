import { getDb } from "@/lib/server/db";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { listActivity } from "@/lib/server/ledger";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "activity", 60, 60);
  const user = await requireUser();
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return json({ items: await listActivity(await getDb(), user.id, Number.isFinite(limit) ? limit : 50) });
});
