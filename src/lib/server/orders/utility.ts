import "server-only";
import { randomInt } from "node:crypto";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
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
import { billerById, isAirtimeOperator, isDataOperator, operatorById } from "../reloadly/catalog";
import { friendlyReloadlyMessage, reloadlyRequest, ReloadlyError } from "../reloadly/client";

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

const SERVICE_LABEL: Record<UtilityService, string> = { airtime: "Airtime", data: "Mobile data", electricity: "Electricity" };

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
    operatorId: num(r.operator_id),
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
  operatorId: number;
  recipient: string;
  recipientLabel?: string;
  amount: number;
  amountCurrency: "local" | "sender";
  payCurrency: PayCurrency;
  payerAddress?: string;
  saveBeneficiary?: boolean;
}

function normalisePhone(raw: string, countryCode: string): string {
  const parsed = parsePhoneNumberFromString(raw, countryCode as CountryCode);
  if (!parsed || !parsed.isValid() || parsed.country !== countryCode) {
    throw new AppError("INVALID_PHONE", `Enter a valid ${countryByCode(countryCode)?.name ?? ""} mobile number.`.replace("  ", " "), 422);
  }
  return parsed.number.replace("+", ""); // E.164 digits, as Reloadly expects
}

const roundUpCents = (v: number) => Math.ceil(v * 100 - 1e-9) / 100;

interface Priced {
  operatorName: string;
  productDescription: string | null;
  amountLocal: number | null;
  localCurrency: string | null;
  amountSender: number;
  senderCurrency: string;
  useLocalAmount: boolean;
  providerCostUsd: number;
  recipient: string;
}

async function priceTopup(input: CreateOrderInput): Promise<Priced> {
  const { dto: op, raw } = await operatorById(input.operatorId);
  if ((raw.country?.isoName ?? "").toUpperCase() !== input.countryCode) {
    throw new AppError("OPERATOR_COUNTRY_MISMATCH", "This operator does not serve the selected country.", 422);
  }
  if (input.service === "data" && !isDataOperator(op)) throw new AppError("NOT_DATA_OPERATOR", "This operator does not sell data bundles.", 422);
  if (input.service === "airtime" && !isAirtimeOperator(op)) throw new AppError("NOT_AIRTIME_OPERATOR", "Select an airtime operator.", 422);
  if (op.senderCurrency !== "USD") {
    throw new AppError("UNSUPPORTED_ACCOUNT_CURRENCY", `Provider account currency ${op.senderCurrency} is not supported (USD required).`, 503);
  }
  const recipient = normalisePhone(input.recipient, input.countryCode);

  if (op.denominationType === "FIXED") {
    // Fixed products are always selected by their sender (USD) price.
    const product = op.products.find((p) => Math.abs(p.senderAmount - input.amount) < 0.005);
    if (!product || input.amountCurrency !== "sender") {
      throw new AppError("INVALID_PRODUCT", "Select one of the operator's available amounts.", 422);
    }
    return {
      operatorName: op.name,
      productDescription: product.description,
      amountLocal: product.localAmount,
      localCurrency: op.localCurrency || null,
      amountSender: product.senderAmount,
      senderCurrency: op.senderCurrency,
      useLocalAmount: false,
      providerCostUsd: product.senderAmount,
      recipient,
    };
  }

  // RANGE
  if (input.amountCurrency === "local") {
    if (!op.supportsLocalAmounts || !op.fxRate) throw new AppError("LOCAL_AMOUNT_UNSUPPORTED", "Enter the amount in USD for this operator.", 422);
    if (op.localMinAmount !== null && input.amount < op.localMinAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${op.localMinAmount} ${op.localCurrency}.`, 422);
    if (op.localMaxAmount !== null && input.amount > op.localMaxAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${op.localMaxAmount} ${op.localCurrency}.`, 422);
    const cost = roundUpCents(input.amount / op.fxRate);
    return {
      operatorName: op.name,
      productDescription: null,
      amountLocal: input.amount,
      localCurrency: op.localCurrency,
      amountSender: cost,
      senderCurrency: op.senderCurrency,
      useLocalAmount: true,
      providerCostUsd: cost,
      recipient,
    };
  }
  if (op.minAmount !== null && input.amount < op.minAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is $${op.minAmount}.`, 422);
  if (op.maxAmount !== null && input.amount > op.maxAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is $${op.maxAmount}.`, 422);
  return {
    operatorName: op.name,
    productDescription: null,
    amountLocal: op.fxRate ? Math.round(input.amount * op.fxRate * 100) / 100 : null,
    localCurrency: op.localCurrency || null,
    amountSender: roundUpCents(input.amount),
    senderCurrency: op.senderCurrency,
    useLocalAmount: false,
    providerCostUsd: roundUpCents(input.amount),
    recipient,
  };
}

