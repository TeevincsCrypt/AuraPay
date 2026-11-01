import "server-only";
import type { PayCurrency, PortfolioDTO, PositionDTO, StockQuote } from "@/lib/shared/types";
import { config } from "./config";
import { getDb, iso, num } from "./db";
import { AppError } from "./http";
import { insertLedger, newRef } from "./ledger";
import { getQuote, getQuotes } from "./market";
import { convertUsd, getRatesSafe } from "./rates";

/**
 * Investing.
 *
 * Market data ≠ ownership. Real execution requires a contracted brokerage or
 * tokenised-equity provider (see docs/INTEGRATIONS.md). None is configured, so:
 *   - `brokerageStatus()` reports "unavailable" with the reason.
 *   - In development/demo modes users can place SIMULATED orders that create
 *     simulated positions (is_simulated = true). No payment is taken.
 *   - Simulated positions are never presented as real shares.
 */

export const BROKERAGE_FEE_BPS = 50; // illustrative execution fee used in simulations and estimates

export function brokerageStatus(): { state: "connected" | "unavailable"; provider?: string; reason: string } {
  if (config.brokerage.provider) {
    return {
      state: "unavailable",
      provider: config.brokerage.provider,
      reason: `Brokerage "${config.brokerage.provider}" is named but its adapter is not implemented yet.`,
    };
  }
  return {
    state: "unavailable",
    reason: "No brokerage or tokenised-equity provider is connected. Orders cannot be executed for real.",
  };
}

export interface OrderEstimate {
  symbol: string;
  price: number;
  priceSource: StockQuote["source"];
  notionalUsd: number;
  feeUsd: number;
  quantity: number;
  payCurrency: Exclude<PayCurrency, "DEMO">;
  payAmount: number | null;
  exchangeRate: number | null;
  rateSource: string | null;
  ratesError?: string;
}

export async function estimateOrder(symbol: string, notionalUsd: number, payCurrency: "NIM" | "USDT"): Promise<OrderEstimate> {
  if (!(notionalUsd >= 1 && notionalUsd <= 10_000)) throw new AppError("INVALID_AMOUNT", "Enter an amount between $1 and $10,000.", 422);
  const q = await getQuote(symbol);
  if (!q) throw new AppError("UNKNOWN_SYMBOL", "Unsupported stock.", 404);
  if (q.price === null) throw new AppError("PRICE_UNAVAILABLE", "A live price isn't available for this stock right now.", 503);
  const feeUsd = Math.round(notionalUsd * BROKERAGE_FEE_BPS) / 10_000;
  const quantity = (notionalUsd - feeUsd) / q.price;
  const { rates, error } = await getRatesSafe();
  const conv = rates ? convertUsd(notionalUsd, payCurrency, rates, { usdtTag: 1 }) : null;
  return {
    symbol: q.symbol,
    price: q.price,
    priceSource: q.source,
    notionalUsd,
    feeUsd,
    quantity: Math.floor(quantity * 1e6) / 1e6,
    payCurrency,
    payAmount: conv ? (payCurrency === "USDT" ? Math.ceil(notionalUsd * 100 / Math.min(rates!.usdtUsd, 1)) / 100 : conv.amount) : null,
    exchangeRate: conv?.rate ?? null,
    rateSource: rates?.source ?? null,
    ratesError: error,
  };
}

