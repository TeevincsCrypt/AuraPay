import "server-only";
import { getDb, iso, num, type Db } from "./db";
import { AppError } from "./http";
import { log } from "./log";
import { SERVICE_LABEL } from "./orders/utility";
import type { UtilityService } from "@/lib/shared/types";

/**
 * Recurring payments & bill reminders.
 *
 * Self-custodial wallets can't be charged automatically, so a recurring item becomes due on
 * its schedule and is paid with one tap (the bill or transfer is prefilled). It advances
 * only when a matching *verified* payment exists: a successful bill order for the same
 * service/recipient, or a confirmed transfer to the same @username. (For bills that should
 * pay themselves, the prepaid Autopay schedules remain available.)
 */

export type Frequency = "once" | "weekly" | "monthly";

export interface BillPayload {
  service: UtilityService;
  countryCode: string;
  operatorCode: string;
  operatorName: string;
  productCode?: string;
  recipient: string;
  recipientLabel?: string;
  amount: number;
  amountCurrency: "local" | "sender";
  amountLocal: number | null;
  localCurrency: string | null;
  productDescription: string | null;
}
export interface TransferPayload {
  toUsername: string;
  currency: "NIM" | "USDT";
  amount: number;
  note?: string;
}

type Row = { id: string; user_id: string; kind: "bill" | "transfer"; title: string; payload: unknown; frequency: Frequency; next_due_at: string | null; active: boolean; last_paid_at: string | null; times_paid: number; created_at: string };

export interface RecurringDTO {
  id: string;
  kind: "bill" | "transfer";
  title: string;
  payload: BillPayload | TransferPayload;
  frequency: Frequency;
  nextDueAt: string | null;
  active: boolean;
  lastPaidAt: string | null;
  timesPaid: number;
  due: "overdue" | "today" | "soon" | "later" | null;
  payUrl: string;
}

const DAY = 86_400_000;

export function addInterval(d: Date, f: Frequency, n = 1): Date {
  const out = new Date(d);
  if (f === "weekly") out.setUTCDate(out.getUTCDate() + 7 * n);
  else if (f === "monthly") {
    const day = out.getUTCDate();
    out.setUTCDate(1);
    out.setUTCMonth(out.getUTCMonth() + n);
    const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
    out.setUTCDate(Math.min(day, last));
  }
  return out;
}

function payloadOf(r: Row): BillPayload | TransferPayload {
  return (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as BillPayload | TransferPayload;
}

function dueState(next: string | null, active: boolean): RecurringDTO["due"] {
  if (!active || !next) return null;
  const t = new Date(next).getTime();
  const now = Date.now();
  if (t < now - DAY / 2) return "overdue";
  if (t <= now + DAY / 2) return "today";
  if (t <= now + 3 * DAY) return "soon";
  return "later";
}

function payUrl(r: Row): string {
  const p = payloadOf(r);
  if (r.kind === "transfer") {
    const t = p as TransferPayload;
    const qs = new URLSearchParams({ to: t.toUsername, currency: t.currency, amount: String(t.amount), ...(t.note ? { note: t.note } : {}), recurring: r.id });
    return `/send?${qs}`;
  }
  return `/pay?recurring=${r.id}`;
}

function toDTO(r: Row): RecurringDTO {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    payload: payloadOf(r),
    frequency: r.frequency,
    nextDueAt: iso(r.next_due_at),
    active: r.active,
    lastPaidAt: iso(r.last_paid_at),
    timesPaid: Number(r.times_paid),
    due: dueState(iso(r.next_due_at), r.active),
    payUrl: payUrl(r),
  };
}

// ---------------------------------------------------------------------------
// Create from a real payment
// ---------------------------------------------------------------------------