async function priceElectricity(input: CreateOrderInput): Promise<Priced> {
  const biller = await billerById(input.operatorId);
  if (!biller || biller.type !== "ELECTRICITY_BILL_PAYMENT") throw new AppError("BILLER_NOT_FOUND", "Electricity provider not found.", 404);
  if (biller.countryCode !== input.countryCode) throw new AppError("BILLER_COUNTRY_MISMATCH", "This provider does not serve the selected country.", 422);
  if (biller.senderCurrency && biller.senderCurrency !== "USD") {
    throw new AppError("UNSUPPORTED_ACCOUNT_CURRENCY", `Provider account currency ${biller.senderCurrency} is not supported (USD required).`, 503);
  }
  if (!biller.localAmountSupported || !biller.fxRate) {
    throw new AppError("BILLER_PRICING_UNAVAILABLE", "This provider doesn't support local-currency amounts.", 422);
  }
  const meter = input.recipient.replace(/[\s-]/g, "");
  if (!/^[0-9A-Za-z]{6,24}$/.test(meter)) throw new AppError("INVALID_METER", "Enter a valid meter or account number.", 422);
  if (input.amountCurrency !== "local") throw new AppError("INVALID_AMOUNT_CURRENCY", "Enter the amount in local currency.", 422);
  if (biller.minLocalAmount !== null && input.amount < biller.minLocalAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${biller.minLocalAmount} ${biller.localCurrency}.`, 422);
  if (biller.maxLocalAmount !== null && input.amount > biller.maxLocalAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${biller.maxLocalAmount} ${biller.localCurrency}.`, 422);
  const fee = biller.localFee ?? 0;
  const cost = roundUpCents((input.amount + fee) / biller.fxRate);
  return {
    operatorName: biller.name,
    productDescription: `${biller.serviceType === "POSTPAID" ? "Postpaid" : "Prepaid"} electricity${fee ? ` · incl. provider fee ${fee} ${biller.localCurrency}` : ""}`,
    amountLocal: input.amount,
    localCurrency: biller.localCurrency,
    amountSender: cost,
    senderCurrency: "USD",
    useLocalAmount: true,
    providerCostUsd: cost,
    recipient: meter,
  };
}

