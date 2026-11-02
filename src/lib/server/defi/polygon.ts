import "server-only";
import { createPublicClient, http, getAddress, zeroAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { AAVE_POOL, AAVE_POOL_ABI, aaveApy, ERC20_ABI, fromUnits, QUICKSWAP_ROUTER, TOKENS, TRANSFER_TOPIC, V2_FACTORY_ABI, V2_PAIR_ABI, V2_ROUTER_ABI } from "@/lib/shared/polygon-defi";
import { verifiedEvmAddresses } from "../auth/challenges";
import { config } from "../config";
import { getDb, iso, num, type Db } from "../db";
import { AppError } from "../http";
import { insertLedger, newRef, updateLedgerBySource } from "../ledger";
import { errorMessage, log } from "../log";
import { polygonRpc } from "../payments/polygon";
import { getRatesSafe } from "../rates";

/**
 * Earn (Aave V3) and Swap (QuickSwap V2), both on Polygon PoS. The user's own wallet signs and
 * sends every transaction; the server only reads chain state and verifies receipts before an
 * action shows as completed. Nothing here custodies funds.
 */

const client = () => createPublicClient({ chain: polygon, transport: http(config.polygon.rpcUrl, { timeout: 12_000 }), batch: { multicall: false } });

const USDT = TOKENS.USDT.address;
const AUSDT = TOKENS.aPolUSDT.address;

// ---------------------------------------------------------------------------
// Earn position
// ---------------------------------------------------------------------------

export interface EarnPosition {
  address: string;
  walletUsdt: number;
  supplied: number; // aPolUSDT (principal + interest)
  pol: number; // gas balance
  allowance: number; // USDT approved to the Aave Pool
  apy: number | null; // live supply APY, e.g. 0.0375
  updatedAt: string;
}

export async function earnPosition(address: string): Promise<EarnPosition> {
  const c = client();
  const owner = getAddress(address);
  const [walletUsdt, supplied, allowance, pol, reserve] = await Promise.all([
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    c.readContract({ address: AUSDT, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "allowance", args: [owner, AAVE_POOL] }),
    c.getBalance({ address: owner }),
    c.readContract({ address: AAVE_POOL, abi: AAVE_POOL_ABI, functionName: "getReserveData", args: [USDT] }).catch((err) => {
      log.warn("earn.reserve_read_failed", { error: errorMessage(err) });
      return null;
    }),
  ]);
  return {
    address: owner.toLowerCase(),
    walletUsdt: fromUnits(walletUsdt, 6),
    supplied: fromUnits(supplied, 6),
    pol: fromUnits(pol, 18),
    allowance: fromUnits(allowance, 6),
    apy: reserve ? aaveApy(reserve.currentLiquidityRate) : null,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Swap (QuickSwap V2): enabled only when NIM exists on Polygon with a real pool
// ---------------------------------------------------------------------------

export interface SwapConfig {
  enabled: boolean;
  reason: string | null;
  nimToken: string | null;
  pair: string | null;
  reserves: { nim: number; usdt: number } | null;
  nimDecimals: number | null;
}

let swapCache: { at: number; value: SwapConfig } | null = null;

export async function swapConfig(): Promise<SwapConfig> {
  if (swapCache && Date.now() - swapCache.at < 5 * 60_000) return swapCache.value;
  const off = (reason: string, extra: Partial<SwapConfig> = {}): SwapConfig => ({ enabled: false, reason, nimToken: null, pair: null, reserves: null, nimDecimals: null, ...extra });
  let value: SwapConfig;
  const nim = config.nimPolygonToken;
  if (!nim || !/^0x[0-9a-fA-F]{40}$/.test(nim)) {
    value = off("NIM isn't on Polygon yet. Nimiq's bridge to Polygon has been announced; swapping opens as soon as NIM on Polygon has a QuickSwap pool.");
  } else {
    try {
      const c = client();
      const nimAddr = getAddress(nim);
      const factory = await c.readContract({ address: QUICKSWAP_ROUTER, abi: V2_ROUTER_ABI, functionName: "factory" });
      const pair = await c.readContract({ address: factory, abi: V2_FACTORY_ABI, functionName: "getPair", args: [nimAddr, USDT] });
      if (pair === zeroAddress) value = off("There's no QuickSwap NIM/USDT pool yet.", { nimToken: nimAddr.toLowerCase() });
      else {
        const [[r0, r1], token0, decimals] = await Promise.all([
          c.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "getReserves" }),
          c.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "token0" }),
          c.readContract({ address: nimAddr, abi: ERC20_ABI, functionName: "decimals" }),
        ]);
        const nimIs0 = token0.toLowerCase() === nimAddr.toLowerCase();
        const reserves = { nim: fromUnits(nimIs0 ? r0 : r1, decimals), usdt: fromUnits(nimIs0 ? r1 : r0, 6) };
        value = reserves.usdt < 1
          ? off("The QuickSwap NIM/USDT pool has no liquidity yet.", { nimToken: nimAddr.toLowerCase(), pair: pair.toLowerCase(), reserves, nimDecimals: decimals })
          : { enabled: true, reason: null, nimToken: nimAddr.toLowerCase(), pair: pair.toLowerCase(), reserves, nimDecimals: decimals };
      }
    } catch (err) {
      log.warn("swap.config_failed", { error: errorMessage(err) });
      value = off("Couldn't reach QuickSwap on Polygon right now.");
    }
  }
  swapCache = { at: Date.now(), value };
  return value;
}

