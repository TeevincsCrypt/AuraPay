import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { listTrades, recordTrade, refreshTrades } from "@/lib/server/investing";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Atomic = z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,78}$/));
const Body = z.object({
  symbol: z.string().regex(/^[A-Za-z.]{1,8}$/),
  orderUid: z.string().regex(/^0x[0-9a-fA-F]{112}$/),
  chainId: z.number().int().positive(),
  destinationChainId: z.number().int().positive().nullable().optional(),
  owner: Addr,
  inputToken: z.object({ address: z.string().max(64), symbol: z.string().max(20), decimals: z.number().int().min(0).max(36) }),
  inputAmount: Atomic,
  outputToken: z.object({ address: z.string().max(64) }),
  outputAmount: Atomic,
});

/** Records a CoW order posted from the embedded widget; status is then verified against CoW's order book. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "invest:trade", 20, 60);
  const user = await requireUser();
  const body = await parseBody(req, Body);
  return json(await recordTrade(user.id, body), { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "invest:list", 60, 60);
  const user = await requireUser();
  await refreshTrades(user.id).catch(() => {});
  return json({ trades: await listTrades(user.id) });
});
