import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { DISPLAY_CURRENCIES } from "@/lib/server/fiat";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ currency: z.enum(DISPLAY_CURRENCIES) });

/** Sets the fiat currency amounts are also shown in. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "me:display", 20, 60);
  const user = await requireUser();
  const { currency } = await parseBody(req, Body);
  const db = await getDb();
  await db.query("update users set display_currency = $2 where id = $1", [user.id, currency]);
  return json({ displayCurrency: currency });
});
