import "server-only";
import { randomInt } from "node:crypto";
import type { ActivityStatus, PayCurrency, UtilityOrderDTO, UtilityOrderStatus, UtilityService } from "@/lib/shared/types";
import { countryByCode } from "@/lib/shared/countries";
import { config } from "../config";
import { getDb, iso, num, numOrNull, type Db } from "../db";
import { AppError } from "../http";
import { insertLedger, newRef, updateLedgerBySource } from "../ledger";
import { errorMessage, log } from "../log";
import { paymentRails } from "../rails";
import { verifiedEvmAddresses } from "../auth/challenges";
import { convertUsd, getRates } from "../rates";
import { verifyNimiqTransfer, normaliseNimAddress, type VerifyResult } from "../payments/nimiq";
import { isEvmAddress, verifyPolygonUsdtTransfer } from "../payments/polygon";
import { ProviderError, requireUtilityProvider, roundUpCents, toAppError, type Priced, type ProviderOrder, type ProviderOutcome } from "../utilities/provider";

/**
 * Utility order orchestration.
 *
 *   quoted ──(tx hash submitted)──▶ payment_pending ──(verified on-chain)──▶ paid
 *   paid ──(atomic claim)──▶ fulfilling ──▶ successful | provider_pending | requires_review
 *   provider_pending ──(status poll)──▶ successful | requires_review
 *   quoted ──(TTL)──▶ expired
 *   requires_review ──(admin, verified refund tx)──▶ refunded
 *
 * Invariants:
 *   - Fulfilment is only attempted from `paid`, and the paid→fulfilling transition is a
 *     conditional UPDATE, so concurrent requests can never submit the same order twice.
 *   - Every on-chain tx hash is unique across all orders (payments.unique(chain, tx_hash)).
 *   - Reloadly's customIdentifier / referenceId is the order ref, which Reloadly rejects if reused.
 *   - A verified payment whose fulfilment fails or is uncertain goes to `requires_review`.
 */

const PAYMENT_GRACE_MS = 60 * 60_000; // how long we keep waiting for a submitted tx to confirm

function activityStatus(s: UtilityOrderStatus): ActivityStatus {
  switch (s) {
    case "quoted":
    case "payment_pending":
      return "pending";
    case "paid":
    case "fulfilling":
    case "provider_pending":
      return "processing";
    case "successful":
      return "successful";
    case "failed":
    case "expired":
      return "failed";
    case "requires_review":
      return "requires_review";
    case "refunded":
      return "refunded";
  }
}

export const SERVICE_LABEL: Record<UtilityService, string> = { airtime: "Airtime", data: "Mobile data", electricity: "Electricity", cable: "Cable TV", internet: "Internet" };

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type OrderRow = Record<string, unknown> & { id: string; status: UtilityOrderStatus; user_id: string };

function toDTO(r: OrderRow, paymentTxHash: string | null): UtilityOrderDTO {
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v ?? null) as Record<string, unknown> | null;
  return {
    id: r.id,
    ref: String(r.ref),
    environment: r.environment as "sandbox" | "production",
    service: r.service as UtilityService,
    countryCode: String(r.country_code),
    operatorCode: String(r.operator_code ?? r.operator_id ?? ""),
    operatorName: String(r.operator_name),
    recipient: String(r.recipient),
    recipientLabel: (r.recipient_label as string) ?? null,
    productDescription: (r.product_description as string) ?? null,
    amountLocal: numOrNull(r.amount_local),
    localCurrency: (r.local_currency as string) ?? null,
    amountSender: num(r.amount_sender),
    senderCurrency: String(r.sender_currency),
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
    isSimulatedPayment: Boolean(r.is_simulated_payment),
    providerTransactionId: (r.provider_transaction_id as string) ?? null,
    providerStatus: (r.provider_status as string) ?? null,
    deliveryDetails: json(r.delivery_details),
    paymentTxHash,
    createdAt: iso(r.created_at)!,
    paidAt: iso(r.paid_at),
    fulfilledAt: iso(r.fulfilled_at),
  };
}

