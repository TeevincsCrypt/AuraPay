import "server-only";
import { randomInt } from "node:crypto";
import type { ActivityStatus, BillScheduleDTO, PayCurrency, ScheduleFrequency, ScheduleRunDTO, ScheduleStatus, UtilityOrderStatus, UtilityService } from "@/lib/shared/types";
import { countryByCode } from "@/lib/shared/countries";
import { config } from "../config";
import { getDb, iso, num, numOrNull, type Db } from "../db";
import { AppError } from "../http";
import { insertLedger, newRef, updateLedgerBySource } from "../ledger";
import { errorMessage, log } from "../log";
import { paymentRails } from "../rails";
import { verifiedEvmAddresses } from "../auth/challenges";
import { convertUsd, getRates } from "../rates";
import { normaliseNimAddress, verifyNimiqTransfer } from "../payments/nimiq";
import { isEvmAddress, verifyPolygonUsdtTransfer } from "../payments/polygon";
import { requireUtilityProvider, roundUpCents, toAppError, type Priced } from "../utilities/provider";
import { expireStaleQuotes, processOrder, SERVICE_LABEL, verifyPayment, type CreateOrderInput } from "./utility";

/**
 * Scheduled bills.
 *
 * A schedule is prepaid: the user pays for every run in one on-chain payment, verified
 * exactly like a normal order. AuraPay can't pull money from a self-custodial wallet later,
 * so prepaying is what makes runs automatic. At each run time the runner creates a normal,
 * already-paid utility order ((schedule, run) is unique, so a run is created at most once)
 * and fulfils it through the usual exactly-once path, including review and refunds.
 *
 *   quoted ─(tx)─▶ payment_pending ─(verified)─▶ active ─(last run)─▶ completed
 *   active ─(user cancels)─▶ cancelled (unrun runs owed back: refund_due_atomic)
 *   cancelled ─(admin, verified refund tx)─▶ refunded
 *
 * Amounts are fixed in local currency at scheduling time; AuraPay carries the FX risk
 * between paying and each run.
 */

const PAYMENT_GRACE_MS = 60 * 60_000;
const MAX_RUNS = 12;

type Row = Record<string, unknown> & { id: string; status: ScheduleStatus; user_id: string };

export interface CreateScheduleInput extends Omit<CreateOrderInput, "saveBeneficiary"> {
  frequency: ScheduleFrequency;
  totalRuns: number;
  startAt: string;
}

