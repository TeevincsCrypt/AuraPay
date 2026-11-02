"use client";

import { encodeFunctionData } from "viem";
import { ERC20_ABI, POLYGON } from "@/lib/shared/polygon-defi";
import { WalletActionError } from "./wallet";

type Send = (p: { chainIdHex: string; to: string; data: string }) => Promise<{ hash: string; from: string }>;

/** Waits for a transaction to be mined (via the injected Nimiq Pay provider). Throws if it reverted. */
export async function waitForReceipt(hash: string, timeoutMs = 180_000): Promise<void> {
  const eth = window.ethereum;
  if (!eth) throw new WalletActionError("unsupported", "No EVM wallet available.");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
      if (r && r.status) {
        if (r.status !== "0x1") throw new WalletActionError("failed", "The transaction reverted on Polygon.");
        return;
      }
    } catch (err) {
      if (err instanceof WalletActionError) throw err;
      // transient provider error: keep polling
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new WalletActionError("unknown_outcome", "Still waiting for Polygon to confirm. Check Activity in a minute.");
}

/**
 * Makes sure `spender` may move `units` of `token`. Approves the exact amount only (never
 * unlimited). USDT-style tokens reject changing a non-zero allowance, so reset to 0 first.
 */
export async function ensureAllowance(
  send: Send,
  opts: { token: string; spender: string; units: bigint; current: bigint },
  onStep?: (s: "approve-reset" | "approve" | "approve-confirm") => void,
): Promise<void> {
  if (opts.current >= opts.units) return;
  if (opts.current > 0n) {
    onStep?.("approve-reset");
    const r0 = await send({ chainIdHex: POLYGON.chainIdHex, to: opts.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [opts.spender as `0x${string}`, 0n] }) });
    await waitForReceipt(r0.hash);
  }
  onStep?.("approve");
  const r = await send({ chainIdHex: POLYGON.chainIdHex, to: opts.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [opts.spender as `0x${string}`, opts.units] }) });
  onStep?.("approve-confirm");
  await waitForReceipt(r.hash);
}
