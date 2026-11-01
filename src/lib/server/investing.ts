import "server-only";
import { formatUnits } from "viem";
import type { HoldingDTO, PortfolioDTO, StockTradeDTO } from "@/lib/shared/types";
import { STOCK_TOKENS, type StockToken } from "@/lib/shared/stock-tokens";
import { AAVE_CHAIN_ID } from "@/lib/shared/aave";
import { verifiedEvmAddresses } from "./auth/challenges";
import { tokenPrices } from "./coingecko";
import { config, testOverride } from "./config";
import { getDb, iso, num } from "./db";
import { erc20Balances } from "./evm";
import { AppError } from "./http";
import { insertLedger, newRef, updateLedgerBySource } from "./ledger";
import { getBorrowOverview } from "./lending";
import { errorMessage, log } from "./log";
import { stockRefs } from "./market";

/**
 * Real investing with tokenised stocks.
 *
 * Purchases are executed by the user's own wallet through CoW Protocol (the CoW Swap
 * widget embedded on the stock page). AuraPay records the posted order, then verifies
 * its status and fills against CoW's public order book. Holdings are read on-chain:
 * the ERC-20 balances of the user's verified EVM wallets plus any tokens supplied to
 * Aave V4 as collateral — ownership is what the chain says, nothing else.
 */

export function investingStatus() {
  return { state: "live" as const, provider: "CoW Protocol + on-chain balances", reason: "Tokenised stocks bought through CoW Protocol and held in your own wallet." };
}

const COW_NETWORK: Record<number, string> = { 1: "mainnet", 100: "xdai", 137: "polygon", 8453: "base", 42161: "arbitrum_one", 56: "bnb", 43114: "avalanche" };

function cowApi(chainId: number): string {
  const net = COW_NETWORK[chainId];
  if (!net) throw new AppError("UNSUPPORTED_CHAIN", "Unsupported network for stock orders.", 422);
  const mock = testOverride("COW_API_URL_OVERRIDE");
  return mock ? `${mock.replace(/\/$/, "")}/${net}` : `https://api.cow.fi/${net}`;
}

const STABLES = new Set(["USDT", "USDC", "USDT0", "USDBC", "USDC.E", "DAI"]);

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface RecordTradeInput {
  symbol: string;
  orderUid: string;
  chainId: number;
  destinationChainId?: number | null;
  owner: string;
  inputToken: { address: string; symbol: string; decimals: number };
  inputAmount: string;
  outputToken: { address: string };
  outputAmount: string;
}

export async function recordTrade(userId: string, input: RecordTradeInput) {
  const symbol = input.symbol.toUpperCase();
  const reg = STOCK_TOKENS[symbol];
  if (!reg) throw new AppError("UNKNOWN_SYMBOL", "Unsupported stock.", 404);
  const owners = await verifiedEvmAddresses(userId);
  if (!owners.includes(input.owner.toLowerCase())) throw new AppError("WALLET_NOT_VERIFIED", "This wallet isn't verified for your account.", 403);
  const target = input.destinationChainId ?? input.chainId;
  const token = reg.all.find((t) => t.chainId === target && t.address.toLowerCase() === input.outputToken.address.toLowerCase());
  const crossChain = target !== input.chainId;
  if (!token && !crossChain) throw new AppError("TOKEN_MISMATCH", "This order doesn't buy the selected stock token.", 422);

  const db = await getDb();
  const ref = newRef("ST");
  const isStable = STABLES.has(input.inputToken.symbol.toUpperCase());
  const sellUsd = isStable ? Number(formatUnits(BigInt(input.inputAmount), input.inputToken.decimals)) : null;
  try {
    const rows = await db.query<{ id: string }>(
      `insert into stock_trades (ref, user_id, provider, order_uid, chain_id, target_chain_id, owner, symbol, token_address,
         sell_token, sell_amount_atomic, sell_decimals, buy_amount_atomic, status)
       values ($1,$2,'cow',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open') returning id`,
      [ref, userId, input.orderUid, input.chainId, crossChain ? target : null, input.owner.toLowerCase(), symbol, (token ?? reg.primary).address,
        `${input.inputToken.symbol}:${input.inputToken.address}`, input.inputAmount, input.inputToken.decimals, input.outputAmount],
    );
    await insertLedger(db, {
      ref,
      userId,
      category: "stock_purchase",
      title: `Bought ${symbol}`,
      subtitle: `${(token ?? reg.primary).symbol} · CoW Protocol`,
      amount: Number(formatUnits(BigInt(input.inputAmount), input.inputToken.decimals)),
      currency: input.inputToken.symbol,
      amountUsd: sellUsd,
      status: "pending",
      isSimulated: false,
      environment: "production",
      provider: "cow",
      providerRef: input.orderUid,
      sourceTable: "stock_trades",
      sourceId: rows[0].id,
      details: { chainId: input.chainId, targetChainId: target, token: (token ?? reg.primary).symbol },
    });
  } catch (err) {
    if (/unique|duplicate/i.test(errorMessage(err))) return { ref: null, duplicate: true };
    throw err;
  }
  void refreshTrades(userId).catch(() => {});
  return { ref, duplicate: false };
}

