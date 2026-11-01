import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { createRecurring, listRecurring } from "@/lib/server/recurring";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Create = z
  .object({
    orderId: z.string().uuid().optional(),
    transferId: z.string().uuid().optional(),
    frequency: z.enum(["once", "weekly", "monthly"]),
    firstDueAt: z.string().datetime({ offset: true }),
  })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.transferId), { message: "Give either orderId or transferId." });

/** Creates a reminder that repeats a real past payment (bill or @username transfer). */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "recurring:create", 20, 60);
  const user = await requireUser();
  const body = await parseBody(req, Create);
  return json({ item: await createRecurring(user.id, body) }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "recurring:list", 60, 60);
  const user = await requireUser();
  return json({ items: await listRecurring(user.id) });
});