/** When run `n` (1-based) is due. Monthly keeps the day of month, clamped to short months. */
export function runAt(startAt: Date, frequency: ScheduleFrequency, n: number): Date {
  if (n <= 1 || frequency === "once") return new Date(startAt);
  if (frequency === "weekly") return new Date(startAt.getTime() + (n - 1) * 7 * 86_400_000);
  const d = new Date(startAt);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (n - 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function activityStatus(s: ScheduleStatus): ActivityStatus {
  if (s === "quoted" || s === "payment_pending") return "pending";
  if (s === "active") return "processing";
  if (s === "completed") return "successful";
  if (s === "refunded") return "refunded";
  if (s === "requires_review") return "requires_review";
  if (s === "cancelled") return "successful";
  return "failed";
}

async function runsFor(db: Db, scheduleId: string): Promise<ScheduleRunDTO[]> {
  const rows = await db.query<{ id: string; ref: string; status: UtilityOrderStatus; schedule_run: number; created_at: string }>(
    "select id, ref, status, schedule_run, created_at from utility_orders where schedule_id = $1 order by schedule_run desc limit 24",
    [scheduleId],
  );
  return rows.map((r) => ({ run: Number(r.schedule_run), orderId: r.id, ref: r.ref, status: r.status, createdAt: iso(r.created_at)! }));
}

async function paymentHash(db: Db, scheduleId: string): Promise<string | null> {
  const rows = await db.query<{ tx_hash: string }>(
    "select tx_hash from payments where order_kind = 'schedule' and order_id = $1 and direction = 'in' order by (status = 'confirmed') desc, created_at desc limit 1",
    [scheduleId],
  );
  return rows[0]?.tx_hash ?? null;
}

async function toDTO(db: Db, r: Row): Promise<BillScheduleDTO> {
  return {
    id: r.id,
    ref: String(r.ref),
    environment: r.environment as "sandbox" | "production",
    service: r.service as UtilityService,
    countryCode: String(r.country_code),
    operatorName: String(r.operator_name),
    recipient: String(r.recipient),
    recipientLabel: (r.recipient_label as string) ?? null,
    productDescription: (r.product_description as string) ?? null,
    amountLocal: numOrNull(r.amount_local),
    localCurrency: (r.local_currency as string) ?? null,
    frequency: r.frequency as ScheduleFrequency,
    totalRuns: Number(r.total_runs),
    runsDone: Number(r.runs_done),
    startAt: iso(r.start_at)!,
    nextRunAt: iso(r.next_run_at),
    perRunUsd: num(r.per_run_usd),
    quote: {
      providerCostUsd: num(r.provider_cost_usd),
      serviceFeeUsd: num(r.service_fee_usd),
      totalUsd: num(r.total_usd),
      payCurrency: r.pay_currency as PayCurrency,
      payAmount: num(r.pay_amount),
      payAmountAtomic: String(r.pay_amount_atomic),
      exchangeRate: num(r.exchange_rate),
      rateSource: String(r.rate_source),
      expiresAt: iso(r.expires_at)!,
    },
    payToAddress: (r.pay_to_address as string) ?? null,
    payerAddress: (r.payer_address as string) ?? null,
    memo: (r.memo as string) ?? null,
    status: r.status,
    statusReason: (r.status_reason as string) ?? null,
    refundDue: r.status === "cancelled" && Boolean(r.refund_due_atomic) && r.refund_due_atomic !== "0",
    paymentTxHash: await paymentHash(db, r.id),
    runs: await runsFor(db, r.id),
    createdAt: iso(r.created_at)!,
  };
}

async function move(db: Db, s: Row, to: ScheduleStatus, from: ScheduleStatus[], patch: Record<string, unknown> = {}): Promise<Row | null> {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`);
  const rows = await db.query<Row>(
    `update bill_schedules set status = $2, updated_at = now()${sets.length ? ", " + sets.join(", ") : ""}
     where id = $1 and status = any($3::text[]) returning *`,
    [s.id, to, from, ...cols.map((c) => patch[c])],
  );
  const updated = rows[0] ?? null;
  if (updated) {
    await updateLedgerBySource(db, "bill_schedules", s.id, "bill_schedule", { status: activityStatus(to), details: updated.status_reason ? { statusReason: updated.status_reason } : undefined });
    log.info("schedule.transition", { ref: updated.ref, from: s.status, to });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Create (quote)
// ---------------------------------------------------------------------------

export async function createSchedule(userId: string, input: CreateScheduleInput): Promise<BillScheduleDTO> {
  const db = await getDb();
  const existing = await db.query<Row>("select * from bill_schedules where user_id = $1 and client_request_id = $2", [userId, input.clientRequestId]);
  if (existing[0]) return toDTO(db, existing[0]);

  const startAt = new Date(input.startAt);
  if (Number.isNaN(startAt.getTime())) throw new AppError("INVALID_START", "Choose a valid date and time.", 422);
  // "Now" is allowed (first run immediately, then repeats); the past isn't.
  if (startAt.getTime() < Date.now() - 5 * 60_000) throw new AppError("START_IN_PAST", "Choose a date and time in the future.", 422);
  if (startAt.getTime() > Date.now() + 366 * 86_400_000) throw new AppError("START_TOO_FAR", "Schedules can start up to a year ahead.", 422);
  const totalRuns = input.frequency === "once" ? 1 : Math.trunc(input.totalRuns);
  if (!(totalRuns >= 1 && totalRuns <= MAX_RUNS)) throw new AppError("INVALID_RUNS", `Choose between 1 and ${MAX_RUNS} payments.`, 422);
  if (input.frequency !== "once" && totalRuns < 2) throw new AppError("INVALID_RUNS", "A repeating schedule needs at least 2 payments.", 422);

  const provider = await requireUtilityProvider();
  const rail = paymentRails()[input.payCurrency];
  if (!rail.available) throw new AppError("PAYMENT_RAIL_UNAVAILABLE", rail.reason ?? "This payment method is unavailable.", 422);
  if (input.payCurrency === "USDT") {
    if (!input.payerAddress || !isEvmAddress(input.payerAddress)) throw new AppError("PAYER_REQUIRED", "Connect your USDT wallet before paying with USDT.", 422);
    const linked = await verifiedEvmAddresses(userId);
    if (!linked.includes(input.payerAddress.toLowerCase())) throw new AppError("PAYER_NOT_VERIFIED", "Verify your USDT wallet before paying with it.", 422);
  }

  // Priced and validated (number / meter / smartcard) once, now.
  let priced: Priced;
  try {
    priced = await provider.price(input);
  } catch (err) {
    throw toAppError(err);
  }
  const fee = roundUpCents(Math.max(config.pricing.minServiceFeeUsd, (priced.providerCostUsd * config.pricing.serviceFeeBps) / 10_000));
  const perRunUsd = roundUpCents(priced.providerCostUsd + fee);
  const totalUsd = roundUpCents(perRunUsd * totalRuns);

  let rates;
  try {
    rates = await getRates();
  } catch {
    throw new AppError("RATES_UNAVAILABLE", "Exchange rates are unavailable right now. Please try again shortly.", 503);
  }
  const conv = convertUsd(totalUsd, input.payCurrency, rates, { usdtTag: randomInt(1, 100) });

  const ref = newRef("SC");
  const memo = input.payCurrency === "NIM" ? `AuraPay ${ref}` : null;
  const payTo = input.payCurrency === "NIM" ? normaliseNimAddress(config.nimiq.merchantAddress!) : config.polygon.merchantAddress!;
  const expiresAt = new Date(Date.now() + config.pricing.quoteTtlSeconds * 1000);
  const country = countryByCode(input.countryCode);
  const every = input.frequency === "once" ? "once" : `${input.frequency} ×${totalRuns}`;

  const created = await db.transaction(async (tx) => {
    const rows = await tx.query<Row>(
      `insert into bill_schedules (
         ref, user_id, client_request_id, environment, provider, service, country_code, operator_code, operator_name, item_code,
         recipient, recipient_label, product_description, amount_local, local_currency, amount_sender, sender_currency, use_local_amount,
         provider_cost_usd, service_fee_usd, per_run_usd, frequency, total_runs, start_at, total_usd,
         pay_currency, pay_amount, pay_amount_atomic, exchange_rate, rate_source, payer_address, pay_to_address, memo, status, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,'quoted',$34)
       on conflict (user_id, client_request_id) do nothing returning *`,
      [
        ref, userId, input.clientRequestId, provider.environment, provider.id, input.service, input.countryCode, priced.operatorCode, priced.operatorName, priced.itemCode,
        priced.recipient, input.recipientLabel?.slice(0, 60) ?? null, priced.productDescription, priced.amountLocal, priced.localCurrency, priced.amountSender, priced.senderCurrency, priced.useLocalAmount,
        priced.providerCostUsd, fee, perRunUsd, input.frequency, totalRuns, startAt, totalUsd,
        input.payCurrency, conv.amount, conv.atomic, conv.rate, rates.source, input.payerAddress?.toLowerCase() ?? null, payTo, memo, expiresAt,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    await insertLedger(tx, {
      ref,
      userId,
      category: "bill_schedule",
      title: `Scheduled · ${SERVICE_LABEL[input.service]} · ${priced.operatorName}`,
      subtitle: `${country?.flag ?? ""} ${priced.recipient} · ${every}`.trim(),
      amount: conv.amount,
      currency: input.payCurrency,
      amountUsd: totalUsd,
      status: "pending",
      isSimulated: false,
      environment: provider.environment,
      provider: provider.id,
      sourceTable: "bill_schedules",
      sourceId: row.id,
      details: { service: input.service, frequency: input.frequency, totalRuns, startAt: startAt.toISOString() },
    });
    return row;
  });
  const row = created ?? (await db.query<Row>("select * from bill_schedules where user_id = $1 and client_request_id = $2", [userId, input.clientRequestId]))[0];
  log.info("schedule.created", { ref, service: input.service, frequency: input.frequency, totalRuns });
  return toDTO(db, row);
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

async function loadOwned(db: Db, userId: string, id: string): Promise<Row> {
  const rows = await db.query<Row>("select * from bill_schedules where id = $1 and user_id = $2", [id, userId]);
  if (!rows[0]) throw new AppError("SCHEDULE_NOT_FOUND", "Schedule not found.", 404);
  return rows[0];
}

export async function submitSchedulePayment(userId: string, id: string, txHashRaw: string): Promise<BillScheduleDTO> {
  const db = await getDb();
  let s = await loadOwned(db, userId, id);
  if (s.status !== "quoted") return advanceSchedule(userId, id);
  if (Date.now() > new Date(s.expires_at as string).getTime()) {
    await move(db, s, "expired", ["quoted"], { status_reason: "Quote expired before payment." });
    throw new AppError("QUOTE_EXPIRED", "This quote has expired. Please start again for a fresh price.", 409);
  }
  const chain: "nimiq" | "polygon" = s.pay_currency === "NIM" ? "nimiq" : "polygon";
  const txHash = txHashRaw.trim().toLowerCase();
  const valid = chain === "nimiq" ? /^[0-9a-f]{64}$/.test(txHash) : /^0x[0-9a-f]{64}$/.test(txHash);
  if (!valid) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into payments (order_kind, order_id, direction, chain, tx_hash, payer_address, amount_atomic, status)
         values ('schedule', $1, 'in', $2, $3, $4, $5, 'submitted')`,
        [s.id, chain, txHash, s.payer_address ?? null, s.pay_amount_atomic],
      );
      const moved = await move(tx, s, "payment_pending", ["quoted"]);
      if (!moved) throw new AppError("ORDER_STATE_CHANGED", "This schedule changed state. Refresh and try again.", 409);
      s = moved;
      await updateLedgerBySource(tx, "bill_schedules", s.id, "bill_schedule", { chainTxHash: txHash });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (/unique|duplicate/i.test(errorMessage(err))) {
      const owner = await db.query<{ order_id: string }>("select order_id from payments where chain = $1 and tx_hash = $2", [chain, txHash]);
      if (owner[0]?.order_id === s.id) return advanceSchedule(userId, id);
      throw new AppError("TX_ALREADY_USED", "This payment has already been used for another order.", 409);
    }
    throw err;
  }
  return advanceSchedule(userId, id);
}

