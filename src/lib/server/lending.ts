import "server-only";
import type { LoanDTO } from "@/lib/shared/types";
import { config } from "./config";
import { getDb, iso, num, type Db } from "./db";
import { AppError } from "./http";
import { insertLedger, newRef } from "./ledger";
import { getQuotes } from "./market";

/**
 * Asset-backed lending.
 *
 * No real lending protocol/provider is integrated (that requires custody or
 * on-chain locking of verifiable collateral, real USDT liquidity, liquidation
 * and repayment rails). Therefore:
 *   - `lendingStatus()` reports the truth.
 *   - The simulator only accepts SIMULATED positions as collateral and never
 *     moves real funds. Every record is is_simulated = true.
 */

/** Share of an asset's market value that can be borrowed against (advance rate). */
export const ADVANCE_RATES: Record<string, number> = {
  AAPL: 0.4, MSFT: 0.4, GOOGL: 0.4, AMZN: 0.4, META: 0.4,
  NVDA: 0.35, AMD: 0.35, NFLX: 0.35,
  TSLA: 0.3,
  COIN: 0.25,
};

export const TERMS_DAYS = [30, 90, 180] as const;

export function lendingStatus(): { state: "connected" | "simulator" | "unavailable"; provider?: string; reason: string } {
  if (config.lending.provider) {
    return { state: "unavailable", provider: config.lending.provider, reason: `Lending provider "${config.lending.provider}" adapter is not implemented yet.` };
  }
  if (config.simulatorsAllowed) {
    return { state: "simulator", reason: "No lending provider is connected. Borrowing runs in a simulator with demo collateral; no real USDT is lent." };
  }
  return { state: "unavailable", reason: "No lending provider is connected." };
}

function accrued(principal: number, apr: number, openedAt: Date, until = new Date()): number {
  const days = Math.max(0, (until.getTime() - openedAt.getTime()) / 86400_000);
  return principal * apr * (days / 365);
}

async function lockedQuantities(db: Db, userId: string): Promise<Map<string, number>> {
  const rows = await db.query(
    `select c.symbol, sum(c.quantity) as qty from loan_collateral c join loans l on l.id = c.loan_id
     where l.user_id = $1 and l.status = 'active' group by c.symbol`,
    [userId],
  );
  return new Map(rows.map((r) => [String(r.symbol), num(r.qty)]));
}

export interface CollateralOption {
  symbol: string;
  name: string;
  quantity: number;
  lockedQuantity: number;
  availableQuantity: number;
  price: number | null;
  availableValue: number | null;
  advanceRate: number;
  borrowCapacity: number | null;
  isSimulated: boolean;
}

export async function getBorrowOverview(userId: string) {
  const db = await getDb();
  const quotes = new Map((await getQuotes()).map((q) => [q.symbol, q]));
  const locked = await lockedQuantities(db, userId);
  // Only simulated positions are usable here: they exist only inside the simulator.
  const positions = await db.query(
    "select symbol, quantity from stock_positions where user_id = $1 and is_simulated = true and quantity > 0",
    [userId],
  );
  const collateral: CollateralOption[] = positions.map((p) => {
    const symbol = String(p.symbol);
    const q = quotes.get(symbol);
    const quantity = num(p.quantity);
    const lockedQ = Math.min(quantity, locked.get(symbol) ?? 0);
    const available = Math.max(0, quantity - lockedQ);
    const price = q?.price ?? null;
    const rate = ADVANCE_RATES[symbol] ?? 0.25;
    return {
      symbol,
      name: q?.name ?? symbol,
      quantity,
      lockedQuantity: lockedQ,
      availableQuantity: available,
      price,
      availableValue: price !== null ? available * price : null,
      advanceRate: Math.min(rate, config.lending.maxLtv),
      borrowCapacity: price !== null ? available * price * Math.min(rate, config.lending.maxLtv) : null,
      isSimulated: true,
    };
  });

  const loans = await listLoans(userId);
  const active = loans.filter((l) => l.status === "active");
  const totalCollateral = collateral.reduce((s, c) => s + (c.price !== null ? c.quantity * c.price : 0), 0);
  const outstanding = active.reduce((s, l) => s + l.outstanding, 0);
  const capacity = collateral.reduce((s, c) => s + (c.borrowCapacity ?? 0), 0);
  const lockedValue = active.reduce((s, l) => s + (l.collateralValue ?? 0), 0);

  return {
    status: lendingStatus(),
    params: { maxLtv: config.lending.maxLtv, liquidationLtv: config.lending.liquidationLtv, apr: config.lending.simulatorApr, terms: TERMS_DAYS },
    collateral,
    loans,
    totals: {
      eligibleCollateralUsd: totalCollateral,
      lockedCollateralUsd: lockedValue,
      outstandingUsdt: outstanding,
      availableToBorrowUsdt: capacity,
      currentLtv: lockedValue > 0 ? outstanding / lockedValue : null,
      health: lockedValue > 0 && outstanding > 0 ? config.lending.liquidationLtv / (outstanding / lockedValue) : null,
    },
  };
}

