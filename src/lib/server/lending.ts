import "server-only";
import { erc20Abi, formatUnits, type Abi } from "viem";
import type { BorrowOverviewDTO, LendingReserveDTO } from "@/lib/shared/types";
import {
  AAVE_CHAIN_ID,
  AAVE_MAG7_ORACLE,
  AAVE_MAG7_SPOKE,
  HUB_ABI,
  ORACLE_ABI,
  RAY,
  SPOKE_ABI,
  VALUE_PER_USD,
  WAD,
  tickerForReserve,
} from "@/lib/shared/aave";
import { verifiedEvmAddresses } from "./auth/challenges";
import { getDb } from "./db";
import { checkTransaction, readContracts } from "./evm";
import { AppError } from "./http";
import { insertLedger, newRef, updateLedgerBySource } from "./ledger";
import { errorMessage, log } from "./log";

/**
 * Real borrowing through Aave V4 (MAG7 spoke on Base). AuraPay never holds funds:
 * the user's own wallet supplies collateral, borrows and repays directly against
 * the Aave contracts. The server reads live protocol state and verifies the
 * transactions the app submitted before recording them in the activity ledger.
 */

const spokeAbi = SPOKE_ABI as unknown as Abi;

interface ReserveMeta {
  reserveId: number;
  underlying: string;
  hub: string;
  assetId: number;
  decimals: number;
  dynamicConfigKey: number;
  symbol: string;
  collateralFactor: number;
  paused: boolean;
  frozen: boolean;
  borrowable: boolean;
  priceUsd: number | null;
  borrowApr: number | null;
}

const g = globalThis as unknown as { __aaveMeta?: { at: number; value: ReserveMeta[] } };