/** Verifies a pending payment; once paid the schedule is active and its first run is due at start_at. */
async function advance(db: Db, s: Row): Promise<Row> {
  if (s.status === "quoted" && Date.now() > new Date(s.expires_at as string).getTime()) {
    return (await move(db, s, "expired", ["quoted"], { status_reason: "Quote expired before payment." })) ?? s;
  }
  if (s.status !== "payment_pending") return s;
  const pay = await db.query<{ id: string; tx_hash: string }>(
    "select id, tx_hash from payments where order_kind = 'schedule' and order_id = $1 and direction = 'in' and status = 'submitted' order by created_at desc limit 1",
    [s.id],
  );
  if (!pay[0]) return s;
  const result = await verifyPayment(s, pay[0].tx_hash);
  if (result.state === "confirmed") {
    let out = s;
    await db.transaction(async (tx) => {
      await tx.query(
        "update payments set status = 'confirmed', verified_at = now(), payer_address = coalesce(payer_address, $2), verification = $3 where id = $1",
        [pay[0].id, result.from, JSON.stringify({ confirmations: result.confirmations, blockNumber: result.blockNumber, atomicValue: result.atomicValue })],
      );
      out = (await move(tx, s, "active", ["payment_pending"], { paid_at: new Date(), next_run_at: new Date(s.start_at as string), payer_address: s.payer_address ?? result.from })) ?? s;
    });
    return out;
  }
  if (result.state === "rejected") {
    await db.query("update payments set status = 'rejected', failure_reason = $2 where id = $1", [pay[0].id, result.reason]);
    return (await move(db, s, "requires_review", ["payment_pending"], { status_reason: `Payment check failed: ${result.reason}` })) ?? s;
  }
  if (Date.now() - new Date(s.updated_at as string).getTime() > PAYMENT_GRACE_MS) {
    return (await move(db, s, "requires_review", ["payment_pending"], { status_reason: `Payment not confirmed in time: ${result.reason}` })) ?? s;
  }
  return { ...s, status_reason: result.reason } as Row;
}

