import { z } from "zod";
import { createCircle, listCircles } from "@/lib/server/circles";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Create = z.object({
  name: z.string().trim().min(2).max(40),
  currency: z.enum(["NIM", "USDT"]),
  amount: z.number().positive().max(100_000_000),
  frequency: z.enum(["weekly", "monthly"]),
  startAt: z.string().datetime({ offset: true }),
  members: z.array(z.string().trim().min(1).max(32)).min(1).max(19),
});

export const POST = handler(async (req) => {
  enforceRateLimit(req, "circles:create", 10, 60);
  const user = await requireUser();
  const body = await parseBody(req, Create);
  return json({ circle: await createCircle(user.id, body) }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "circles:list", 60, 60);
  const user = await requireUser();
  return json({ circles: await listCircles(user.id) });
});