async function latestPaymentHash(db: Db, orderId: string): Promise<string | null> {
  const rows = await db.query<{ tx_hash: string }>(
    `select tx_hash from payments where order_kind = 'utility' and order_id = $1 and direction = 'in'
     order by (status = 'confirmed') desc, created_at desc limit 1`,
    [orderId],
  );
  return rows[0]?.tx_hash ?? null;
}

/** Moves an order to a new status (optionally only from expected statuses) and syncs the ledger. */
async function transition(
  db: Db,
  order: OrderRow,
  to: UtilityOrderStatus,
  from: UtilityOrderStatus[],
  patch: Record<string, unknown> = {},
): Promise<OrderRow | null> {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`);
  const rows = await db.query<OrderRow>(
    `update utility_orders set status = $2, updated_at = now()${sets.length ? ", " + sets.join(", ") : ""}
     where id = $1 and status = any($3::text[]) returning *`,
    [order.id, to, from, ...cols.map((c) => {
      const v = patch[c];
      return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
    })],
  );
  const updated = rows[0] ?? null;
  if (updated) {
    await updateLedgerBySource(db, "utility_orders", order.id, "utility_purchase", {
      status: activityStatus(to),
      providerRef: (updated.provider_transaction_id as string) ?? null,
      details: updated.status_reason ? { statusReason: updated.status_reason } : undefined,
    });
    log.info("utility_order.transition", { ref: updated.ref, from: order.status, to });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Create (quote)
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  clientRequestId: string;
  service: UtilityService;
  countryCode: string;
  operatorCode: string;
  productCode?: string;
  recipient: string;
  recipientLabel?: string;
  amount: number;
  amountCurrency: "local" | "sender";
  payCurrency: PayCurrency;
  payerAddress?: string;
  saveBeneficiary?: boolean;
}

export async function createUtilityOrder(userId: string, input: CreateOrderInput): Promise<UtilityOrderDTO> {
  const db = await getDb();

  const existing = await db.query<OrderRow>(
    "select * from utility_orders where user_id = $1 and client_request_id = $2",
    [userId, input.clientRequestId],
  );
  if (existing[0]) return toDTO(existing[0], await latestPaymentHash(db, existing[0].id));

  const provider = await requireUtilityProvider();
  const rail = paymentRails()[input.payCurrency];
  if (!rail.available) throw new AppError("PAYMENT_RAIL_UNAVAILABLE", rail.reason ?? "This payment method is unavailable.", 422);

  if (input.payCurrency === "USDT") {
    if (!input.payerAddress || !isEvmAddress(input.payerAddress)) {
      throw new AppError("PAYER_REQUIRED", "Connect your USDT wallet before paying with USDT.", 422);
    }
    // The paying EVM wallet must have been proven with a signature (personal_sign).
    const linked = await verifiedEvmAddresses(userId);
    if (!linked.includes(input.payerAddress.toLowerCase())) {
      throw new AppError("PAYER_NOT_VERIFIED", "Verify your USDT wallet before paying with it.", 422);
    }
  }

  let priced: Priced;
  try {
    priced = await provider.price(input);
  } catch (err) {
    throw toAppError(err);
  }

  const fee = roundUpCents(Math.max(config.pricing.minServiceFeeUsd, (priced.providerCostUsd * config.pricing.serviceFeeBps) / 10_000));
  const totalUsd = roundUpCents(priced.providerCostUsd + fee);

  let rates;
  try {
    rates = await getRates();
  } catch {
    throw new AppError("RATES_UNAVAILABLE", "Exchange rates are unavailable right now, so we can't price this in crypto. Please try again shortly.", 503);
  }
  const conv = convertUsd(totalUsd, input.payCurrency, rates, { usdtTag: randomInt(1, 100) });
  const payAmount = conv.amount;
  const atomic = conv.atomic;
  const rate = conv.rate;
  const rateSource = rates.source;

  const ref = newRef();
  const memo = input.payCurrency === "NIM" ? `AuraPay ${ref}` : null;
  const payTo = input.payCurrency === "NIM" ? normaliseNimAddress(config.nimiq.merchantAddress!) : config.polygon.merchantAddress!;
  const environment = provider.environment;
  const expiresAt = new Date(Date.now() + config.pricing.quoteTtlSeconds * 1000);
  const country = countryByCode(input.countryCode);

  const order = await db.transaction(async (tx) => {
    const rows = await tx.query<OrderRow>(
      `insert into utility_orders (
         ref, user_id, client_request_id, environment, service, country_code, operator_id, operator_code, item_code, provider, operator_name,
         recipient, recipient_label, product_description, amount_local, local_currency, amount_sender, sender_currency,
         use_local_amount, provider_cost_usd, service_fee_usd, total_usd, pay_currency, pay_amount, pay_amount_atomic,
         exchange_rate, rate_source, payer_address, pay_to_address, memo, status, is_simulated_payment, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$30,$31,$32,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'quoted',$28,$29)
       on conflict (user_id, client_request_id) do nothing
       returning *`,
      [
        ref, userId, input.clientRequestId, environment, input.service, input.countryCode, /^\d+$/.test(priced.operatorCode) ? Number(priced.operatorCode) : null, priced.operatorName,
        priced.recipient, input.recipientLabel?.slice(0, 60) ?? null, priced.productDescription, priced.amountLocal, priced.localCurrency,
        priced.amountSender, priced.senderCurrency, priced.useLocalAmount, priced.providerCostUsd, fee, totalUsd, input.payCurrency,
        payAmount, atomic, rate, rateSource, input.payerAddress?.toLowerCase().startsWith("0x") ? input.payerAddress.toLowerCase() : input.payerAddress ?? null,
        payTo, memo, false, expiresAt, priced.operatorCode, priced.itemCode, provider.id,
      ],
    );
    const row = rows[0];
    if (!row) return null; // concurrent duplicate; resolved below
    await insertLedger(tx, {
      ref,
      userId,
      category: "utility_purchase",
      title: `${SERVICE_LABEL[input.service]} · ${priced.operatorName}`,
      subtitle: `${country?.flag ?? ""} ${priced.recipient}`.trim(),
      amount: payAmount,
      currency: input.payCurrency,
      amountUsd: totalUsd,
      status: "pending",
      isSimulated: false,
      environment,
      provider: provider.id,
      sourceTable: "utility_orders",
      sourceId: row.id,
      details: {
        service: input.service,
        country: input.countryCode,
        operator: priced.operatorName,
        recipient: priced.recipient,
        providerEnvironment: environment,
      },
    });
    if (input.saveBeneficiary) {
      await tx.query(
        `insert into saved_beneficiaries (user_id, kind, country_code, label, value, operator_id, operator_name, operator_code, last_used_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (user_id, kind, country_code, value)
         do update set label = excluded.label, operator_id = excluded.operator_id, operator_name = excluded.operator_name, operator_code = excluded.operator_code, last_used_at = now()`,
        [userId, input.service === "electricity" ? "meter" : "phone", input.countryCode, input.recipientLabel?.slice(0, 60) || priced.recipient, priced.recipient, /^\d+$/.test(priced.operatorCode) ? Number(priced.operatorCode) : null, priced.operatorName, priced.operatorCode],
      );
    }
    return row;
  });

  if (!order) {
    const again = await db.query<OrderRow>("select * from utility_orders where user_id = $1 and client_request_id = $2", [userId, input.clientRequestId]);
    return toDTO(again[0], null);
  }
  log.info("utility_order.created", { ref, service: input.service, country: input.countryCode, payCurrency: input.payCurrency, environment });
  return toDTO(order, null);
}

// ---------------------------------------------------------------------------
// Payment submission & verification
// ---------------------------------------------------------------------------

async function loadOwned(db: Db, userId: string, orderId: string): Promise<OrderRow> {
  const rows = await db.query<OrderRow>("select * from utility_orders where id = $1 and user_id = $2", [orderId, userId]);
  if (!rows[0]) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  return rows[0];
}

export async function submitPayment(userId: string, orderId: string, txHashRaw: string | undefined): Promise<UtilityOrderDTO> {
  const db = await getDb();
  let order = await loadOwned(db, userId, orderId);

  if (order.status === "expired" && txHashRaw) {
    // A payment for a closed/expired quote is never fulfilled; it's recorded and sent to
    // review so the funds (if they really arrived) are refunded.
    const chain: "nimiq" | "polygon" = order.pay_currency === "NIM" ? "nimiq" : "polygon";
    const txHash = txHashRaw.trim().toLowerCase();
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          `insert into payments (order_kind, order_id, direction, chain, tx_hash, payer_address, amount_atomic, status)
           values ('utility', $1, 'in', $2, $3, $4, $5, 'submitted')`,
          [order.id, chain, txHash, order.payer_address ?? null, order.pay_amount_atomic],
        );
        await transition(tx, order, "requires_review", ["expired"], { status_reason: "Payment sent after this quote was closed. It won't be delivered; we'll check it and refund it." });
      });
    } catch (err) {
      if (/unique|duplicate/i.test(errorMessage(err))) throw new AppError("TX_ALREADY_USED", "This payment has already been used for another order.", 409);
      throw err;
    }
    return advanceOrder(userId, orderId);
  }
  if (order.status !== "quoted") {
    // Idempotent: a second submit just advances / returns the current state.
    return advanceOrder(userId, orderId);
  }
  if (Date.now() > new Date(order.expires_at as string).getTime()) {
    await transition(db, order, "expired", ["quoted"], { status_reason: "Quote expired before payment." });
    throw new AppError("QUOTE_EXPIRED", "This quote has expired. Please start again for a fresh price.", 409);
  }

  const currency = order.pay_currency as PayCurrency;
  if (!txHashRaw) throw new AppError("TX_HASH_REQUIRED", "Missing payment transaction.", 422);
  const chain: "nimiq" | "polygon" = currency === "NIM" ? "nimiq" : "polygon";
  const txHash = txHashRaw.trim().toLowerCase();
  const valid = chain === "nimiq" ? /^[0-9a-f]{64}$/.test(txHash) : /^0x[0-9a-f]{64}$/.test(txHash);
  if (!valid) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into payments (order_kind, order_id, direction, chain, tx_hash, payer_address, amount_atomic, status)
         values ('utility', $1, 'in', $2, $3, $4, $5, 'submitted')`,
        [order.id, chain, txHash, order.payer_address ?? null, order.pay_amount_atomic],
      );
      const moved = await transition(tx, order, "payment_pending", ["quoted"]);
      if (!moved) throw new AppError("ORDER_STATE_CHANGED", "This order changed state. Refresh and try again.", 409);
      order = moved;
      await updateLedgerBySource(tx, "utility_orders", order.id, "utility_purchase", { chainTxHash: txHash });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = errorMessage(err);
    if (/unique|duplicate/i.test(msg)) {
      const owner = await db.query<{ order_id: string }>("select order_id from payments where chain = $1 and tx_hash = $2", [chain, txHash]);
      if (owner[0]?.order_id === order.id) return advanceOrder(userId, orderId);
      throw new AppError("TX_ALREADY_USED", "This payment has already been used for another order.", 409);
    }
    throw err;
  }
  return advanceOrder(userId, orderId);
}