export async function listLoans(userId: string): Promise<LoanDTO[]> {
  const db = await getDb();
  const quotes = new Map((await getQuotes()).map((q) => [q.symbol, q]));
  const loans = await db.query("select * from loans where user_id = $1 order by opened_at desc limit 50", [userId]);
  const out: LoanDTO[] = [];
  for (const l of loans) {
    const col = await db.query("select symbol, quantity, value_at_lock from loan_collateral where loan_id = $1", [l.id]);
    const collateral = col.map((c) => {
      const price = quotes.get(String(c.symbol))?.price ?? null;
      return { symbol: String(c.symbol), quantity: num(c.quantity), valueAtLock: num(c.value_at_lock), currentValue: price !== null ? num(c.quantity) * price : null };
    });
    const collateralValue = collateral.every((c) => c.currentValue !== null) ? collateral.reduce((s, c) => s + (c.currentValue ?? 0), 0) : null;
    const principal = num(l.principal_usdt);
    const apr = num(l.apr);
    const openedAt = new Date(l.opened_at as string);
    const closedAt = l.closed_at ? new Date(l.closed_at as string) : undefined;
    const interest = accrued(principal, apr, openedAt, closedAt);
    const repaid = num(l.repaid_usdt);
    const totalOwed = principal + interest;
    const outstanding = l.status === "active" ? Math.max(0, totalOwed - repaid) : 0;
    const currentLtv = collateralValue && collateralValue > 0 ? outstanding / collateralValue : null;
    out.push({
      id: String(l.id),
      ref: String(l.ref),
      isSimulated: Boolean(l.is_simulated),
      principalUsdt: principal,
      apr,
      termDays: num(l.term_days),
      maxLtv: num(l.max_ltv),
      liquidationLtv: num(l.liquidation_ltv),
      accruedInterest: interest,
      totalOwed,
      repaidUsdt: repaid,
      outstanding,
      collateral,
      collateralValue,
      currentLtv,
      health: currentLtv && currentLtv > 0 ? num(l.liquidation_ltv) / currentLtv : null,
      status: l.status as LoanDTO["status"],
      openedAt: iso(l.opened_at)!,
      dueAt: iso(l.due_at)!,
      closedAt: iso(l.closed_at),
    });
  }
  return out;
}

