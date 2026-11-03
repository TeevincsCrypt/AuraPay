import "server-only";
import { config } from "../config";
import { log } from "../log";

/**
 * Server-side verification of NIM payments against a Nimiq Albatross node
 * (JSON-RPC `getTransactionByHash`). A tx hash returned by Nimiq Pay only proves
 * submission; we require recipient, amount, memo, execution and confirmations
 * to match before an order counts as paid.
 */

export type VerifyResult =
  | { state: "confirmed"; from: string; to: string; atomicValue: string; confirmations: number; blockNumber: number; timestamp: number; raw: unknown }
  | { state: "pending"; reason: string }
  | { state: "rejected"; reason: string };

interface NimiqTx {
  hash: string;
  blockNumber?: number;
  timestamp?: number;
  confirmations?: number;
  from: string;
  to: string;
  value: number;
  fee?: number;
  recipientData?: string;
  data?: string;
  executionResult?: boolean;
  networkId?: number;
}

export const normaliseNimAddress = (a: string) => a.replace(/\s+/g, "").toUpperCase();

/** Nimiq user-friendly address format: NQ + 2 check digits + 32 base32 chars. */
export function isValidNimAddressFormat(a: string): boolean {
  return /^NQ[0-9]{2}[0-9A-HJ-NP-VXY]{32}$/.test(normaliseNimAddress(a));
}

export function decodeRecipientData(hexOrText: string | undefined): string {
  if (!hexOrText) return "";
  if (/^(0x)?[0-9a-fA-F]*$/.test(hexOrText) && hexOrText.length % 2 === 0) {
    return Buffer.from(hexOrText.replace(/^0x/, ""), "hex").toString("utf8");
  }
  return hexOrText;
}

async function rpc<T>(method: string, params: unknown[]): Promise<{ result?: T; error?: { code: number; message: string } }> {
  const url = config.nimiq.rpcUrl;
  if (!url) throw new Error("NIMIQ_RPC_URL is not configured.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.nimiq.rpcAuth) headers.Authorization = `Basic ${Buffer.from(config.nimiq.rpcAuth).toString("base64")}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Nimiq RPC HTTP ${res.status}`);
  return (await res.json()) as { result?: T; error?: { code: number; message: string } };
}

export async function verifyNimiqTransfer(opts: {
  txHash: string;
  expectedTo: string;
  minLuna: bigint;
  expectedMemo?: string;
  expectedFrom?: string;
  notBefore: Date;
}): Promise<VerifyResult> {
  const hash = opts.txHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { state: "rejected", reason: "Invalid Nimiq transaction hash." };

  let resp;
  try {
    resp = await rpc<{ data?: NimiqTx } | NimiqTx>("getTransactionByHash", [hash]);
  } catch (err) {
    log.warn("nimiq.rpc_error", { error: (err as Error).message });
    return { state: "pending", reason: "Could not reach the Nimiq network to verify yet." };
  }
  if (resp.error || !resp.result) {
    // Not yet included in a block (or unknown). The caller decides when to give up.
    return { state: "pending", reason: "Transaction not found on-chain yet." };
  }
  const tx = ("data" in resp.result && resp.result.data ? resp.result.data : resp.result) as NimiqTx;

  if (normaliseNimAddress(tx.to) !== normaliseNimAddress(opts.expectedTo)) {
    return { state: "rejected", reason: "Payment was sent to a different address." };
  }
  if (opts.expectedFrom && normaliseNimAddress(tx.from) !== normaliseNimAddress(opts.expectedFrom)) {
    return { state: "rejected", reason: "Payment came from an unexpected address." };
  }
  if (BigInt(Math.round(tx.value)) < opts.minLuna) {
    return { state: "rejected", reason: "Payment amount is lower than the quoted amount." };
  }
  if (opts.expectedMemo) {
    const memo = decodeRecipientData(tx.recipientData ?? tx.data);
    if (memo !== opts.expectedMemo) return { state: "rejected", reason: "Payment reference does not match this order." };
  }
  if (tx.executionResult === false) return { state: "rejected", reason: "Transaction failed on-chain." };
  if (tx.timestamp && tx.timestamp < opts.notBefore.getTime()) {
    return { state: "rejected", reason: "Transaction predates this order." };
  }
  const confirmations = tx.confirmations ?? 0;
  if (!tx.blockNumber || confirmations < config.nimiq.minConfirmations) {
    return { state: "pending", reason: `Waiting for confirmations (${confirmations}/${config.nimiq.minConfirmations}).` };
  }
  return {
    state: "confirmed",
    from: normaliseNimAddress(tx.from),
    to: normaliseNimAddress(tx.to),
    atomicValue: String(Math.round(tx.value)),
    confirmations,
    blockNumber: tx.blockNumber,
    timestamp: tx.timestamp ?? 0,
    raw: tx,
  };
}

/** Balance of a Nimiq address in Luna, read from our own node (independent of the wallet host). */
export async function nimBalanceOf(address: string): Promise<number> {
  const r = await rpc<{ data?: { balance?: number } } & { balance?: number }>("getAccountByAddress", [address]);
  if (r.error) throw new Error(r.error.message);
  const luna = r.result?.data?.balance ?? r.result?.balance;
  if (typeof luna !== "number" || !Number.isFinite(luna)) throw new Error("No balance in RPC response");
  return luna;
}

export async function nimiqRpcReachable(): Promise<boolean> {
  try {
    const r = await rpc<number>("getBlockNumber", []);
    return typeof r.result === "number" || typeof (r.result as unknown as { data?: number })?.data === "number";
  } catch {
    return false;
  }
}
