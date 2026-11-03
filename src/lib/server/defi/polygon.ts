import "server-only";
import { createPublicClient, decodeEventLog, decodeFunctionData, http, getAddress, zeroAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import {
  AAVE_POOL, AAVE_POOL_ABI, aaveApy, directionAssets, ERC20_ABI, fromUnits, QUICKSWAP_ROUTER, TOKENS, TRANSFER_TOPIC, V2_FACTORY_ABI, V2_PAIR_ABI, V2_ROUTER_ABI, WPOL, WPOL_EVENTS_ABI,
  type SwapDirection, type SwapPairId,
} from "@/lib/shared/polygon-defi";
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
/** How defi_actions stores native POL in token_in / token_out. */
const NATIVE = "pol";

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
// Swap (QuickSwap V2): USDT ↔ POL always; NIM ↔ USDT once NIM exists on Polygon with a pool
// ---------------------------------------------------------------------------

export interface SwapPairConfig {
  enabled: boolean;
  reason: string | null;
  /** The non-USDT side's token on Polygon (WPOL for POL). */
  token: string | null;
  pair: string | null;
  /** Pool reserves in whole units: `asset` is POL or NIM. */
  reserves: { asset: number; usdt: number } | null;
  decimals: number | null;
}
export interface SwapConfig {
  pairs: Record<SwapPairId, SwapPairConfig>;
}

let swapCache: { at: number; value: SwapConfig } | null = null;

async function pairConfig(id: SwapPairId): Promise<SwapPairConfig> {
  const off = (reason: string, extra: Partial<SwapPairConfig> = {}): SwapPairConfig => ({ enabled: false, reason, token: null, pair: null, reserves: null, decimals: null, ...extra });
  const label = id === "POL" ? "POL/USDT" : "NIM/USDT";
  let tokenAddr: Address;
  if (id === "POL") tokenAddr = getAddress(WPOL);
  else {
    const nim = config.nimPolygonToken;
    if (!nim || !/^0x[0-9a-fA-F]{40}$/.test(nim)) return off("NIM isn't on Polygon yet. Nimiq's bridge to Polygon has been announced; swapping opens as soon as NIM on Polygon has a QuickSwap pool.");
    tokenAddr = getAddress(nim);
  }
  try {
    const c = client();
    const factory = await c.readContract({ address: QUICKSWAP_ROUTER, abi: V2_ROUTER_ABI, functionName: "factory" });
    const pair = await c.readContract({ address: factory, abi: V2_FACTORY_ABI, functionName: "getPair", args: [tokenAddr, USDT] });
    if (pair === zeroAddress) return off(`There's no QuickSwap ${label} pool yet.`, { token: tokenAddr.toLowerCase() });
    const [[r0, r1], token0, decimals] = await Promise.all([
      c.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "getReserves" }),
      c.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "token0" }),
      id === "POL" ? Promise.resolve(18) : c.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    const assetIs0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    const reserves = { asset: fromUnits(assetIs0 ? r0 : r1, decimals), usdt: fromUnits(assetIs0 ? r1 : r0, 6) };
    const base = { token: tokenAddr.toLowerCase(), pair: pair.toLowerCase(), reserves, decimals };
    return reserves.usdt < 1 ? off(`The QuickSwap ${label} pool has no liquidity yet.`, base) : { enabled: true, reason: null, ...base };
  } catch (err) {
    log.warn("swap.config_failed", { pair: id, error: errorMessage(err) });
    return off("Couldn't reach QuickSwap on Polygon right now.");
  }
}

export async function swapConfig(): Promise<SwapConfig> {
  if (swapCache && Date.now() - swapCache.at < 5 * 60_000) return swapCache.value;
  const [POL, NIM] = await Promise.all([pairConfig("POL"), pairConfig("NIM")]);
  const value = { pairs: { POL, NIM } };
  // Don't cache an RPC hiccup for five minutes.
  if (POL.enabled || POL.reason?.startsWith("There") || POL.reason?.startsWith("The")) swapCache = { at: Date.now(), value };
  return value;
}