interface CowOrder {
  uid: string;
  owner: string;
  status: "presignaturePending" | "open" | "fulfilled" | "cancelled" | "expired";
  executedSellAmount?: string;
  executedSellAmountBeforeFees?: string;
  executedBuyAmount?: string;
}

/** Re-checks open orders against CoW's order book (the source of truth for fills). */
export async function refreshTrades(userId: string) {
  const db = await getDb();
  const open = await db.query<{ id: string; order_uid: string; chain_id: number; owner: string; status: string }>(
    "select id, order_uid, chain_id, owner, status from stock_trades where user_id = $1 and status in ('open','unknown') and created_at > now() - interval '30 days'",
    [userId],
  );
  for (const t of open) {
    try {
      const res = await fetch(`${cowApi(t.chain_id)}/api/v1/orders/${t.order_uid}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`CoW HTTP ${res.status}`);
      const o = (await res.json()) as CowOrder;
      if (o.owner.toLowerCase() !== t.owner) {
        await db.query("update stock_trades set status = 'unknown', provider_status = 'owner_mismatch', updated_at = now() where id = $1", [t.id]);
        continue;
      }
      const status = o.status === "fulfilled" ? "fulfilled" : o.status === "cancelled" ? "cancelled" : o.status === "expired" ? "expired" : "open";
      if (status === "open") continue;
      await db.transaction(async (tx) => {
        await tx.query(
          "update stock_trades set status = $2, provider_status = $3, executed_sell_atomic = $4, executed_buy_atomic = $5, updated_at = now() where id = $1",
          [t.id, status, o.status, o.executedSellAmountBeforeFees ?? o.executedSellAmount ?? null, o.executedBuyAmount ?? null],
        );
        await updateLedgerBySource(tx, "stock_trades", t.id, "stock_purchase", { status: status === "fulfilled" ? "successful" : "failed" });
      });
    } catch (err) {
      log.warn("invest.trade_refresh_failed", { error: errorMessage(err) });
    }
  }
}

export async function listTrades(userId: string): Promise<StockTradeDTO[]> {
  const db = await getDb();
  const rows = await db.query("select * from stock_trades where user_id = $1 order by created_at desc limit 50", [userId]);
  return rows.map((r) => {
    const dec = num(r.sell_decimals);
    const toNum = (v: unknown, d: number) => (v ? Number(formatUnits(BigInt(String(v)), d)) : null);
    return {
      ref: String(r.ref),
      symbol: String(r.symbol),
      orderUid: String(r.order_uid),
      chainId: num(r.chain_id),
      targetChainId: r.target_chain_id ? num(r.target_chain_id) : null,
      status: r.status as StockTradeDTO["status"],
      sellAmount: toNum(r.sell_amount_atomic, dec),
      executedSellAmount: toNum(r.executed_sell_atomic, dec),
      executedBuyAmount: null,
      createdAt: iso(r.created_at)!,
    };
  });
}

// ---------------------------------------------------------------------------
// Portfolio (on-chain)
// ---------------------------------------------------------------------------

export async function getPortfolio(userId: string): Promise<PortfolioDTO> {
  const owners = await verifiedEvmAddresses(userId);
  const errors: string[] = [];
  if (!owners.length) {
    return { evmAddresses: [], holdings: [], totals: { valueUsd: 0, dayChangeUsd: 0, dayChangePercent: null, costBasisUsd: null, totalPnlUsd: null, totalPnlPercent: null }, errors };
  }
  await refreshTrades(userId).catch(() => {});
  const refs = new Map((await stockRefs()).map((r) => [r.symbol, r]));

  // Wallet balances, grouped per chain.
  const entries: { symbol: string; token: StockToken; owner: string }[] = [];
  for (const [symbol, reg] of Object.entries(STOCK_TOKENS)) for (const token of reg.all) for (const owner of owners) entries.push({ symbol, token, owner });
  const byChain = new Map<number, typeof entries>();
  for (const e of entries) byChain.set(e.token.chainId, [...(byChain.get(e.token.chainId) ?? []), e]);
  const balances = new Map<(typeof entries)[number], bigint>();
  await Promise.all(
    [...byChain.entries()].map(async ([chainId, list]) => {
      try {
        const res = await erc20Balances(chainId, list.map((e) => ({ token: e.token.address, owner: e.owner })));
        list.forEach((e, i) => res[i] && res[i]! > 0n && balances.set(e, res[i]!));
      } catch (err) {
        errors.push(`Couldn't read balances on chain ${chainId}.`);
        log.warn("invest.balances_failed", { chainId, error: errorMessage(err) });
      }
    }),
  );

  // Tokens supplied to Aave V4 (still the user's), keyed by underlying address.
  const supplied = new Map<string, number>();
  try {
    const ov = await getBorrowOverview(userId);
    for (const r of ov.reserves) if (r.supplied > 0) supplied.set(r.underlying.toLowerCase(), r.supplied);
  } catch {
    errors.push("Couldn't read collateral supplied to Aave.");
  }

  const prices = await tokenPrices(entries.map((e) => e.token.coingeckoId)).catch(() => {
    errors.push("Live token prices are unavailable right now.");
    return new Map();
  });

  // Cost basis from fulfilled stablecoin purchases recorded by AuraPay.
  const db = await getDb();
  const trades = await db.query(
    "select symbol, sell_token, sell_decimals, executed_sell_atomic from stock_trades where user_id = $1 and status = 'fulfilled'",
    [userId],
  );
  const cost = new Map<string, number>();
  for (const t of trades) {
    const sym = String(t.sell_token ?? "").split(":")[0].toUpperCase();
    if (!STABLES.has(sym) || !t.executed_sell_atomic) continue;
    cost.set(String(t.symbol), (cost.get(String(t.symbol)) ?? 0) + Number(formatUnits(BigInt(String(t.executed_sell_atomic)), num(t.sell_decimals))));
  }

  const holdings: HoldingDTO[] = [];
  for (const [symbol, reg] of Object.entries(STOCK_TOKENS)) {
    for (const token of reg.all) {
      const walletQty = owners.reduce((s, owner) => {
        const e = entries.find((x) => x.symbol === symbol && x.token === token && x.owner === owner)!;
        const b = balances.get(e);
        return s + (b ? Number(formatUnits(b, token.decimals)) : 0);
      }, 0);
      const suppliedQty = token.chainId === AAVE_CHAIN_ID ? supplied.get(token.address.toLowerCase()) ?? 0 : 0;
      const qty = walletQty + suppliedQty;
      if (qty <= 0) continue;
      const p = prices.get(token.coingeckoId);
      const value = p ? qty * p.usd : null;
      const day = p && p.change24h !== null ? value! - value! / (1 + p.change24h / 100) : null;
      holdings.push({
        symbol,
        name: refs.get(symbol)?.name ?? symbol,
        tokenSymbol: token.symbol,
        issuer: token.issuer,
        chainId: token.chainId,
        tokenAddress: token.address,
        owner: owners[0],
        walletQuantity: walletQty,
        suppliedQuantity: suppliedQty,
        quantity: qty,
        tokenPriceUsd: p?.usd ?? null,
        valueUsd: value,
        dayChangeUsd: day,
        costBasisUsd: null,
        unrealizedPnlUsd: null,
      });
    }
  }
  // Attribute recorded cost basis to the primary holding of each symbol.
  for (const [symbol, c] of cost) {
    const h = holdings.find((x) => x.symbol === symbol);
    if (h) {
      h.costBasisUsd = c;
      h.unrealizedPnlUsd = h.valueUsd !== null ? h.valueUsd - c : null;
    }
  }

  const allPriced = holdings.every((h) => h.valueUsd !== null);
  const valueUsd = allPriced ? holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0) : null;
  const dayChangeUsd = allPriced ? holdings.reduce((s, h) => s + (h.dayChangeUsd ?? 0), 0) : null;
  const withCost = holdings.filter((h) => h.costBasisUsd !== null && h.valueUsd !== null);
  const costBasisUsd = withCost.length ? withCost.reduce((s, h) => s + h.costBasisUsd!, 0) : null;
  const pnl = withCost.length ? withCost.reduce((s, h) => s + h.unrealizedPnlUsd!, 0) : null;
  return {
    evmAddresses: owners,
    holdings: holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    totals: {
      valueUsd,
      dayChangeUsd,
      dayChangePercent: valueUsd && dayChangeUsd !== null && valueUsd - dayChangeUsd > 0 ? (dayChangeUsd / (valueUsd - dayChangeUsd)) * 100 : null,
      costBasisUsd,
      totalPnlUsd: pnl,
      totalPnlPercent: pnl !== null && costBasisUsd ? (pnl / costBasisUsd) * 100 : null,
    },
    errors,
  };
}

export function cowWidgetConfig() {
  return {
    appCode: config.cow.appCode,
    partnerFee: config.cow.partnerFeeBps > 0 && config.cow.partnerFeeRecipient ? { bps: config.cow.partnerFeeBps, recipient: config.cow.partnerFeeRecipient } : null,
  };
}