export async function loadReserves(): Promise<ReserveMeta[]> {
  if (g.__aaveMeta && Date.now() - g.__aaveMeta.at < 60_000) return g.__aaveMeta.value;
  const [countRaw] = await readContracts(AAVE_CHAIN_ID, [{ to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getReserveCount" }]);
  const count = Number(countRaw ?? 0n);
  if (!count) throw new Error("Aave V4 spoke returned no reserves");
  const ids = Array.from({ length: Math.min(count, 32) }, (_, i) => i);

  const base = await readContracts(
    AAVE_CHAIN_ID,
    ids.flatMap((id) => [
      { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getReserve", args: [BigInt(id)] },
      { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [BigInt(id)] },
    ]),
  );
  type Reserve = { underlying: string; hub: string; assetId: number; decimals: number; dynamicConfigKey: number };
  type Cfg = { paused: boolean; frozen: boolean; borrowable: boolean };
  const reserves = ids.map((id) => ({ id, r: base[id * 2] as Reserve | null, c: base[id * 2 + 1] as Cfg | null })).filter((x) => x.r && x.c);

  const [extra, prices] = await Promise.all([
    readContracts(
      AAVE_CHAIN_ID,
      reserves.flatMap(({ id, r }) => [
        { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getDynamicReserveConfig", args: [BigInt(id), r!.dynamicConfigKey] },
        { to: r!.underlying, abi: erc20Abi as unknown as Abi, functionName: "symbol" },
        { to: r!.hub, abi: HUB_ABI as unknown as Abi, functionName: "getAssetDrawnRate", args: [BigInt(r!.assetId)] },
      ]),
    ),
    readContracts(AAVE_CHAIN_ID, [
      { to: AAVE_MAG7_ORACLE, abi: ORACLE_ABI as unknown as Abi, functionName: "getReservesPrices", args: [reserves.map((x) => BigInt(x.id))] },
    ]).catch(() => [null]),
  ]);
  const priceList = (prices[0] as bigint[] | null) ?? null;

  const value: ReserveMeta[] = reserves.map(({ id, r, c }, i) => {
    const dyn = extra[i * 3] as { collateralFactor: number } | null;
    const symbol = (extra[i * 3 + 1] as string | null) ?? "?";
    const rate = extra[i * 3 + 2] as bigint | null;
    const price = priceList?.[i];
    return {
      reserveId: id,
      underlying: r!.underlying,
      hub: r!.hub,
      assetId: Number(r!.assetId),
      decimals: Number(r!.decimals),
      dynamicConfigKey: Number(r!.dynamicConfigKey),
      symbol,
      collateralFactor: dyn ? Number(dyn.collateralFactor) / 10_000 : 0,
      paused: c!.paused,
      frozen: c!.frozen,
      borrowable: c!.borrowable,
      priceUsd: price ? Number(price) / 1e8 : null,
      borrowApr: c!.borrowable && rate !== null ? Number((rate * 1_000_000n) / RAY) / 1_000_000 : null,
    };
  });
  g.__aaveMeta = { at: Date.now(), value };
  return value;
}

export async function getBorrowOverview(userId: string): Promise<BorrowOverviewDTO> {
  const owners = await verifiedEvmAddresses(userId);
  const owner = owners[0] ?? null;
  let meta: ReserveMeta[];
  try {
    meta = await loadReserves();
  } catch (err) {
    log.warn("aave.reserves_failed", { error: errorMessage(err) });
    return {
      available: false,
      reason: "Couldn't reach Aave on Base right now. Please try again shortly.",
      chainId: AAVE_CHAIN_ID,
      spoke: AAVE_MAG7_SPOKE,
      owner,
      reserves: [],
      account: null,
    };
  }

  let account: BorrowOverviewDTO["account"] = null;
  const perReserve = new Map<number, { wallet: number; supplied: number; debt: number; collateral: boolean }>();
  if (owner) {
    const calls = meta.flatMap((m) => [
      { to: m.underlying, abi: erc20Abi as unknown as Abi, functionName: "balanceOf", args: [owner] },
      { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(m.reserveId), owner] },
      { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(m.reserveId), owner] },
      { to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getUserReserveStatus", args: [BigInt(m.reserveId), owner] },
    ]);
    let res: unknown[];
    let acct: unknown[];
    try {
      [res, acct] = await Promise.all([
        readContracts(AAVE_CHAIN_ID, calls),
        readContracts(AAVE_CHAIN_ID, [{ to: AAVE_MAG7_SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [owner] }]),
      ]);
    } catch (err) {
      log.warn("aave.position_failed", { error: errorMessage(err) });
      return { available: false, reason: "Couldn't read your Aave position on Base right now. Please try again shortly.", chainId: AAVE_CHAIN_ID, spoke: AAVE_MAG7_SPOKE, owner, reserves: [], account: null };
    }
    meta.forEach((m, i) => {
      const n = (v: unknown) => (typeof v === "bigint" ? Number(formatUnits(v, m.decimals)) : 0);
      const status = res[i * 4 + 3] as [boolean, boolean] | null;
      perReserve.set(m.reserveId, { wallet: n(res[i * 4]), supplied: n(res[i * 4 + 1]), debt: n(res[i * 4 + 2]), collateral: Boolean(status?.[0]) });
    });
    const a = acct[0] as {
      riskPremium: bigint;
      avgCollateralFactor: bigint;
      healthFactor: bigint;
      totalCollateralValue: bigint;
      totalDebtValueRay: bigint;
    } | null;
    if (a) {
      const collateralUsd = Number((a.totalCollateralValue * 100n) / VALUE_PER_USD) / 100;
      const debtUsd = Number((a.totalDebtValueRay * 100n) / (VALUE_PER_USD * RAY)) / 100;
      const avgCf = Number((a.avgCollateralFactor * 10_000n) / WAD) / 10_000;
      const hf = a.healthFactor > 10n ** 30n ? null : Number((a.healthFactor * 1000n) / WAD) / 1000;
      account = {
        healthFactor: debtUsd > 0 ? hf : null,
        collateralUsd,
        debtUsd,
        avgCollateralFactor: collateralUsd > 0 ? avgCf : null,
        riskPremiumBps: Number(a.riskPremium),
        borrowCapacityUsd: Math.max(0, collateralUsd * avgCf - debtUsd),
      };
    }
  }

  const reserves: LendingReserveDTO[] = meta.map((m) => {
    const u = perReserve.get(m.reserveId);
    return {
      reserveId: m.reserveId,
      symbol: m.symbol,
      ticker: tickerForReserve(m.underlying),
      underlying: m.underlying,
      decimals: m.decimals,
      priceUsd: m.priceUsd,
      collateralFactor: m.collateralFactor,
      borrowable: m.borrowable,
      paused: m.paused,
      frozen: m.frozen,
      borrowApr: m.borrowApr,
      walletBalance: u?.wallet ?? 0,
      supplied: u?.supplied ?? 0,
      usingAsCollateral: u?.collateral ?? false,
      debt: u?.debt ?? 0,
    };
  });

  return {
    available: true,
    reason: owner ? null : "Verify your EVM wallet to borrow against your stock tokens.",
    chainId: AAVE_CHAIN_ID,
    spoke: AAVE_MAG7_SPOKE,
    owner,
    reserves,
    account,
  };
}

// ---------------------------------------------------------------------------
// Recording & verifying user-submitted Aave transactions
// ---------------------------------------------------------------------------

export type LendingAction = "approve" | "supply" | "withdraw" | "borrow" | "repay" | "set_collateral";

const LEDGER: Partial<Record<LendingAction, { category: "loan_disbursement" | "loan_repayment" | "collateral_deposit" | "collateral_withdrawal"; title: string }>> = {
  borrow: { category: "loan_disbursement", title: "Borrowed on Aave" },
  repay: { category: "loan_repayment", title: "Loan repayment" },
  supply: { category: "collateral_deposit", title: "Collateral added" },
  withdraw: { category: "collateral_withdrawal", title: "Collateral withdrawn" },
};

export async function recordLendingAction(
  userId: string,
  input: { action: LendingAction; reserveId: number | null; owner: string; txHash: string; amountAtomic: string | null },
) {
  const owners = await verifiedEvmAddresses(userId);
  if (!owners.includes(input.owner.toLowerCase())) throw new AppError("WALLET_NOT_VERIFIED", "This wallet isn't verified for your account.", 403);
  const meta = await loadReserves().catch(() => {
    throw new AppError("LENDING_UNAVAILABLE", "Couldn't reach Aave on Base. Your transaction was sent; refresh shortly to record it.", 503);
  });
  const reserve = input.reserveId !== null ? meta.find((m) => m.reserveId === input.reserveId) : undefined;
  if (input.reserveId !== null && !reserve) throw new AppError("RESERVE_NOT_FOUND", "Unknown Aave reserve.", 422);

  const db = await getDb();
  const ref = newRef("AV");
  const amount = reserve && input.amountAtomic ? Number(formatUnits(BigInt(input.amountAtomic), reserve.decimals)) : null;
  try {
    const rows = await db.query<{ id: string }>(
      `insert into lending_actions (ref, user_id, chain_id, spoke, action, reserve_id, symbol, amount_atomic, decimals, owner, tx_hash, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'submitted') returning id`,
      [ref, userId, AAVE_CHAIN_ID, AAVE_MAG7_SPOKE, input.action, input.reserveId, reserve?.symbol ?? null, input.amountAtomic, reserve?.decimals ?? null, input.owner.toLowerCase(), input.txHash.toLowerCase()],
    );
    const l = LEDGER[input.action];
    if (l && reserve && amount !== null) {
      await insertLedger(db, {
        ref,
        userId,
        category: l.category,
        title: `${l.title} · ${reserve.symbol}`,
        subtitle: "Aave V4 · Base",
        amount,
        currency: reserve.symbol,
        amountUsd: reserve.priceUsd !== null ? amount * reserve.priceUsd : null,
        status: "pending",
        isSimulated: false,
        environment: "production",
        provider: "aave-v4",
        chainTxHash: input.txHash.toLowerCase(),
        sourceTable: "lending_actions",
        sourceId: rows[0].id,
        details: { action: input.action, reserveId: input.reserveId, chainId: AAVE_CHAIN_ID },
      });
    }
  } catch (err) {
    if (/unique|duplicate/i.test(errorMessage(err))) throw new AppError("TX_ALREADY_RECORDED", "This transaction was already recorded.", 409);
    throw err;
  }
  return refreshLendingAction(userId, input.txHash.toLowerCase());
}

export async function refreshLendingAction(userId: string, txHash: string) {
  const db = await getDb();
  const rows = await db.query<{ id: string; action: LendingAction; owner: string; status: string; reserve_id: number | null }>(
    "select * from lending_actions where tx_hash = $1 and user_id = $2",
    [txHash.toLowerCase(), userId],
  );
  const a = rows[0];
  if (!a) throw new AppError("NOT_FOUND", "Not found.", 404);
  if (a.status !== "submitted") return { status: a.status };
  let expectTo: string | undefined = AAVE_MAG7_SPOKE;
  if (a.action === "approve") {
    const meta = await loadReserves();
    expectTo = meta.find((m) => m.reserveId === a.reserve_id)?.underlying;
  }
  const check = await checkTransaction(AAVE_CHAIN_ID, txHash, { from: a.owner, to: expectTo }).catch(() => ({ state: "pending" as const }));
  if (check.state === "pending") return { status: "submitted" };
  const status = check.state === "confirmed" ? "confirmed" : "failed";
  await db.transaction(async (tx) => {
    await tx.query("update lending_actions set status = $2, confirmed_at = now(), failure_reason = $3 where id = $1 and status = 'submitted'", [a.id, status, check.reason ?? null]);
    const l = LEDGER[a.action];
    if (l) await updateLedgerBySource(tx, "lending_actions", a.id, l.category, { status: status === "confirmed" ? "successful" : "failed" });
  });
  g.__aaveMeta = undefined; // positions changed
  return { status };
}
