import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { openSimulatedLoan } from "@/lib/server/lending";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  amountUsdt: z.number().min(10).max(1_000_000),
  termDays: z.number().int(),
  collateral: z.array(z.object({ symbol: z.string().regex(/^[A-Z.]{1,8}$/), quantity: z.number().positive() })).min(1).max(10),
  simulated: z.literal(true),
});

export const POST = handler(async (req) => {
  enforceRateLimit(req, "borrow:open", 10, 60);
  const user = await requireUser();
  const body = await parseBody(req, Body);
  return json({ ...(await openSimulatedLoan(user.id, body)), simulated: true }, { status: 201 });
});
