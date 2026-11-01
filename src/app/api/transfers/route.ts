import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { createTransfer, listTransfers, recentRecipients } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

const Create = z.object({
  toUsername: z.string().trim().min(1).max(32),
  currency: z.enum(["NIM", "USDT"]),
  amount: z.number().positive().max(100_000_000),
  note: z.string().trim().max(40).optional(),
  fromAddress: z.string().trim().max(64).optional(),
});

/** Creates a transfer intent: recipient address, exact amount and memo the wallet must send. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "transfers:create", 20, 60);
  const user = await requireUser();
  const body = await parseBody(req, Create);
  return json({ transfer: await createTransfer(user.id, body) }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "transfers:list", 60, 60);
  const user = await requireUser();
  const [transfers, recent] = await Promise.all([listTransfers(user.id), recentRecipients(user.id)]);
  return json({ transfers, recent });
});