export async function enabledPair(direction: SwapDirection): Promise<SwapPairConfig & { token: string; decimals: number }> {
  const cfg = (await swapConfig()).pairs[directionAssets(direction).pair];
  if (!cfg.enabled || !cfg.token || cfg.decimals === null) throw new AppError("SWAP_UNAVAILABLE", cfg.reason ?? "Swap is unavailable.", 409);
  return cfg as SwapPairConfig & { token: string; decimals: number };
}

/** Router path for a direction (native POL is routed through WPOL). */
function swapPath(direction: SwapDirection, token: string): Address[] {
  const { from } = directionAssets(direction);
  return (from === "USDT" ? [USDT, token] : [token, USDT]).map((a) => getAddress(a)) as Address[];
}

export async function swapQuote(direction: SwapDirection, amountInUnits: bigint): Promise<{ amountOut: string; path: string[]; priceImpact: number | null; decimalsIn: number; decimalsOut: number }> {
  const cfg = await enabledPair(direction);
  const path = swapPath(direction, cfg.token);
  const amounts = await client().readContract({ address: QUICKSWAP_ROUTER, abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountInUnits, path] });
  const out = amounts[amounts.length - 1];
  const fromUsdt = directionAssets(direction).from === "USDT";
  const decimalsIn = fromUsdt ? 6 : cfg.decimals, decimalsOut = fromUsdt ? cfg.decimals : 6;
  // Price impact vs the pool's mid price.
  let priceImpact: number | null = null;
  if (cfg.reserves) {
    const mid = fromUsdt ? cfg.reserves.asset / cfg.reserves.usdt : cfg.reserves.usdt / cfg.reserves.asset;
    const exec = fromUnits(out, decimalsOut) / fromUnits(amountInUnits, decimalsIn);
    priceImpact = mid > 0 ? Math.max(0, 1 - exec / mid) : null;
  }
  return { amountOut: out.toString(), path: path.map((p) => p.toLowerCase()), priceImpact, decimalsIn, decimalsOut };
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
  const det = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as { nimDecimals?: number; decimalsIn?: number; decimalsOut?: number } | null;
  const decIn = tokenIn === USDT.toLowerCase() ? 6 : tokenIn === NATIVE ? 18 : Number(det?.decimalsIn ?? det?.nimDecimals ?? 18);
  const decOut = tokenOut === USDT.toLowerCase() ? 6 : tokenOut === NATIVE ? 18 : Number(det?.decimalsOut ?? det?.nimDecimals ?? 18);
  const bad = { state: "failed" as const, reason: "This transaction didn't swap into your wallet." };

  if (tokenIn !== NATIVE && tokenOut !== NATIVE) {
    const sent = transfers(rc, tokenIn).find((x) => x.from === from);
    const got = transfers(rc, tokenOut).find((x) => x.to === from);
    return sent && got ? { state: "confirmed", amountIn: fromUnits(sent.value, decIn), amountOut: fromUnits(got.value, decOut) } : bad;
  }
  // Native POL never shows up as a token Transfer: check what the router was told to do (recipient
  // and path from the calldata) and the WPOL wrap/unwrap the router performed.
  let tx: { input?: string; value?: string } | null;
  try {
    tx = await polygonRpc<{ input?: string; value?: string }>("eth_getTransactionByHash", [r.tx_hash]);
  } catch (err) {
    return { state: "pending", reason: `Polygon RPC unavailable: ${errorMessage(err)}` };
  }
  if (!tx?.input) return { state: "pending", reason: "Waiting for the transaction." };
  let call: { functionName: string; args: readonly unknown[] };
  try {
    call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: tx.input as `0x${string}` }) as typeof call;
  } catch {
    return bad;
  }
  const wpolLogs = rc.logs
    .filter((l) => l.address.toLowerCase() === WPOL.toLowerCase())
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: WPOL_EVENTS_ABI, data: l.data as `0x${string}`, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] })];
      } catch {
        return [];
      }
    });
  const router = QUICKSWAP_ROUTER.toLowerCase();
  if (tokenOut === NATIVE) {
    // USDT → POL: swapExactTokensForETH(amountIn, minOut, [USDT, WPOL], to = user, deadline)
    if (call.functionName !== "swapExactTokensForETH") return bad;
    const [, , path, to] = call.args as [bigint, bigint, string[], string];
    if (String(to).toLowerCase() !== from || String(path[path.length - 1]).toLowerCase() !== WPOL.toLowerCase()) return bad;
    const sent = transfers(rc, tokenIn).find((x) => x.from === from);
    const unwrap = wpolLogs.find((e) => e.eventName === "Withdrawal" && String((e.args as { src: string }).src).toLowerCase() === router);
    return sent && unwrap ? { state: "confirmed", amountIn: fromUnits(sent.value, decIn), amountOut: fromUnits((unwrap.args as { wad: bigint }).wad, 18) } : bad;
  }
  // POL → USDT: swapExactETHForTokens(minOut, [WPOL, USDT], to = user, deadline) with value = POL in
  if (call.functionName !== "swapExactETHForTokens") return bad;
  const [, path, to] = call.args as [bigint, string[], string];
  if (String(to).toLowerCase() !== from || String(path[0]).toLowerCase() !== WPOL.toLowerCase()) return bad;
  const value = BigInt(tx.value ?? "0x0");
  const wrap = wpolLogs.find((e) => e.eventName === "Deposit" && String((e.args as { dst: string }).dst).toLowerCase() === router && (e.args as { wad: bigint }).wad === value);
  const got = transfers(rc, tokenOut).find((x) => x.to === from);
  return value > 0n && wrap && got ? { state: "confirmed", amountIn: fromUnits(value, 18), amountOut: fromUnits(got.value, decOut) } : bad;
}

