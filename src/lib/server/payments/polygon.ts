import "server-only";
import { config } from "../config";
import { log } from "../log";
import type { VerifyResult } from "./nimiq";

/**
 * Server-side verification of USDT (Polygon PoS) payments via a Polygon RPC
 * node: the transaction receipt must succeed and contain an ERC-20 Transfer
 * log from the USDT contract, from the payer, to the merchant, for exactly the
 * quoted amount (which carries a per-order tag), with enough confirmations.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Receipt {
  status: string;
  blockNumber: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(config.polygon.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Polygon RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Polygon RPC: ${body.error.message}`);
  return body.result ?? null;
}

const topicAddr = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function verifyPolygonUsdtTransfer(opts: {
  txHash: string;
  expectedTo: string;
  expectedFrom: string;
  /** Exact amount in 6-decimal units; null = only require >= minUnits. */
  exactUnits?: bigint;
  minUnits?: bigint;
  notBefore: Date;
}): Promise<VerifyResult> {
  const hash = opts.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { state: "rejected", reason: "Invalid Polygon transaction hash." };

  let receipt: Receipt | null;
  let head: string | null;
  try {
    [receipt, head] = await Promise.all([
      rpc<Receipt>("eth_getTransactionReceipt", [hash]),
      rpc<string>("eth_blockNumber", []),
    ]);
  } catch (err) {
    log.warn("polygon.rpc_error", { error: (err as Error).message });
    return { state: "pending", reason: "Could not reach Polygon to verify yet." };
  }
  if (!receipt) return { state: "pending", reason: "Transaction not mined yet." };
  if (receipt.status !== "0x1") return { state: "rejected", reason: "Transaction reverted on-chain." };

  const usdt = config.polygon.usdtContract;
  const to = opts.expectedTo.toLowerCase();
  const from = opts.expectedFrom.toLowerCase();
  const transfer = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === usdt &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics.length >= 3 &&
      topicAddr(l.topics[1]) === from &&
      topicAddr(l.topics[2]) === to,
  );
  if (!transfer) return { state: "rejected", reason: "No matching USDT transfer to AuraPay found in this transaction." };

  const units = BigInt(transfer.data);
  if (opts.exactUnits !== undefined && units !== opts.exactUnits) {
    return { state: "rejected", reason: "USDT amount does not match this order's quote." };
  }
  if (opts.minUnits !== undefined && units < opts.minUnits) {
    return { state: "rejected", reason: "USDT amount is lower than required." };
  }

  const blockNumber = Number(BigInt(receipt.blockNumber));
  const confirmations = head ? Number(BigInt(head)) - blockNumber + 1 : 0;

  let timestamp = 0;
  try {
    const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [receipt.blockNumber, false]);
    timestamp = block ? Number(BigInt(block.timestamp)) * 1000 : 0;
  } catch {
    return { state: "pending", reason: "Could not load block details yet." };
  }
  if (timestamp && timestamp < opts.notBefore.getTime()) {
    return { state: "rejected", reason: "Transaction predates this order." };
  }
  if (confirmations < config.polygon.minConfirmations) {
    return { state: "pending", reason: `Waiting for confirmations (${confirmations}/${config.polygon.minConfirmations}).` };
  }
  return {
    state: "confirmed",
    from,
    to,
    atomicValue: units.toString(),
    confirmations,
    blockNumber,
    timestamp,
    raw: { receiptBlock: receipt.blockNumber, logIndexData: transfer.data },
  };
}

/** Reads a USDT (Polygon) balance server-side so the wallet need not switch chains just to display it. */
export async function usdtBalanceOf(address: string): Promise<number> {
  const data = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const result = await rpc<string>("eth_call", [{ to: config.polygon.usdtContract, data }, "latest"]);
  return result ? Number(BigInt(result)) / 1e6 : 0;
}