export type SwapDirection = "NIM_USDT" | "USDT_NIM";

export async function swapQuote(direction: SwapDirection, amountInUnits: bigint): Promise<{ amountOut: string; path: string[]; priceImpact: number | null }> {
  const cfg = await swapConfig();
  if (!cfg.enabled || !cfg.nimToken) throw new AppError("SWAP_UNAVAILABLE", cfg.reason ?? "Swap is unavailable.", 409);
  const path = (direction === "NIM_USDT" ? [cfg.nimToken, USDT] : [USDT, cfg.nimToken]).map((a) => getAddress(a)) as Address[];
  const amounts = await client().readContract({ address: QUICKSWAP_ROUTER, abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountInUnits, path] });
  const out = amounts[amounts.length - 1];
  // Price impact vs the pool's mid price.
  let priceImpact: number | null = null;
  if (cfg.reserves && cfg.nimDecimals !== null) {
    const inDec = direction === "NIM_USDT" ? cfg.nimDecimals : 6, outDec = direction === "NIM_USDT" ? 6 : cfg.nimDecimals;
    const mid = direction === "NIM_USDT" ? cfg.reserves.usdt / cfg.reserves.nim : cfg.reserves.nim / cfg.reserves.usdt;
    const exec = fromUnits(out, outDec) / fromUnits(amountInUnits, inDec);
    priceImpact = mid > 0 ? Math.max(0, 1 - exec / mid) : null;
  }
  return { amountOut: out.toString(), path: path.map((p) => p.toLowerCase()), priceImpact };
}

// ---------------------------------------------------------------------------
// Recording & verifying actions (receipt-based)
// ---------------------------------------------------------------------------

export type DefiKind = "earn_supply" | "earn_withdraw" | "swap";

interface Receipt {
  status: string;
  from?: string;
  to?: string | null;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string }[];
}

type Row = Record<string, unknown> & { id: string; user_id: string; kind: DefiKind; status: "pending" | "confirmed" | "failed" };

export interface DefiActionDTO {
  id: string;
  ref: string;
  kind: DefiKind;
  txHash: string;
  status: "pending" | "confirmed" | "failed";
  failureReason: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: number | null;
  amountOut: number | null;
  createdAt: string;
}

const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase();
const LEDGER: Record<DefiKind, "earn_deposit" | "earn_withdraw" | "swap"> = { earn_supply: "earn_deposit", earn_withdraw: "earn_withdraw", swap: "swap" };

function toDTO(r: Row): DefiActionDTO {
  return {
    id: r.id,
    ref: String(r.ref),
    kind: r.kind,
    txHash: String(r.tx_hash),
    status: r.status,
    failureReason: (r.failure_reason as string) ?? null,
    tokenIn: (r.token_in as string) ?? null,
    tokenOut: (r.token_out as string) ?? null,
    amountIn: r.amount_in === null || r.amount_in === undefined ? null : num(r.amount_in),
    amountOut: r.amount_out === null || r.amount_out === undefined ? null : num(r.amount_out),
    createdAt: iso(r.created_at)!,
  };
}

function transfers(rc: Receipt, token: string) {
  return rc.logs
    .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length >= 3)
    .map((l) => ({ from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), value: BigInt(l.data) }));
}

