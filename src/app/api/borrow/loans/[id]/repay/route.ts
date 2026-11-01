import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { repaySimulatedLoan } from "@/lib/server/lending";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ amountUsdt: z.number().positive().max(10_000_000), simulated: z.literal(true) });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "borrow:repay", 20, 60);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("LOAN_NOT_FOUND", "Loan not found.", 404);
  const user = await requireUser();
  const { amountUsdt } = await parseBody(req, Body);
  return json({ ...(await repaySimulatedLoan(user.id, id, amountUsdt)), simulated: true });
});