export async function createRecurring(
  userId: string,
  input: { orderId?: string; transferId?: string; frequency: Frequency; firstDueAt: string },
): Promise<RecurringDTO> {
  const db = await getDb();
  const first = new Date(input.firstDueAt);
  if (Number.isNaN(first.getTime())) throw new AppError("INVALID_DATE", "Choose a valid date.", 422);
  if (first.getTime() < Date.now() - DAY) throw new AppError("DATE_IN_PAST", "Choose today or a future date.", 422);
  if (first.getTime() > Date.now() + 400 * DAY) throw new AppError("DATE_TOO_FAR", "Choose a date within a year.", 422);

  let kind: "bill" | "transfer";
  let title: string;
  let payload: BillPayload | TransferPayload;
  if (input.orderId) {
    const o = (await db.query<Record<string, unknown>>("select * from utility_orders where id = $1 and user_id = $2", [input.orderId, userId]))[0];
    if (!o) throw new AppError("ORDER_NOT_FOUND", "Payment not found.", 404);
    const service = o.service as UtilityService;
    const useLocal = Boolean(o.use_local_amount);
    kind = "bill";
    payload = {
      service,
      countryCode: String(o.country_code),
      operatorCode: String(o.operator_code ?? o.operator_id ?? ""),
      operatorName: String(o.operator_name),
      ...(["data", "cable", "internet"].includes(service) && o.item_code ? { productCode: String(o.item_code) } : {}),
      recipient: String(o.recipient),
      ...(o.recipient_label ? { recipientLabel: String(o.recipient_label) } : {}),
      amount: useLocal && o.amount_local !== null ? num(o.amount_local) : num(o.amount_sender),
      amountCurrency: useLocal && o.amount_local !== null ? "local" : "sender",
      amountLocal: o.amount_local !== null ? num(o.amount_local) : null,
      localCurrency: (o.local_currency as string) ?? null,
      productDescription: (o.product_description as string) ?? null,
    };
    const who = (o.recipient_label as string) || (service === "airtime" || service === "data" ? `+${o.recipient}` : String(o.recipient));
    title = `${SERVICE_LABEL[service]} · ${o.operator_name} · ${who}`;
  } else if (input.transferId) {
    const t = (await db.query<Record<string, unknown>>("select * from transfers where id = $1 and from_user_id = $2", [input.transferId, userId]))[0];
    if (!t) throw new AppError("TRANSFER_NOT_FOUND", "Transfer not found.", 404);
    const to = (await db.query<{ username: string | null }>("select username from users where id = $1", [t.to_user_id]))[0]?.username;
    if (!to) throw new AppError("USER_NOT_FOUND", "Recipient no longer has a username.", 409);
    kind = "transfer";
    payload = { toUsername: to, currency: t.currency as "NIM" | "USDT", amount: num(t.amount), ...(t.note ? { note: String(t.note) } : {}) };
    title = `@${to} · ${num(t.amount)} ${t.currency}${t.note ? ` · ${t.note}` : ""}`;
  } else {
    throw new AppError("SOURCE_REQUIRED", "Choose a payment to repeat.", 422);
  }

  const count = Number((await db.query<{ n: string }>("select count(*)::text as n from recurring_items where user_id = $1 and active", [userId]))[0].n);
  if (count >= 50) throw new AppError("TOO_MANY", "You can have up to 50 active reminders.", 422);

  const rows = await db.query<Row>(
    "insert into recurring_items (user_id, kind, title, payload, frequency, next_due_at) values ($1,$2,$3,$4,$5,$6) returning *",
    [userId, kind, title.slice(0, 120), JSON.stringify(payload), input.frequency, first],
  );
  log.info("recurring.created", { kind, frequency: input.frequency });
  return toDTO(rows[0]);
}

// ---------------------------------------------------------------------------
// Matching payments advance the item
// ---------------------------------------------------------------------------

/** Finds a verified payment that settles this item's current due date. */
async function findSettlingPayment(db: Db, r: Row): Promise<string | null> {
  if (!r.next_due_at) return null;
  const p = payloadOf(r);
  // A payment counts from a few days before the due date (people pay early), and after the last one.
  const windowStart = new Date(Math.max(new Date(r.next_due_at).getTime() - 5 * DAY, r.last_paid_at ? new Date(r.last_paid_at).getTime() + 1 : 0, new Date(r.created_at).getTime()));
  if (r.kind === "bill") {
    const b = p as BillPayload;
    const rows = await db.query<{ ref: string }>(
      `select ref from utility_orders where user_id = $1 and service = $2 and recipient = $3 and country_code = $4
         and status = 'successful' and coalesce(fulfilled_at, updated_at) >= $5
       order by created_at limit 1`,
      [r.user_id, b.service, b.recipient, b.countryCode, windowStart],
    );
    return rows[0]?.ref ?? null;
  }
  const t = p as TransferPayload;
  const rows = await db.query<{ ref: string }>(
    `select tr.ref from transfers tr join users u on u.id = tr.to_user_id
     where tr.from_user_id = $1 and u.username = $2 and tr.currency = $3 and tr.status = 'confirmed' and tr.confirmed_at >= $4
     order by tr.created_at limit 1`,
    [r.user_id, t.toUsername, t.currency, windowStart],
  );
  return rows[0]?.ref ?? null;
}