/** Checks a receipt against what the action must have done on-chain. */
async function check(r: Row): Promise<{ state: "pending" | "confirmed" | "failed"; reason?: string; amountIn?: number; amountOut?: number }> {
  let rc: Receipt | null;
  try {
    rc = await polygonRpc<Receipt>("eth_getTransactionReceipt", [r.tx_hash]);
  } catch (err) {
    return { state: "pending", reason: `Polygon RPC unavailable: ${errorMessage(err)}` };
  }
  if (!rc) return { state: "pending", reason: "Waiting for the transaction to be mined." };
  if (rc.status !== "0x1") return { state: "failed", reason: "The transaction reverted on Polygon." };
  const from = String(r.from_address).toLowerCase();
  if (rc.from && rc.from.toLowerCase() !== from) return { state: "failed", reason: "The transaction came from a different wallet." };
  const target = r.kind === "swap" ? QUICKSWAP_ROUTER : AAVE_POOL;
  if (rc.to && rc.to.toLowerCase() !== target.toLowerCase()) return { state: "failed", reason: "The transaction wasn't sent to the expected contract." };

  if (r.kind === "earn_supply") {
    const t = transfers(rc, USDT).find((x) => x.from === from && x.to === AUSDT.toLowerCase());
    return t ? { state: "confirmed", amountIn: fromUnits(t.value, 6) } : { state: "failed", reason: "No USDT was supplied to Aave in this transaction." };
  }
  if (r.kind === "earn_withdraw") {
    const t = transfers(rc, USDT).find((x) => x.from === AUSDT.toLowerCase() && x.to === from);
    return t ? { state: "confirmed", amountOut: fromUnits(t.value, 6) } : { state: "failed", reason: "No USDT was withdrawn to your wallet in this transaction." };
  }
  // swap
  const tokenIn = String(r.token_in), tokenOut = String(r.token_out);
  // jsonb comes back as an object from Postgres drivers, or as text depending on how it was bound.
  const det = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as { nimDecimals?: number } | null;
  const decIn = tokenIn === USDT.toLowerCase() ? 6 : Number(det?.nimDecimals ?? 18);
  const decOut = tokenOut === USDT.toLowerCase() ? 6 : Number(det?.nimDecimals ?? 18);
  const sent = transfers(rc, tokenIn).find((x) => x.from === from);
  const got = transfers(rc, tokenOut).find((x) => x.to === from);
  return sent && got ? { state: "confirmed", amountIn: fromUnits(sent.value, decIn), amountOut: fromUnits(got.value, decOut) } : { state: "failed", reason: "This transaction didn't swap into your wallet." };
}

function ledgerTitle(kind: DefiKind, d: { tokenIn?: string | null; tokenOut?: string | null }) {
  if (kind === "earn_supply") return "Deposited to Earn";
  if (kind === "earn_withdraw") return "Withdrew from Earn";
  const sym = (a?: string | null) => (a && a.toLowerCase() === USDT.toLowerCase() ? "USDT" : "NIM");
  return `Swapped ${sym(d.tokenIn)} → ${sym(d.tokenOut)}`;
}

async function advance(db: Db, r: Row): Promise<Row> {
  if (r.status !== "pending") return r;
  const res = await check(r);
  if (res.state === "pending") {
    if (Date.now() - new Date(r.created_at as string).getTime() > 30 * 60_000) res.state = "failed";
    else return { ...r, failure_reason: res.reason ?? null } as Row;
  }
  const rows = await db.query<Row>(
    `update defi_actions set status = $2, failure_reason = $3, amount_in = coalesce($4, amount_in), amount_out = coalesce($5, amount_out),
       confirmed_at = case when $2 = 'confirmed' then now() else confirmed_at end, updated_at = now()
     where id = $1 and status = 'pending' returning *`,
    [r.id, res.state, res.state === "failed" ? (res.reason ?? "Not confirmed in time.") : null, res.amountIn ?? null, res.amountOut ?? null],
  );
  const u = rows[0];
  if (!u) return (await db.query<Row>("select * from defi_actions where id = $1", [r.id]))[0];
  const amount = r.kind === "earn_withdraw" ? num(u.amount_out) : num(u.amount_in);
  await db.query("update transactions set amount = $3, amount_usd = $4 where source_table = 'defi_actions' and source_id = $1 and category = $2", [
    u.id, LEDGER[u.kind], amount, u.kind === "swap" ? null : amount,
  ]);
  await updateLedgerBySource(db, "defi_actions", u.id, LEDGER[u.kind], { status: res.state === "confirmed" ? "successful" : "failed", details: res.reason ? { statusReason: res.reason } : undefined });
  log.info("defi.action", { ref: u.ref, kind: u.kind, status: res.state });
  return u;
}