export async function advanceSchedule(userId: string, id: string): Promise<BillScheduleDTO> {
  const db = await getDb();
  let s = await loadOwned(db, userId, id);
  s = await advance(db, s);
  // A due first run ("start now") happens right away instead of waiting for the next runner tick.
  if (s.status === "active" && s.next_run_at && new Date(s.next_run_at as string).getTime() <= Date.now()) {
    await runSchedule(db, s);
    s = await loadOwned(db, userId, id);
  }
  return toDTO(db, s);
}

export async function listSchedules(userId: string): Promise<BillScheduleDTO[]> {
  const db = await getDb();
  // Opportunistic: anything of this user's that is due runs now (the cron runner is the primary trigger).
  await runDueSchedules({ userId, limit: 10 }).catch((err) => log.warn("schedule.opportunistic_failed", { error: errorMessage(err) }));
  const rows = await db.query<Row>("select * from bill_schedules where user_id = $1 and status <> 'expired' order by created_at desc limit 50", [userId]);
  return Promise.all(rows.map((r) => toDTO(db, r)));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Claims and creates the next run of one schedule (at most once), then fulfils it. */
async function runSchedule(db: Db, s: Row): Promise<string | null> {
  const done = Number(s.runs_done);
  const total = Number(s.total_runs);
  const run = done + 1;
  if (run > total) return null;
  const start = new Date(s.start_at as string);
  const freq = s.frequency as ScheduleFrequency;
  const next = run < total ? runAt(start, freq, run + 1) : null;
  const shareAtomic = (BigInt(String(s.pay_amount_atomic)) / BigInt(total)).toString();
  const sharePay = num(s.pay_amount) / total;
  const country = countryByCode(String(s.country_code));

  const orderId = await db.transaction(async (tx) => {
    // The claim: only the caller that moves runs_done from `done` creates this run.
    const claimed = await tx.query<Row>(
      `update bill_schedules set runs_done = $2, next_run_at = $3, last_run_at = now(), updated_at = now(),
         status = case when $2 >= total_runs then 'completed' else status end
       where id = $1 and status = 'active' and runs_done = $4 returning *`,
      [s.id, run, next, done],
    );
    if (!claimed[0]) return null;
    const ref = newRef();
    const rows = await tx.query<{ id: string }>(
      `insert into utility_orders (
         ref, user_id, client_request_id, environment, service, country_code, operator_id, operator_code, item_code, provider, operator_name,
         recipient, recipient_label, product_description, amount_local, local_currency, amount_sender, sender_currency, use_local_amount,
         provider_cost_usd, service_fee_usd, total_usd, pay_currency, pay_amount, pay_amount_atomic, exchange_rate, rate_source,
         payer_address, pay_to_address, memo, status, status_reason, expires_at, paid_at, schedule_id, schedule_run)
       values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'paid',$30,now(),now(),$31,$32)
       on conflict do nothing returning id`,
      [
        ref, s.user_id, `schedule:${s.id}:${run}`, s.environment, s.service, s.country_code, s.operator_code, s.item_code, s.provider, s.operator_name,
        s.recipient, s.recipient_label, s.product_description, s.amount_local, s.local_currency, s.amount_sender, s.sender_currency, s.use_local_amount,
        s.provider_cost_usd, s.service_fee_usd, s.per_run_usd, s.pay_currency, sharePay, shareAtomic, s.exchange_rate, s.rate_source,
        s.payer_address, s.pay_to_address, s.memo, `Scheduled payment ${run} of ${total} (prepaid with ${s.ref}).`, s.id, run,
      ],
    );
    if (!rows[0]) return null;
    await insertLedger(tx, {
      ref,
      userId: s.user_id,
      category: "utility_purchase",
      title: `${SERVICE_LABEL[s.service as UtilityService]} · ${s.operator_name}`,
      subtitle: `${country?.flag ?? ""} ${s.recipient} · scheduled ${run}/${total}`.trim(),
      amount: sharePay,
      currency: String(s.pay_currency),
      amountUsd: num(s.per_run_usd),
      status: "processing",
      isSimulated: false,
      environment: s.environment as "sandbox" | "production",
      provider: String(s.provider),
      sourceTable: "utility_orders",
      sourceId: rows[0].id,
      details: { scheduleRef: s.ref, run, totalRuns: total },
    });
    if (run >= total) await updateLedgerBySource(tx, "bill_schedules", s.id, "bill_schedule", { status: "successful" });
    return rows[0].id;
  });
  if (!orderId) return null;
  log.info("schedule.run_created", { ref: s.ref, run, total });
  try {
    await processOrder(orderId);
  } catch (err) {
    log.error("schedule.run_failed", { ref: s.ref, run, error: errorMessage(err) });
  }
  return orderId;
}

/**
 * Runs every due schedule (one run each per call) and keeps earlier runs moving
 * (fulfil leftovers, poll pending deliveries). Safe to call concurrently.
 */
export async function runDueSchedules(opts: { userId?: string; limit?: number } = {}): Promise<{ ran: number; processed: number }> {
  const db = await getDb();
  // Housekeeping: unpaid quotes (orders and schedules) expire instead of staying "pending".
  if (!opts.userId) {
    await expireStaleQuotes().catch(() => 0);
    await expireStaleScheduleQuotes().catch(() => 0);
  }
  const limit = opts.limit ?? 50;
  const due = await db.query<Row>(
    `select * from bill_schedules where status = 'active' and next_run_at <= now() ${opts.userId ? "and user_id = $2" : ""}
     order by next_run_at limit $1`,
    opts.userId ? [limit, opts.userId] : [limit],
  );
  let ran = 0;
  for (const s of due) if (await runSchedule(db, s)) ran++;

  // Runs created but not fulfilled (e.g. the function was stopped), and deliveries still pending.
  const open = await db.query<{ id: string }>(
    `select id from utility_orders where schedule_id is not null and status in ('paid', 'provider_pending')
       and updated_at < now() - interval '20 seconds' ${opts.userId ? "and user_id = $2" : ""}
     order by updated_at limit $1`,
    opts.userId ? [limit, opts.userId] : [limit],
  );
  for (const o of open) await processOrder(o.id).catch(() => null);
  if (ran) log.info("schedule.runner", { ran, processed: open.length });
  return { ran, processed: open.length };
}

// ---------------------------------------------------------------------------
// Cancel & refunds
// ---------------------------------------------------------------------------

/** Unpaid schedule quotes past their expiry become "expired" (Activity: failed, not paid). */
export async function expireStaleScheduleQuotes(userId?: string): Promise<number> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `select * from bill_schedules where status = 'quoted' and expires_at < now() ${userId ? "and user_id = $1" : ""} limit 200`,
    userId ? [userId] : [],
  );
  let n = 0;
  for (const s of rows) if (await move(db, s, "expired", ["quoted"], { status_reason: "Not paid: the quote expired before a payment was made." })) n++;
  return n;
}