/** Verifies an incoming payment for any row with the quote columns (orders and schedules). */
export async function verifyPayment(order: Record<string, unknown>, txHash: string): Promise<VerifyResult> {
  const notBefore = new Date(new Date(order.created_at as string).getTime() - 2 * 60_000);
  if (order.pay_currency === "NIM") {
    return verifyNimiqTransfer({
      txHash,
      expectedTo: String(order.pay_to_address),
      minLuna: BigInt(String(order.pay_amount_atomic)),
      expectedMemo: String(order.memo),
      notBefore,
    });
  }
  return verifyPolygonUsdtTransfer({
    txHash,
    expectedTo: String(order.pay_to_address),
    expectedFrom: String(order.payer_address),
    exactUnits: BigInt(String(order.pay_amount_atomic)),
    notBefore,
  });
}

/**
 * Drives an order forward as far as it can go right now. Safe to call
 * repeatedly and concurrently (each step is a guarded transition).
 */
export async function advanceOrder(userId: string, orderId: string): Promise<UtilityOrderDTO> {
  const db = await getDb();
  let order = await loadOwned(db, userId, orderId);

  // Lazy quote expiry.
  if (order.status === "quoted" && Date.now() > new Date(order.expires_at as string).getTime()) {
    order = (await transition(db, order, "expired", ["quoted"], { status_reason: "Quote expired before payment." })) ?? order;
  }

  if (order.status === "payment_pending") {
    const pay = await db.query<{ id: string; tx_hash: string }>(
      "select id, tx_hash from payments where order_kind = 'utility' and order_id = $1 and direction = 'in' and status = 'submitted' order by created_at desc limit 1",
      [order.id],
    );
    if (pay[0]) {
      const result = await verifyPayment(order, pay[0].tx_hash);
      if (result.state === "confirmed") {
        await db.transaction(async (tx) => {
          await tx.query(
            "update payments set status = 'confirmed', verified_at = now(), payer_address = coalesce(payer_address, $2), verification = $3 where id = $1",
            [pay[0].id, result.from, JSON.stringify({ confirmations: result.confirmations, blockNumber: result.blockNumber, timestamp: result.timestamp, atomicValue: result.atomicValue })],
          );
          order = (await transition(tx, order, "paid", ["payment_pending"], { paid_at: new Date(), payer_address: order.payer_address ?? result.from })) ?? order;
        });
      } else if (result.state === "rejected") {
        await db.transaction(async (tx) => {
          await tx.query("update payments set status = 'rejected', failure_reason = $2 where id = $1", [pay[0].id, result.reason]);
          // Funds may have reached us with a mismatch: a human must review, never auto-fail silently.
          order = (await transition(tx, order, "requires_review", ["payment_pending"], { status_reason: `Payment check failed: ${result.reason}` })) ?? order;
        });
      } else if (Date.now() - new Date(order.updated_at as string).getTime() > PAYMENT_GRACE_MS) {
        order = (await transition(db, order, "requires_review", ["payment_pending"], { status_reason: `Payment not confirmed in time: ${result.reason}` })) ?? order;
      } else {
        order = { ...order, status_reason: result.reason } as OrderRow;
      }
    }
  }

  if (order.status === "paid") order = await fulfil(db, order);
  if (order.status === "provider_pending") order = await pollProvider(db, order);

  return toDTO(order, await latestPaymentHash(db, order.id));
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

function providerOrder(o: OrderRow): ProviderOrder {
  return {
    ref: String(o.ref),
    service: o.service as UtilityService,
    countryCode: String(o.country_code),
    operatorCode: String(o.operator_code ?? o.operator_id ?? ""),
    itemCode: (o.item_code as string) ?? null,
    recipient: String(o.recipient),
    amountLocal: numOrNull(o.amount_local),
    amountSender: num(o.amount_sender),
    useLocalAmount: Boolean(o.use_local_amount),
    providerTransactionId: (o.provider_transaction_id as string) ?? null,
  };
}

function outcomePatch(out: ProviderOutcome): Record<string, unknown> {
  return {
    ...(out.providerTransactionId ? { provider_transaction_id: out.providerTransactionId } : {}),
    ...(out.providerStatus !== undefined ? { provider_status: out.providerStatus } : {}),
    ...(out.providerResponse !== undefined ? { provider_response: out.providerResponse } : {}),
    ...(out.deliveryDetails ? { delivery_details: out.deliveryDetails } : {}),
    status_reason: out.reason ?? null,
    ...(out.next === "successful" ? { fulfilled_at: new Date() } : {}),
  };
}

async function fulfil(db: Db, order: OrderRow): Promise<OrderRow> {
  // Exactly-once claim. If another request already claimed it, we stop here.
  const claimed = await transition(db, order, "fulfilling", ["paid"]);
  if (!claimed) return (await db.query<OrderRow>("select * from utility_orders where id = $1", [order.id]))[0];
  order = claimed;
  try {
    const provider = await requireUtilityProvider();
    const out = await provider.submit(providerOrder(order));
    const next: UtilityOrderStatus = out.next === "unchanged" ? "provider_pending" : out.next;
    return (await transition(db, order, next, ["fulfilling"], outcomePatch(out))) ?? order;
  } catch (err) {
    const pe = err instanceof ProviderError ? err : null;
    const reason = pe
      ? pe.outcomeUnknown
        ? "Provider outcome unknown after submission — reconciling with provider."
        : `Provider rejected the order: ${pe.message}`
      : `Unexpected error during fulfilment: ${errorMessage(err)}`;
    log.error("utility_order.fulfilment_failed", { ref: order.ref, code: pe?.code, outcomeUnknown: pe?.outcomeUnknown });
    return (await transition(db, order, "requires_review", ["fulfilling"], { status_reason: reason, provider_status: pe?.code ?? "ERROR" })) ?? order;
  }
}

async function pollProvider(db: Db, order: OrderRow): Promise<OrderRow> {
  // Don't hammer the provider: at most every 10s per order.
  if (Date.now() - new Date(order.updated_at as string).getTime() < 10_000) return order;
  try {
    const provider = await requireUtilityProvider();
    const out = await provider.poll(providerOrder(order));
    if (out.next === "unchanged" || out.next === "provider_pending") {
      await db.query("update utility_orders set updated_at = now(), provider_status = coalesce($2, provider_status) where id = $1", [order.id, out.providerStatus ?? null]);
      return { ...order, provider_status: out.providerStatus ?? order.provider_status } as OrderRow;
    }
    return (await transition(db, order, out.next, ["provider_pending"], outcomePatch(out))) ?? order;
  } catch (err) {
    log.warn("utility_order.poll_failed", { ref: order.ref, error: errorMessage(err) });
    return order;
  }
}

/**
 * Drives an already-paid order (e.g. a scheduled run) without a user context:
 * fulfils it if paid, or polls the provider if pending. Exactly-once via `fulfil`'s claim.
 */
export async function processOrder(orderId: string): Promise<UtilityOrderStatus | null> {
  const db = await getDb();
  let order = (await db.query<OrderRow>("select * from utility_orders where id = $1", [orderId]))[0];
  if (!order) return null;
  if (order.status === "paid") order = await fulfil(db, order);
  if (order.status === "provider_pending") order = await pollProvider(db, order);
  return order.status;
}

/**
 * Quotes that were never paid expire, and so does their activity entry ("Failed · not paid").
 * Expiry used to happen only when the order itself was opened, which left unpaid quotes
 * showing as "Pending" in Activity indefinitely.
 */
export async function expireStaleQuotes(userId?: string): Promise<number> {
  const db = await getDb();
  const rows = await db.query<OrderRow>(
    `select * from utility_orders where status = 'quoted' and expires_at < now() ${userId ? "and user_id = $1" : ""} order by expires_at limit 200`,
    userId ? [userId] : [],
  );
  let n = 0;
  for (const o of rows) if (await transition(db, o, "expired", ["quoted"], { status_reason: "Not paid: the quote expired before a payment was made." })) n++;
  return n;
}

/** Closes an unpaid quote right away, e.g. when the wallet reports insufficient funds. */
export async function cancelUnpaidOrder(userId: string, orderId: string, reason: "insufficient_funds" | "cancelled"): Promise<UtilityOrderDTO> {
  const db = await getDb();
  const order = await loadOwned(db, userId, orderId);
  if (order.status !== "quoted") return toDTO(order, await latestPaymentHash(db, order.id));
  const msg = reason === "insufficient_funds" ? "Not paid: insufficient balance in the wallet." : "Not paid: cancelled.";
  const moved = await transition(db, order, "expired", ["quoted"], { status_reason: msg });
  return toDTO(moved ?? order, null);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrder(userId: string, orderId: string): Promise<UtilityOrderDTO> {
  return advanceOrder(userId, orderId);
}

export async function listOrders(userId: string, limit = 30): Promise<UtilityOrderDTO[]> {
  const db = await getDb();
  const rows = await db.query<OrderRow>("select * from utility_orders where user_id = $1 order by created_at desc limit $2", [userId, limit]);
  return Promise.all(rows.map(async (r) => toDTO(r, await latestPaymentHash(db, r.id))));
}

// ---------------------------------------------------------------------------
// Admin: reconciliation & refunds
// ---------------------------------------------------------------------------

export async function adminListReview(): Promise<UtilityOrderDTO[]> {
  const db = await getDb();
  const rows = await db.query<OrderRow>(
    "select * from utility_orders where status in ('requires_review','provider_pending','payment_pending') order by updated_at desc limit 200",
  );
  return Promise.all(rows.map(async (r) => toDTO(r, await latestPaymentHash(db, r.id))));
}

/** Records a refund only after verifying the refund transfer on-chain (merchant → payer). */
export async function adminRecordRefund(orderId: string, refundTxHash: string): Promise<UtilityOrderDTO> {
  const db = await getDb();
  const rows = await db.query<OrderRow>("select * from utility_orders where id = $1", [orderId]);
  const order = rows[0];
  if (!order) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  if (order.status !== "requires_review") throw new AppError("NOT_REFUNDABLE", `Order is ${order.status}; only orders requiring review can be refunded.`, 409);
  const payer = order.payer_address as string | null;
  if (!payer) throw new AppError("NO_PAYER", "Payer address unknown; cannot verify refund.", 409);

  const notBefore = new Date(order.created_at as string);
  const chain = order.pay_currency === "NIM" ? "nimiq" : "polygon";
  const result =
    chain === "nimiq"
      ? await verifyNimiqTransfer({ txHash: refundTxHash, expectedTo: payer, expectedFrom: String(order.pay_to_address), minLuna: BigInt(String(order.pay_amount_atomic)), notBefore })
      : await verifyPolygonUsdtTransfer({ txHash: refundTxHash, expectedTo: payer, expectedFrom: String(order.pay_to_address), minUnits: BigInt(String(order.pay_amount_atomic)), notBefore });
  if (result.state !== "confirmed") throw new AppError("REFUND_NOT_VERIFIED", `Refund not verified: ${result.reason}`, 409);

  return db.transaction(async (tx) => {
    await tx.query(
      `insert into payments (order_kind, order_id, direction, chain, tx_hash, payer_address, amount_atomic, status, verified_at, verification)
       values ('utility', $1, 'refund', $2, $3, $4, $5, 'confirmed', now(), $6)`,
      [order.id, chain, refundTxHash.toLowerCase(), result.from, result.atomicValue, JSON.stringify({ confirmations: result.confirmations })],
    );
    const moved = await transition(tx, order, "refunded", ["requires_review"], { status_reason: "Refunded to the original wallet." });
    if (!moved) throw new AppError("ORDER_STATE_CHANGED", "Order changed state.", 409);
    await insertLedger(tx, {
      ref: newRef("RF"),
      userId: order.user_id,
      category: "refund",
      title: `Refund · ${order.operator_name}`,
      subtitle: `For ${order.ref}`,
      amount: num(order.pay_amount),
      currency: String(order.pay_currency),
      amountUsd: num(order.total_usd),
      status: "successful",
      isSimulated: false,
      environment: order.environment as "sandbox" | "production",
      provider: chain,
      chainTxHash: refundTxHash.toLowerCase(),
      sourceTable: "utility_orders",
      sourceId: order.id,
      details: { originalRef: order.ref },
    });
    return toDTO(moved, refundTxHash.toLowerCase());
  });
}

/** Manually resolves a reviewed order after checking with the provider (e.g. confirmed delivered). */
export async function adminResolve(orderId: string, to: "successful" | "failed", note: string): Promise<UtilityOrderDTO> {
  const db = await getDb();
  const rows = await db.query<OrderRow>("select * from utility_orders where id = $1", [orderId]);
  if (!rows[0]) throw new AppError("ORDER_NOT_FOUND", "Order not found.", 404);
  const moved = await transition(db, rows[0], to, ["requires_review", "provider_pending"], {
    status_reason: `Resolved by operator: ${note}`.slice(0, 500),
    ...(to === "successful" ? { fulfilled_at: new Date() } : {}),
  });
  if (!moved) throw new AppError("ORDER_STATE_CHANGED", `Order is ${rows[0].status}; cannot resolve.`, 409);
  return toDTO(moved, await latestPaymentHash(db, orderId));
}