export async function createUtilityOrder(userId: string, input: CreateOrderInput): Promise<UtilityOrderDTO> {
  const db = await getDb();

  const existing = await db.query<OrderRow>(
    "select * from utility_orders where user_id = $1 and client_request_id = $2",
    [userId, input.clientRequestId],
  );
  if (existing[0]) return toDTO(existing[0], await latestPaymentHash(db, existing[0].id));

  if (!config.reloadly.configured) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
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
    priced = input.service === "electricity" ? await priceElectricity(input) : await priceTopup(input);
  } catch (err) {
    if (err instanceof ReloadlyError) throw new AppError(err.errorCode ?? "PROVIDER_ERROR", friendlyReloadlyMessage(err), err.status === 404 ? 404 : 502);
    throw err;
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
  const environment = config.reloadly.mode;
  const expiresAt = new Date(Date.now() + config.pricing.quoteTtlSeconds * 1000);
  const country = countryByCode(input.countryCode);

  const order = await db.transaction(async (tx) => {
    const rows = await tx.query<OrderRow>(
      `insert into utility_orders (
         ref, user_id, client_request_id, environment, service, country_code, operator_id, operator_name,
         recipient, recipient_label, product_description, amount_local, local_currency, amount_sender, sender_currency,
         use_local_amount, provider_cost_usd, service_fee_usd, total_usd, pay_currency, pay_amount, pay_amount_atomic,
         exchange_rate, rate_source, payer_address, pay_to_address, memo, status, is_simulated_payment, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'quoted',$28,$29)
       on conflict (user_id, client_request_id) do nothing
       returning *`,
      [
        ref, userId, input.clientRequestId, environment, input.service, input.countryCode, input.operatorId, priced.operatorName,
        priced.recipient, input.recipientLabel?.slice(0, 60) ?? null, priced.productDescription, priced.amountLocal, priced.localCurrency,
        priced.amountSender, priced.senderCurrency, priced.useLocalAmount, priced.providerCostUsd, fee, totalUsd, input.payCurrency,
        payAmount, atomic, rate, rateSource, input.payerAddress?.toLowerCase().startsWith("0x") ? input.payerAddress.toLowerCase() : input.payerAddress ?? null,
        payTo, memo, false, expiresAt,
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
      provider: "reloadly",
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
        `insert into saved_beneficiaries (user_id, kind, country_code, label, value, operator_id, operator_name, last_used_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (user_id, kind, country_code, value)
         do update set label = excluded.label, operator_id = excluded.operator_id, operator_name = excluded.operator_name, last_used_at = now()`,
        [userId, input.service === "electricity" ? "meter" : "phone", input.countryCode, input.recipientLabel?.slice(0, 60) || priced.recipient, priced.recipient, input.operatorId, priced.operatorName],
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

async function verifyPayment(order: OrderRow, txHash: string): Promise<VerifyResult> {
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

interface TopupResponse {
  transactionId: number;
  status?: string;
  operatorTransactionId?: string | null;
  deliveredAmount?: number;
  deliveredAmountCurrencyCode?: string;
  requestedAmount?: number;
  requestedAmountCurrencyCode?: string;
  pinDetail?: Record<string, unknown> | null;
  transactionDate?: string;
}

interface PayBillResponse {
  id: number;
  status: string;
  referenceId?: string;
  code?: string;
  message?: string;
  submittedAt?: string;
  finalStatusAvailabilityAt?: string;
}

function topupDelivery(r: TopupResponse): Record<string, unknown> {
  return {
    deliveredAmount: r.deliveredAmount ?? null,
    deliveredCurrency: r.deliveredAmountCurrencyCode ?? null,
    operatorTransactionId: r.operatorTransactionId ?? null,
    pin: r.pinDetail ?? null,
    providerDate: r.transactionDate ?? null,
  };
}

async function fulfil(db: Db, order: OrderRow): Promise<OrderRow> {
  // Exactly-once claim. If another request already claimed it, we stop here.
  const claimed = await transition(db, order, "fulfilling", ["paid"]);
  if (!claimed) return (await db.query<OrderRow>("select * from utility_orders where id = $1", [order.id]))[0];
  order = claimed;

  try {
    if (order.service === "electricity") {
      const res = await reloadlyRequest<PayBillResponse>("utilities", "POST", "/pay", {
        subscriberAccountNumber: order.recipient,
        amount: num(order.amount_local),
        billerId: num(order.operator_id),
        useLocalAmount: true,
        referenceId: order.ref,
      });
      const status = (res.status ?? "").toUpperCase();
      const next: UtilityOrderStatus = status === "SUCCESSFUL" ? "successful" : status === "FAILED" ? "requires_review" : "provider_pending";
      return (
        (await transition(db, order, next, ["fulfilling"], {
          provider_transaction_id: String(res.id),
          provider_status: status,
          provider_response: res,
          status_reason: next === "requires_review" ? `Provider failed: ${res.message ?? status}` : res.message ?? null,
          ...(next === "successful" ? { fulfilled_at: new Date() } : {}),
        })) ?? order
      );
    }

    const country = String(order.country_code);
    const res = await reloadlyRequest<TopupResponse>("airtime", "POST", "/topups", {
      operatorId: num(order.operator_id),
      amount: order.use_local_amount ? num(order.amount_local) : num(order.amount_sender),
      useLocalAmount: Boolean(order.use_local_amount),
      customIdentifier: order.ref,
      recipientPhone: { countryCode: country, number: String(order.recipient) },
    });
    const status = (res.status ?? "SUCCESSFUL").toUpperCase();
    const next: UtilityOrderStatus =
      status === "SUCCESSFUL" ? "successful" : status === "PENDING" || status === "PROCESSING" ? "provider_pending" : "requires_review";
    return (
      (await transition(db, order, next, ["fulfilling"], {
        provider_transaction_id: String(res.transactionId),
        provider_status: status,
        provider_response: res,
        delivery_details: topupDelivery(res),
        status_reason: next === "requires_review" ? `Provider returned ${status}. Refund required.` : null,
        ...(next === "successful" ? { fulfilled_at: new Date() } : {}),
      })) ?? order
    );
  } catch (err) {
    const re = err instanceof ReloadlyError ? err : null;
    const reason = re
      ? re.outcomeUnknown
        ? "Provider outcome unknown after submission — reconciling with provider."
        : `Provider rejected the order: ${friendlyReloadlyMessage(re)}`
      : `Unexpected error during fulfilment: ${errorMessage(err)}`;
    log.error("utility_order.fulfilment_failed", { ref: order.ref, errorCode: re?.errorCode, outcomeUnknown: re?.outcomeUnknown });
    return (
      (await transition(db, order, "requires_review", ["fulfilling"], {
        status_reason: reason,
        provider_status: re?.errorCode ?? "ERROR",
      })) ?? order
    );
  }
}

async function pollProvider(db: Db, order: OrderRow): Promise<OrderRow> {
  const id = order.provider_transaction_id as string | null;
  if (!id) return order;
  // Don't hammer the provider: at most every 10s per order.
  if (Date.now() - new Date(order.updated_at as string).getTime() < 10_000) return order;
  try {
    if (order.service === "electricity") {
      const raw = await getUtilityTransaction(id);
      const t = raw?.transaction;
      const status = (t?.status ?? "").toUpperCase();
      if (status === "SUCCESSFUL") {
        return (
          (await transition(db, order, "successful", ["provider_pending"], {
            provider_status: status,
            provider_response: raw,
            delivery_details: { billDetails: t?.billDetails ?? null, token: extractToken(t?.billDetails) },
            fulfilled_at: new Date(),
            status_reason: null,
          })) ?? order
        );
      }
      if (status === "FAILED" || status === "REFUNDED") {
        return (await transition(db, order, "requires_review", ["provider_pending"], { provider_status: status, provider_response: raw, status_reason: `Provider reported ${status}. Refund required.` })) ?? order;
      }
      await db.query("update utility_orders set updated_at = now(), provider_status = $2 where id = $1", [order.id, status || "PROCESSING"]);
      return { ...order, provider_status: status || "PROCESSING" } as OrderRow;
    }
    const res = await reloadlyRequest<TopupResponse>("airtime", "GET", `/topups/${encodeURIComponent(id)}/status`);
    const status = (res.status ?? "").toUpperCase();
    if (status === "SUCCESSFUL") {
      return (await transition(db, order, "successful", ["provider_pending"], { provider_status: status, provider_response: res, delivery_details: topupDelivery(res), fulfilled_at: new Date(), status_reason: null })) ?? order;
    }
    if (status === "FAILED" || status === "REFUNDED") {
      return (await transition(db, order, "requires_review", ["provider_pending"], { provider_status: status, provider_response: res, status_reason: `Provider reported ${status}. Refund required.` })) ?? order;
    }
    await db.query("update utility_orders set updated_at = now(), provider_status = $2 where id = $1", [order.id, status || "PENDING"]);
    return order;
  } catch (err) {
    log.warn("utility_order.poll_failed", { ref: order.ref, error: errorMessage(err) });
    return order;
  }
}

interface UtilityTransactionResponse {
  code?: string;
  message?: string;
  transaction?: { id: number; status: string; billDetails?: Record<string, unknown> };
}

async function getUtilityTransaction(id: string): Promise<UtilityTransactionResponse | null> {
  // Reloadly's spec lists /transactions/{id}; older docs used /transaction/{id}.
  for (const path of [`/transactions/${encodeURIComponent(id)}`, `/transaction/${encodeURIComponent(id)}`]) {
    try {
      const r = await reloadlyRequest<UtilityTransactionResponse | UtilityTransactionResponse[]>("utilities", "GET", path);
      return Array.isArray(r) ? r[0] ?? null : r;
    } catch (err) {
      if (err instanceof ReloadlyError && err.status === 404) continue;
      throw err;
    }
  }
  return null;
}

function extractToken(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const pin = (details.pinDetails ?? details.pinDetail) as Record<string, unknown> | undefined;
  const token = pin?.token ?? pin?.code ?? details.token;
  return typeof token === "string" || typeof token === "number" ? String(token) : null;
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
