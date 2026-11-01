import { z } from "zod";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { brokerageStatus, estimateOrder } from "@/lib/server/investing";
import { config } from "@/lib/server/config";

export const dynamic = "force-dynamic";

const Body = z.object({
  symbol: z.string().regex(/^[A-Za-z.]{1,8}$/),
  notionalUsd: z.number().positive(),
  payCurrency: z.enum(["NIM", "USDT"]),
});

export const POST = handler(async (req) => {
  enforceRateLimit(req, "invest:estimate", 60, 60);
  const { symbol, notionalUsd, payCurrency } = await parseBody(req, Body);
  const estimate = await estimateOrder(symbol, notionalUsd, payCurrency);
  return json({ estimate, execution: { ...brokerageStatus(), simulatorAvailable: config.simulatorsAllowed } });
});
