import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { listStockOrders, placeSimulatedOrder } from "@/lib/server/investing";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  symbol: z.string().regex(/^[A-Za-z.]{1,8}$/),
  notionalUsd: z.number().min(1).max(10_000),
  payCurrency: z.enum(["NIM", "USDT"]),
  clientRequestId: z.string().uuid(),
  /** Explicit acknowledgement that this is a simulation. */
  simulated: z.literal(true),
});

export const POST = handler(async (req) => {
  enforceRateLimit(req, "invest:order", 20, 60);
  const user = await requireUser();
  const body = await parseBody(req, Body);
  const result = await placeSimulatedOrder(user.id, body);
  return json({ ...result, simulated: true }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "invest:list", 60, 60);
  const user = await requireUser();
  return json({ orders: await listStockOrders(user.id) });
});