export async function placeSimulatedOrder(
  userId: string,
  input: { symbol: string; notionalUsd: number; payCurrency: "NIM" | "USDT"; clientRequestId: string },
) {
  if (!config.simulatorsAllowed) {
    throw new AppError("EXECUTION_UNAVAILABLE", brokerageStatus().reason, 503);
  }
  const est = await estimateOrder(input.symbol, input.notionalUsd, input.payCurrency);
  const db = await getDb();
  const ref = newRef("SO");

  return db.transaction(async (tx) => {
    // Idempotency on client request id (stored in the ref-less ledger details).
    const dup = await tx.query<{ ref: string }>(
      "select ref from transactions where user_id = $1 and category = 'stock_purchase' and details->>'clientRequestId' = $2",
      [userId, input.clientRequestId],
    );
    if (dup[0]) return { ref: dup[0].ref, duplicate: true };

    const rows = await tx.query<{ id: string }>(
      `insert into stock_orders (ref, user_id, symbol, side, notional_usd, quantity, price_usd, fee_usd, pay_currency, pay_amount,
         exchange_rate, price_source, status, is_simulated, execution_provider, filled_at)
       values ($1,$2,$3,'buy',$4,$5,$6,$7,$8,$9,$10,$11,'simulated_filled',true,'simulator',now()) returning id`,
      [ref, userId, est.symbol, est.notionalUsd, est.quantity, est.price, est.feeUsd, est.payCurrency, est.payAmount ?? est.notionalUsd, est.exchangeRate, est.priceSource],
    );
    await tx.query(
      `insert into stock_positions (user_id, symbol, quantity, cost_basis_usd, is_simulated, provider)
       values ($1,$2,$3,$4,true,'simulator')
       on conflict (user_id, symbol, is_simulated) do update set
         quantity = stock_positions.quantity + excluded.quantity,
         cost_basis_usd = stock_positions.cost_basis_usd + excluded.cost_basis_usd,
         updated_at = now()`,
      [userId, est.symbol, est.quantity, est.notionalUsd],
    );
    await insertLedger(tx, {
      ref,
      userId,
      category: "stock_purchase",
      title: `Bought ${est.symbol}`,
      subtitle: `${est.quantity.toFixed(6)} shares · simulated`,
      amount: est.notionalUsd,
      currency: "USD",
      amountUsd: est.notionalUsd,
      status: "successful",
      isSimulated: true,
      environment: "simulated",
      provider: "simulator",
      sourceTable: "stock_orders",
      sourceId: rows[0].id,
      details: {
        clientRequestId: input.clientRequestId,
        symbol: est.symbol,
        quantity: est.quantity,
        price: est.price,
        priceSource: est.priceSource,
        feeUsd: est.feeUsd,
        payCurrency: est.payCurrency,
        estimatedPayAmount: est.payAmount,
        note: "Simulated order. No payment was taken and no shares were purchased.",
      },
    });
    return { ref, duplicate: false };
  });
}

export async function getPortfolio(userId: string): Promise<PortfolioDTO> {
  const db = await getDb();
  const rows = await db.query(
    "select symbol, quantity, cost_basis_usd, is_simulated, verified_at from stock_positions where user_id = $1 and quantity > 0 order by cost_basis_usd desc",
    [userId],
  );
  const quotes = new Map((await getQuotes()).map((q) => [q.symbol, q]));
  const positions: PositionDTO[] = rows.map((r) => {
    const symbol = String(r.symbol);
    const q = quotes.get(symbol);
    const quantity = num(r.quantity);
    const cost = num(r.cost_basis_usd);
    const price = q?.price ?? null;
    const mv = price !== null ? quantity * price : null;
    return {
      symbol,
      name: q?.name ?? symbol,
      quantity,
      avgPrice: quantity > 0 ? cost / quantity : 0,
      costBasisUsd: cost,
      price,
      marketValueUsd: mv,
      unrealizedPnlUsd: mv !== null ? mv - cost : null,
      unrealizedPnlPercent: mv !== null && cost > 0 ? ((mv - cost) / cost) * 100 : null,
      dayChangeUsd: q?.change != null ? q.change * quantity : null,
      isSimulated: Boolean(r.is_simulated),
      verified: Boolean(r.verified_at) && !r.is_simulated,
      priceSource: q?.source ?? "unavailable",
    };
  });
  const invested = positions.reduce((s, p) => s + p.costBasisUsd, 0);
  const allPriced = positions.every((p) => p.marketValueUsd !== null);
  const mv = allPriced ? positions.reduce((s, p) => s + (p.marketValueUsd ?? 0), 0) : null;
  const day = allPriced ? positions.reduce((s, p) => s + (p.dayChangeUsd ?? 0), 0) : null;
  return {
    positions,
    totals: {
      investedUsd: invested,
      marketValueUsd: mv,
      dayChangeUsd: day,
      dayChangePercent: mv !== null && day !== null && mv - day > 0 ? (day / (mv - day)) * 100 : null,
      totalPnlUsd: mv !== null ? mv - invested : null,
      totalPnlPercent: mv !== null && invested > 0 ? ((mv - invested) / invested) * 100 : null,
    },
    hasSimulated: positions.some((p) => p.isSimulated),
    hasVerified: positions.some((p) => p.verified),
  };
}

export async function listStockOrders(userId: string) {
  const db = await getDb();
  const rows = await db.query("select * from stock_orders where user_id = $1 order by created_at desc limit 50", [userId]);
  return rows.map((r) => ({
    ref: String(r.ref),
    symbol: String(r.symbol),
    notionalUsd: num(r.notional_usd),
    quantity: num(r.quantity),
    priceUsd: num(r.price_usd),
    status: String(r.status),
    isSimulated: Boolean(r.is_simulated),
    createdAt: iso(r.created_at),
  }));
}
