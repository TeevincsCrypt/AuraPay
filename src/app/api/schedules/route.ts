import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { createSchedule, listSchedules } from "@/lib/server/orders/schedules";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const CreateSchedule = z.object({
  clientRequestId: z.string().uuid(),
  service: z.enum(["airtime", "data", "electricity", "cable", "internet"]),
  countryCode: z.enum(TARGET_COUNTRY_CODES),
  operatorCode: z.string().trim().min(1).max(64),
  productCode: z.string().trim().max(64).optional(),
  recipient: z.string().trim().min(5).max(30),
  recipientLabel: z.string().trim().max(60).optional(),
  amount: z.number().positive().max(1_000_000),
  amountCurrency: z.enum(["local", "sender"]),
  payCurrency: z.enum(["NIM", "USDT"]),
  payerAddress: z.string().trim().max(64).optional(),
  frequency: z.enum(["once", "weekly", "monthly"]),
  totalRuns: z.number().int().min(1).max(12),
  startAt: z.string().datetime({ offset: true }),
});

/** Creates a priced, prepaid schedule quote (all runs paid in one transaction). */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "schedules:create", 10, 60);
  const user = await requireUser();
  const body = await parseBody(req, CreateSchedule);
  return json({ schedule: await createSchedule(user.id, body) }, { status: 201 });
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "schedules:list", 60, 60);
  const user = await requireUser();
  return json({ schedules: await listSchedules(user.id) });
});