function ledgerTitle(kind: DefiKind, d: { tokenIn?: string | null; tokenOut?: string | null }) {
  if (kind === "earn_supply") return "Deposited to Earn";
  if (kind === "earn_withdraw") return "Withdrew from Earn";
  const sym = (a?: string | null) => (a && a.toLowerCase() === USDT.toLowerCase() ? "USDT" : a === NATIVE ? "POL" : "NIM");
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
    if (!input.direction) throw new AppError("VALIDATION_ERROR", "Swap direction is required.", 422);
    const cfg = await enabledPair(input.direction);
    const { from: a, to: b } = directionAssets(input.direction);
    const addr = (x: string) => (x === "USDT" ? USDT.toLowerCase() : x === "POL" ? NATIVE : cfg.token);
    tokenIn = addr(a);
    tokenOut = addr(b);
    details = { direction: input.direction, decimalsIn: a === "USDT" ? 6 : cfg.decimals, decimalsOut: b === "USDT" ? 6 : cfg.decimals };
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
        currency: input.kind === "swap" && input.direction ? directionAssets(input.direction).from : "USDT",
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

/** Wallet balances and router allowances for the swap screen (NIM only once it exists on Polygon). */
export async function swapBalances(address: string): Promise<{ nim: number | null; usdt: number; pol: number; allowance: { NIM: number; USDT: number } }> {
  const cfg = await swapConfig();
  const c = client();
  const owner = getAddress(address);
  const nimCfg = cfg.pairs.NIM;
  const nim = nimCfg.enabled && nimCfg.token ? getAddress(nimCfg.token) : null;
  const dec = nimCfg.decimals ?? 18;
  const [nimBal, usdtBal, pol, nimAllow, usdtAllow] = await Promise.all([
    nim ? c.readContract({ address: nim, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }) : Promise.resolve(null),
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    c.getBalance({ address: owner }),
    nim ? c.readContract({ address: nim, abi: ERC20_ABI, functionName: "allowance", args: [owner, QUICKSWAP_ROUTER] }) : Promise.resolve(0n),
    c.readContract({ address: USDT, abi: ERC20_ABI, functionName: "allowance", args: [owner, QUICKSWAP_ROUTER] }),
  ]);
  return { nim: nimBal === null ? null : fromUnits(nimBal, dec), usdt: fromUnits(usdtBal, 6), pol: fromUnits(pol, 18), allowance: { NIM: fromUnits(nimAllow, dec), USDT: fromUnits(usdtAllow, 6) } };
}
