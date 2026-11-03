import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { recordLock } from "@/lib/server/savings";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  txHash: z.string().trim().length(66),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  label: z.string().trim().max(40).nullish(),
});

/** Records a lock() your wallet sent to the Savings Vault; it's confirmed from the receipt. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "savings:lock", 30, 60);
  const user = await requireUser();
  const body = await parseBody(req, Body);
  return json({ lock: await recordLock(user.id, body) }, { status: 201 });
});