export async function cancelSchedule(userId: string, id: string, reason?: "insufficient_funds"): Promise<BillScheduleDTO> {
  const db = await getDb();
  const s = await loadOwned(db, userId, id);
  if (s.status === "quoted") {
    const msg = reason === "insufficient_funds" ? "Not paid: insufficient balance in the wallet." : "Cancelled before payment.";
    const moved = await move(db, s, "cancelled", ["quoted"], { cancelled_at: new Date(), next_run_at: null, status_reason: msg });
    // Nothing was paid, so the activity entry is a failed (unpaid) one.
    await updateLedgerBySource(db, "bill_schedules", s.id, "bill_schedule", { status: "failed", details: { statusReason: msg } });
    return toDTO(db, moved ?? (await loadOwned(db, userId, id)));
  }
  if (s.status !== "active") throw new AppError("NOT_CANCELLABLE", `This schedule is ${s.status} and can't be cancelled.`, 409);
  const done = Number(s.runs_done);
  const total = Number(s.total_runs);
  const perRun = BigInt(String(s.pay_amount_atomic)) / BigInt(total);
  const owed = (BigInt(String(s.pay_amount_atomic)) - perRun * BigInt(done)).toString();
  // Only if no run was claimed meanwhile (runs_done unchanged).
  const rows = await db.query<Row>(
    `update bill_schedules set status = 'cancelled', cancelled_at = now(), next_run_at = null, refund_due_atomic = $3,
       status_reason = $4, updated_at = now()
     where id = $1 and status = 'active' and runs_done = $2 returning *`,
    [s.id, done, owed, `Cancelled after ${done} of ${total} payments. The unused ${total - done} will be refunded to your wallet.`],
  );
  if (!rows[0]) throw new AppError("ORDER_STATE_CHANGED", "A payment just ran. Refresh and try again.", 409);
  await updateLedgerBySource(db, "bill_schedules", s.id, "bill_schedule", { status: "requires_review", details: { statusReason: rows[0].status_reason } });
  log.info("schedule.cancelled", { ref: s.ref, done, total });
  return toDTO(db, rows[0]);
}

