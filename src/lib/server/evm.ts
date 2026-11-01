import "server-only";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Abi } from "viem";
import { config, testOverride } from "./config";
import { log } from "./log";

/**
 * Minimal multi-chain EVM JSON-RPC client (server-side). Reads are batched in a
 * single JSON-RPC array request per chain. Used for tokenised-stock balances,
 * Aave V4 state and transaction receipt verification.
 */

function rpcUrl(chainId: number): string {
  const mock = testOverride("EVM_RPC_URL_OVERRIDE");
  if (mock) return `${mock.replace(/\/$/, "")}/${chainId}`;
  const url = config.rpc[chainId];
  if (!url) throw new Error(`No RPC configured for chain ${chainId}`);
  return url;
}

interface RpcReq {
  method: string;
  params: unknown[];
}

export async function rpcBatch<T = unknown>(chainId: number, reqs: RpcReq[]): Promise<(T | null)[]> {
  if (reqs.length === 0) return [];
  const body = reqs.map((r, i) => ({ jsonrpc: "2.0", id: i, method: r.method, params: r.params }));
  const res = await fetch(rpcUrl(chainId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${chainId} HTTP ${res.status}`);
  const out = (await res.json()) as { id: number; result?: T; error?: { message: string } }[] | { error?: { message: string } };
  if (!Array.isArray(out)) throw new Error(`RPC ${chainId}: ${out.error?.message ?? "invalid batch response"}`);
  const byId = new Map(out.map((o) => [o.id, o]));
  return reqs.map((_, i) => {
    const o = byId.get(i);
    if (!o || o.error) return null;
    return (o.result ?? null) as T | null;
  });
}

export async function rpc<T = unknown>(chainId: number, method: string, params: unknown[]): Promise<T | null> {
  return (await rpcBatch<T>(chainId, [{ method, params }]))[0];
}

export interface Call {
  to: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Executes read-only calls; each result is decoded, or null if that call reverted. */
export async function readContracts(chainId: number, calls: Call[]): Promise<(unknown | null)[]> {
  const raw = await rpcBatch<string>(
    chainId,
    calls.map((c) => ({
      method: "eth_call",
      params: [{ to: c.to, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args as never }) }, "latest"],
    })),
  );
  return raw.map((data, i) => {
    if (!data || data === "0x") return null;
    try {
      return decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].functionName, data: data as `0x${string}` });
    } catch (err) {
      log.warn("evm.decode_failed", { chainId, fn: calls[i].functionName, error: (err as Error).message });
      return null;
    }
  });
}

export async function erc20Balances(chainId: number, pairs: { token: string; owner: string }[]): Promise<(bigint | null)[]> {
  const res = await readContracts(
    chainId,
    pairs.map((p) => ({ to: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.owner] })),
  );
  return res.map((r) => (typeof r === "bigint" ? r : null));
}

export interface TxCheck {
  state: "confirmed" | "pending" | "failed";
  from?: string;
  to?: string | null;
  blockNumber?: number;
  reason?: string;
}

/** Checks a transaction's receipt: success, sender and target. */
export async function checkTransaction(chainId: number, hash: string, expect: { from: string; to?: string }): Promise<TxCheck> {
  const [receipt, tx] = await rpcBatch<{ status: string; from: string; to: string | null; blockNumber: string }>(chainId, [
    { method: "eth_getTransactionReceipt", params: [hash] },
    { method: "eth_getTransactionByHash", params: [hash] },
  ]);
  if (!receipt || !tx) return { state: "pending", reason: "Not mined yet." };
  if (receipt.from.toLowerCase() !== expect.from.toLowerCase()) return { state: "failed", reason: "Sent from a different wallet." };
  if (expect.to && receipt.to?.toLowerCase() !== expect.to.toLowerCase()) return { state: "failed", reason: "Sent to an unexpected contract." };
  if (receipt.status !== "0x1") return { state: "failed", reason: "Transaction reverted." };
  return { state: "confirmed", from: receipt.from, to: receipt.to, blockNumber: Number(BigInt(receipt.blockNumber)) };
}
