import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { createUtilityOrder, listOrders } from "@/lib/server/orders/utility";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const CreateOrder = z.object({
  clientRequestId: z.string().uuid(),
  service: z.enum(["airtime", "data", "electricity"]),
  countryCode: z.enum(TARGET_COUNTRY_CODES),
  operatorCode: z.string().trim().min(1).max(64),
  productCode: z.string().trim().max(64).optional(),
  recipient: z.string().trim().min(5).max(30),
  recipientLabel: z.string().trim().max(60).optional(),
  amount: z.number().positive().max(1_000_000),
  amountCurrency: z.enum(["local", "sender"]),
  payCurrency: z.enum(["NIM", "USDT"]),
  payerAddress: z.string().trim().max(64).optional(),
  saveBeneficiary: z.boolean().optional(),
});

/** Creates a priced, time-limited quote. Prices are always computed server-side from fresh provider data. */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "orders:create", 15, 60);
  const user = await requireUser();
  const body = await parseBody(req, CreateOrder);
  const order = await createUtilityOrder(user.id, body);
  return json({ order }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "orders:list", 60, 60);
  const user = await requireUser();
  return json({ orders: await listOrders(user.id) });
});