export async function openSimulatedLoan(
  userId: string,
  input: { amountUsdt: number; termDays: number; collateral: { symbol: string; quantity: number }[] },
) {
  if (lendingStatus().state !== "simulator") throw new AppError("LENDING_UNAVAILABLE", lendingStatus().reason, 503);
  if (!TERMS_DAYS.includes(input.termDays as (typeof TERMS_DAYS)[number])) throw new AppError("INVALID_TERM", "Choose a supported loan term.", 422);
  if (!(input.amountUsdt >= 10)) throw new AppError("AMOUNT_TOO_LOW", "Minimum loan is 10 USDT.", 422);

  const overview = await getBorrowOverview(userId);
  const bySymbol = new Map(overview.collateral.map((c) => [c.symbol, c]));
  let collateralValue = 0;
  let capacity = 0;
  const lines: { symbol: string; quantity: number; value: number }[] = [];
  for (const sel of input.collateral) {
    const opt = bySymbol.get(sel.symbol);
    if (!opt) throw new AppError("INELIGIBLE_COLLATERAL", `${sel.symbol} is not available as collateral.`, 422);
    if (!(sel.quantity > 0) || sel.quantity > opt.availableQuantity + 1e-9) throw new AppError("INSUFFICIENT_COLLATERAL", `Not enough ${sel.symbol} available.`, 422);
    if (opt.price === null) throw new AppError("PRICE_UNAVAILABLE", `No price for ${sel.symbol}; can't value collateral.`, 503);
    const value = sel.quantity * opt.price;
    collateralValue += value;
    capacity += value * opt.advanceRate;
    lines.push({ symbol: sel.symbol, quantity: sel.quantity, value });
  }
  if (lines.length === 0) throw new AppError("NO_COLLATERAL", "Select at least one asset as collateral.", 422);
  if (input.amountUsdt > capacity + 1e-6) {
    throw new AppError("EXCEEDS_CAPACITY", `You can borrow up to ${capacity.toFixed(2)} USDT against this collateral.`, 422);
  }

  const db = await getDb();
  const ref = newRef("LN");
  const apr = config.lending.simulatorApr;
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into loans (ref, user_id, is_simulated, provider, principal_usdt, apr, term_days, max_ltv, liquidation_ltv,
         collateral_value_at_open, status, due_at)
       values ($1,$2,true,'simulator',$3,$4,$5,$6,$7,$8,'active', now() + make_interval(days => $5::int)) returning id`,
      [ref, userId, input.amountUsdt, apr, input.termDays, config.lending.maxLtv, config.lending.liquidationLtv, collateralValue],
    );
    for (const l of lines) {
      await tx.query("insert into loan_collateral (loan_id, symbol, quantity, value_at_lock, is_simulated) values ($1,$2,$3,$4,true)", [rows[0].id, l.symbol, l.quantity, l.value]);
    }
    await insertLedger(tx, {
      ref,
      userId,
      category: "loan_disbursement",
      title: "Loan disbursed",
      subtitle: `${input.termDays}-day loan · simulated`,
      amount: input.amountUsdt,
      currency: "USDT",
      amountUsd: input.amountUsdt,
      status: "successful",
      isSimulated: true,
      environment: "simulated",
      provider: "simulator",
      sourceTable: "loans",
      sourceId: rows[0].id,
      details: { collateral: lines, apr, note: "Simulated loan. No USDT was sent to your wallet." },
    });
    return { ref };
  });
}

export async function repaySimulatedLoan(userId: string, loanId: string, amountUsdt: number) {
  if (lendingStatus().state !== "simulator") throw new AppError("LENDING_UNAVAILABLE", lendingStatus().reason, 503);
  const loan = (await listLoans(userId)).find((l) => l.id === loanId);
  if (!loan) throw new AppError("LOAN_NOT_FOUND", "Loan not found.", 404);
  if (loan.status !== "active") throw new AppError("LOAN_CLOSED", "This loan is already closed.", 409);
  if (!(amountUsdt > 0)) throw new AppError("INVALID_AMOUNT", "Enter a repayment amount.", 422);
  const pay = Math.min(amountUsdt, Math.ceil(loan.outstanding * 1e6) / 1e6);
  const closes = pay >= loan.outstanding - 1e-6;
  const db = await getDb();
  const ref = newRef("RP");
  await db.transaction(async (tx) => {
    const upd = await tx.query(
      `update loans set repaid_usdt = repaid_usdt + $3, updated_at = now(),
         status = case when $4 then 'repaid' else status end,
         closed_at = case when $4 then now() else closed_at end
       where id = $1 and user_id = $2 and status = 'active' returning id`,
      [loanId, userId, pay, closes],
    );
    if (!upd[0]) throw new AppError("LOAN_STATE_CHANGED", "Loan changed state. Refresh and try again.", 409);
    await insertLedger(tx, {
      ref,
      userId,
      category: "loan_repayment",
      title: closes ? "Loan repaid in full" : "Loan repayment",
      subtitle: `${loan.ref} · simulated`,
      amount: pay,
      currency: "USDT",
      amountUsd: pay,
      status: "successful",
      isSimulated: true,
      environment: "simulated",
      provider: "simulator",
      sourceTable: "loans",
      sourceId: loanId,
      details: { loanRef: loan.ref, closesLoan: closes, note: "Simulated repayment. No USDT was transferred." },
    });
  });
  return { ref, closed: closes };
}