export async function recordAction(
  userId: string,
  input: { kind: DefiKind; txHash: string; from: string; amount?: string; direction?: SwapDirection },
): Promise<DefiActionDTO> {
  const db = await getDb();
  const from = input.from.toLowerCase();
  if (!(await verifiedEvmAddresses(userId)).includes(from)) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet first.", 422);
  const hash = input.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);

  let tokenIn: string | null = null, tokenOut: string | null = null, details: Record<string, unknown> = {};
  if (input.kind === "earn_supply") { tokenIn = USDT.toLowerCase(); tokenOut = AUSDT.toLowerCase(); }
  if (input.kind === "earn_withdraw") { tokenIn = AUSDT.toLowerCase(); tokenOut = USDT.toLowerCase(); }
  if (input.kind === "swap") {
    const cfg = await swapConfig();
    if (!cfg.enabled || !cfg.nimToken) throw new AppError("SWAP_UNAVAILABLE", cfg.reason ?? "Swap is unavailable.", 409);
    tokenIn = input.direction === "NIM_USDT" ? cfg.nimToken : USDT.toLowerCase();
    tokenOut = input.direction === "NIM_USDT" ? USDT.toLowerCase() : cfg.nimToken;
    details = { direction: input.direction, nimDecimals: cfg.nimDecimals };
  }
  const ref = newRef("DF");
  const hint = input.amount ? Number(input.amount) : null;
  let row: Row;
  try {
    row = await db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        `insert into defi_actions (ref, user_id, kind, tx_hash, from_address, token_in, token_out, amount_in, status, details)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) returning *`,
        [ref, userId, input.kind, hash, from, tokenIn, tokenOut, input.kind === "earn_withdraw" ? null : hint, JSON.stringify(details)],
      );
      await insertLedger(tx, {
        ref,
        userId,
        category: LEDGER[input.kind],
        title: ledgerTitle(input.kind, { tokenIn, tokenOut }),
        subtitle: input.kind === "swap" ? "QuickSwap · Polygon" : "Aave · Polygon",
        amount: hint ?? 0,
        currency: input.kind === "swap" && input.direction === "NIM_USDT" ? "NIM" : "USDT",
        amountUsd: input.kind === "swap" ? null : hint,
        status: "pending",
        isSimulated: false,
        environment: "production",
        provider: input.kind === "swap" ? "quickswap" : "aave",
        chainTxHash: hash,
        sourceTable: "defi_actions",
        sourceId: rows[0].id,
        details: { kind: input.kind },
      });
      return rows[0];
    });
  } catch (err) {
    if (/unique|duplicate/i.test(errorMessage(err))) {
      const existing = (await db.query<Row>("select * from defi_actions where chain = 'polygon' and tx_hash = $1", [hash]))[0];
      if (existing && existing.user_id === userId) return toDTO(await advance(db, existing));
      throw new AppError("TX_ALREADY_USED", "This transaction has already been recorded.", 409);
    }
    throw err;
  }
  return toDTO(await advance(db, row));
}

export async function getAction(userId: string, id: string): Promise<DefiActionDTO> {
  const db = await getDb();
  const r = (await db.query<Row>("select * from defi_actions where id = $1 and user_id = $2", [id, userId]))[0];
  if (!r) throw new AppError("NOT_FOUND", "Not found.", 404);
  return toDTO(await advance(db, r));
}

export async function usdValueOfNim(nim: number): Promise<number | null> {
  const { rates } = await getRatesSafe();
  return rates ? nim * rates.nimUsd : null;
}

/** Wallet balances and router allowances for the swap screen (only when swap is enabled). */
export async function swapBalances(address: string): Promise<{ nim: number; usdt: number; pol: number; allowance: { NIM: number; USDT: number } }> {
  const cfg = await swapConfig();
  if (!cfg.enabled || !cfg.nimToken) throw new AppError("SWAP_UNAVAILABLE", cfg.reason ?? "Swap is unavailable.", 409);
  const c = client();
  const owner = getAddress(address);
  const nim = getAddress(cfg.nimToken);
  const dec = cfg.nimDecimals ?? 18;
  const [nimBal, usdtBal, pol, nimAllow, usdtAllow] = await Promise.all([
    c.readContract({ address: nim, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    c.getBalance({ address: owner }),
    c.readContract({ address: nim, abi: ERC20_ABI, functionName: "allowance", args: [owner, QUICKSWAP_ROUTER] }),
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "allowance", args: [owner, QUICKSWAP_ROUTER] }),
  ]);
  return { nim: fromUnits(nimBal, dec), usdt: fromUnits(usdtBal, 6), pol: fromUnits(pol, 18), allowance: { NIM: fromUnits(nimAllow, dec), USDT: fromUnits(usdtAllow, 6) } };
}