export async function adminListSchedules(): Promise<BillScheduleDTO[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    "select * from bill_schedules where (status = 'cancelled' and refund_due_atomic is not null and refund_due_atomic <> '0') or status in ('requires_review', 'payment_pending') order by updated_at desc limit 200",
  );
  return Promise.all(rows.map((r) => toDTO(db, r)));
}

/** Records the refund of a cancelled schedule's unused runs, after verifying it on-chain. */
export async function adminRefundSchedule(id: string, refundTxHash: string): Promise<BillScheduleDTO> {
  const db = await getDb();
  const s = (await db.query<Row>("select * from bill_schedules where id = $1", [id]))[0];
  if (!s) throw new AppError("SCHEDULE_NOT_FOUND", "Schedule not found.", 404);
  const due = s.status === "cancelled" ? String(s.refund_due_atomic ?? "0") : s.status === "requires_review" ? String(s.pay_amount_atomic) : "0";
  if (due === "0") throw new AppError("NOT_REFUNDABLE", `Nothing to refund for a ${s.status} schedule.`, 409);
  const payer = s.payer_address as string | null;
  if (!payer) throw new AppError("NO_PAYER", "Payer address unknown; cannot verify refund.", 409);
  const chain = s.pay_currency === "NIM" ? "nimiq" : "polygon";
  const notBefore = new Date(s.created_at as string);
  const result =
    chain === "nimiq"
      ? await verifyNimiqTransfer({ txHash: refundTxHash, expectedTo: payer, expectedFrom: String(s.pay_to_address), minLuna: BigInt(due), notBefore })
      : await verifyPolygonUsdtTransfer({ txHash: refundTxHash, expectedTo: payer, expectedFrom: String(s.pay_to_address), minUnits: BigInt(due), notBefore });
  if (result.state !== "confirmed") throw new AppError("REFUND_NOT_VERIFIED", `Refund not verified: ${result.reason}`, 409);
  return db.transaction(async (tx) => {
    await tx.query(
      `insert into payments (order_kind, order_id, direction, chain, tx_hash, payer_address, amount_atomic, status, verified_at, verification)
       values ('schedule', $1, 'refund', $2, $3, $4, $5, 'confirmed', now(), $6)`,
      [s.id, chain, refundTxHash.toLowerCase(), result.from, result.atomicValue, JSON.stringify({ confirmations: result.confirmations })],
    );
    const moved = await move(tx, s, "refunded", ["cancelled", "requires_review"], { status_reason: "Unused payments refunded to the original wallet." });
    if (!moved) throw new AppError("ORDER_STATE_CHANGED", "Schedule changed state.", 409);
    const decimals = s.pay_currency === "NIM" ? 1e5 : 1e6;
    await insertLedger(tx, {
      ref: newRef("RF"),
      userId: s.user_id,
      category: "refund",
      title: `Refund · scheduled ${SERVICE_LABEL[s.service as UtilityService]}`,
      subtitle: `For ${s.ref}`,
      amount: Number(BigInt(due)) / decimals,
      currency: String(s.pay_currency),
      amountUsd: null,
      status: "successful",
      isSimulated: false,
      environment: s.environment as "sandbox" | "production",
      provider: chain,
      chainTxHash: refundTxHash.toLowerCase(),
      sourceTable: "bill_schedules",
      sourceId: s.id,
      details: { scheduleRef: s.ref },
    });
    return toDTO(tx, moved);
  });
}