async function settle(db: Db, r: Row, paymentRef: string): Promise<Row> {
  let next: Date | null = null;
  if (r.frequency !== "once" && r.next_due_at) {
    next = addInterval(new Date(r.next_due_at), r.frequency);
    // Skip periods that are already in the past (e.g. a long-overdue item paid now).
    while (next.getTime() < Date.now() - DAY) next = addInterval(next, r.frequency);
  }
  const rows = await db.query<Row>(
    `update recurring_items set times_paid = times_paid + 1, last_paid_at = now(), last_payment_ref = $3,
       next_due_at = $4, active = $5, updated_at = now()
     where id = $1 and next_due_at = $2 returning *`,
    [r.id, r.next_due_at, paymentRef, next, next !== null],
  );
  if (rows[0]) log.info("recurring.paid", { id: r.id, ref: paymentRef });
  return rows[0] ?? r;
}

export async function listRecurring(userId: string): Promise<RecurringDTO[]> {
  const db = await getDb();
  const rows = await db.query<Row>("select * from recurring_items where user_id = $1 order by active desc, next_due_at nulls last, created_at desc limit 100", [userId]);
  const out: RecurringDTO[] = [];
  for (let r of rows) {
    // Anything paid through the normal flows also settles the reminder.
    if (r.active && r.next_due_at && new Date(r.next_due_at).getTime() <= Date.now() + 5 * DAY) {
      const ref = await findSettlingPayment(db, r);
      if (ref) r = await settle(db, r, ref);
    }
    out.push(toDTO(r));
  }
  return out;
}

async function loadOwned(db: Db, userId: string, id: string): Promise<Row> {
  const r = (await db.query<Row>("select * from recurring_items where id = $1 and user_id = $2", [id, userId]))[0];
  if (!r) throw new AppError("NOT_FOUND", "Reminder not found.", 404);
  return r;
}

export async function getRecurring(userId: string, id: string): Promise<RecurringDTO> {
  const db = await getDb();
  return toDTO(await loadOwned(db, userId, id));
}

/** Called after paying from a reminder; settles it only if a matching verified payment exists. */
export async function markRecurringPaid(userId: string, id: string): Promise<RecurringDTO> {
  const db = await getDb();
  const r = await loadOwned(db, userId, id);
  if (!r.active) return toDTO(r);
  const ref = await findSettlingPayment(db, r);
  if (!ref) throw new AppError("NO_MATCHING_PAYMENT", "No completed payment matching this reminder yet.", 409);
  return toDTO(await settle(db, r, ref));
}

export async function updateRecurring(userId: string, id: string, patch: { active?: boolean; frequency?: Frequency; nextDueAt?: string }): Promise<RecurringDTO> {
  const db = await getDb();
  const r = await loadOwned(db, userId, id);
  const next = patch.nextDueAt ? new Date(patch.nextDueAt) : r.next_due_at ? new Date(r.next_due_at) : null;
  if (patch.nextDueAt && Number.isNaN(next!.getTime())) throw new AppError("INVALID_DATE", "Choose a valid date.", 422);
  const active = patch.active ?? r.active;
  const rows = await db.query<Row>(
    "update recurring_items set active = $3, frequency = $4, next_due_at = $5, updated_at = now() where id = $1 and user_id = $2 returning *",
    [id, userId, active && next !== null, patch.frequency ?? r.frequency, next],
  );
  return toDTO(rows[0]);
}

export async function deleteRecurring(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.query("delete from recurring_items where id = $1 and user_id = $2", [id, userId]);
}

/** iCalendar file so the phone's own calendar reminds the user (with recurrence). */
export async function recurringIcs(userId: string, id: string, origin: string): Promise<string> {
  const db = await getDb();
  const r = await loadOwned(db, userId, id);
  if (!r.next_due_at) throw new AppError("NOT_SCHEDULED", "This reminder has no upcoming date.", 409);
  const start = new Date(r.next_due_at);
  const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const rrule = r.frequency === "weekly" ? "RRULE:FREQ=WEEKLY" : r.frequency === "monthly" ? "RRULE:FREQ=MONTHLY" : null;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AuraPay//Reminders//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${r.id}@aurapay`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(start)}`,
    `DTEND;VALUE=DATE:${ymd(new Date(start.getTime() + DAY))}`,
    ...(rrule ? [rrule] : []),
    `SUMMARY:${esc(`Pay: ${r.title}`)}`,
    `DESCRIPTION:${esc(`Pay it in AuraPay: ${origin}${payUrl(r)}`)}`,
    `URL:${origin}${payUrl(r)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(`AuraPay: ${r.title} is due`)}`,
    "TRIGGER:PT9H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
