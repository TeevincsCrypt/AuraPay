"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeFunctionData, erc20Abi } from "viem";
import type { NimiqProvider } from "@nimiq/mini-app-sdk";
import { api } from "./api";

/**
 * Wallet layer.
 *
 *  - NIM: the Nimiq provider injected by Nimiq Pay, accessed through the official
 *    `@nimiq/mini-app-sdk` `init()` helper. Nimiq Pay chooses the signing account
 *    and shows its own approval dialog; keys never leave the wallet.
 *  - USDT: the EIP-1193 provider (`window.ethereum`) Nimiq Pay injects, used for
 *    an ERC-20 transfer of USDT on Polygon (per the Nimiq "EVM tokens" guide).
 *
 * A successful response here only means "submitted". Orders are marked paid
 * only after the server verifies the transaction on-chain.
 */

interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...a: unknown[]) => void): void;
  removeListener?(event: string, cb: (...a: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const;
const POLYGON_CHAIN_ID = "0x89";

export type HostKind = "detecting" | "nimiq-pay" | "browser";

export interface WalletState {
  host: HostKind;
  hostNetwork: "mainnet" | "testnet" | null;
  nimiq: {
    status: "idle" | "connecting" | "connected" | "error";
    addresses: string[];
    balanceLuna: number | null;
    balanceError: string | null;
    error: string | null;
  };
  evm: {
    available: boolean;
    status: "idle" | "connecting" | "connected" | "error";
    address: string | null;
    usdtBalance: number | null;
    /** POL for Polygon gas; null when unknown. */
    polBalance: number | null;
    error: string | null;
  };
}

/** Below this a USDT transfer (~65k gas, normally ~0.002 POL) can't reliably pay its network fee. */
export const MIN_POL_FOR_GAS = 0.003;
export const NO_GAS_MESSAGE =
  "Your Polygon wallet has no POL for the network fee. Nimiq Pay's own USDT sends are gas-free, but USDT payments from apps need a little POL (0.1 POL covers dozens of payments). Send some POL to this wallet, or pay with NIM.";

export class WalletActionError extends Error {
  constructor(
    public readonly kind: "rejected" | "unsupported" | "insufficient" | "network" | "unknown_outcome" | "failed",
    message: string,
  ) {
    super(message);
  }
}

interface WalletApi extends WalletState {
  connectNimiq(): Promise<void>;
  connectEvm(): Promise<string>;
  /** Signs a text message with Nimiq Pay (used for sign-in). */
  signNimiq(message: string): Promise<{ publicKey: string; signature: string }>;
  /** Connects the EVM wallet and proves control of it to the server with personal_sign. */
  linkEvm(): Promise<string>;
  ensureChain(chainIdHex: string): Promise<void>;
  /** `value` is native POL in wei (hex), for payable calls. */
  sendEvmTx(p: { chainIdHex: string; to: string; data: string; value?: string }): Promise<{ hash: string; from: string }>;
  refreshBalances(): Promise<void>;
  disconnect(): void;
  payNim(p: { recipient: string; luna: string; memo: string }): Promise<string>;
  payUsdt(p: { to: string; units: string }): Promise<{ hash: string; from: string }>;
}

const WalletContext = createContext<WalletApi | null>(null);

const LS_KEY = "aurapay.wallet.connected";

function nimiqErrorToAction(err: unknown): WalletActionError {
  const e = err as { type?: string; message?: string; code?: number };
  switch (e?.type) {
    case "PERMISSION_DENIED":
      return new WalletActionError("rejected", "You cancelled the request in Nimiq Pay.");
    case "UNKNOWN_REQUEST":
      return new WalletActionError("unsupported", "Your Nimiq Pay version doesn't support this. Please update Nimiq Pay.");
    case "INVALID_TRANSACTION":
    case "INVALID_REQUEST":
      return new WalletActionError("failed", e.message || "The wallet rejected the transaction details.");
    case "NETWORK_ERROR":
      return new WalletActionError(
        "unknown_outcome",
        "Nimiq Pay reported a network error. The payment may or may not have been sent — check your wallet history before trying again.",
      );
    default:
      if (/insufficient|balance/i.test(e?.message ?? "")) return new WalletActionError("insufficient", "Insufficient NIM balance for this payment.");
      return new WalletActionError("failed", e?.message || "The wallet couldn't complete the request.");
  }
}

function evmErrorToAction(err: unknown): WalletActionError {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return new WalletActionError("rejected", "You cancelled the request in your wallet.");
  if (e?.code === 4200 || e?.code === 4902) return new WalletActionError("unsupported", "Polygon isn't available in this wallet.");
  const msg = e?.message ?? "";
  // "insufficient funds for gas * price + value" is the node's wording for a native (POL) shortfall.
  if (/insufficient funds|not enough (pol|matic|native)|gas required exceeds/i.test(msg)) return new WalletActionError("insufficient", NO_GAS_MESSAGE);
  if (/exceeds balance|insufficient balance/i.test(msg)) return new WalletActionError("insufficient", "Not enough USDT in your Polygon wallet for this payment.");
  return new WalletActionError("failed", e?.message || "The wallet couldn't complete the request.");
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const providerRef = useRef<NimiqProvider | null>(null);
  const [state, setState] = useState<WalletState>({
    host: "detecting",
    hostNetwork: null,
    nimiq: { status: "idle", addresses: [], balanceLuna: null, balanceError: null, error: null },
    evm: { available: false, status: "idle", address: null, usdtBalance: null, polBalance: null, error: null },
  });

  const loadNimBalance = useCallback(async (address: string) => {
    const nimiq = providerRef.current;
    if (!nimiq) return;
    const set = (luna: number | null, err: string | null) => setState((s) => ({ ...s, nimiq: { ...s.nimiq, balanceLuna: luna, balanceError: err } }));
    // 1) Ask Nimiq Pay. The host may resolve with an error object instead of throwing, or time out
    //    while it syncs, so it gets a few seconds at most.
    if (typeof nimiq.getBalance === "function") {
      try {
        const luna: unknown = await Promise.race([nimiq.getBalance(address), new Promise((r) => setTimeout(() => r(null), 6_000))]);
        if (typeof luna === "number" && Number.isFinite(luna)) return set(luna, null);
      } catch {}
    }
    // 2) Fall back to AuraPay's own Nimiq node, but only if it's on the same network as the wallet.
    try {
      const r = await api<{ luna: number; network: string }>(`/api/wallet/nim-balance?address=${encodeURIComponent(address)}`);
      const hostNet = window.nimiqPay?.network ?? null;
      if (!hostNet || hostNet === r.network) return set(r.luna, null);
      set(null, `Nimiq Pay is on ${hostNet}; AuraPay is on ${r.network}.`);
    } catch {
      set(null, "Balance unavailable right now.");
    }
  }, []);

  const loadUsdtBalance = useCallback(async (address: string) => {
    try {
      const r = await api<{ balance: number; pol?: number | null }>(`/api/wallet/usdt-balance?address=${address}`);
      setState((s) => ({ ...s, evm: { ...s.evm, usdtBalance: r.balance, polBalance: r.pol ?? null } }));
    } catch {
      setState((s) => ({ ...s, evm: { ...s.evm, usdtBalance: null, polBalance: null } }));
    }
  }, []);

  const connectNimiq = useCallback(async () => {
    const nimiq = providerRef.current;
    if (!nimiq) throw new WalletActionError("unsupported", "Open AuraPay inside Nimiq Pay to connect your wallet.");
    setState((s) => ({ ...s, nimiq: { ...s.nimiq, status: "connecting", error: null } }));
    try {
      const res: unknown = await nimiq.listAccounts();
      if (!Array.isArray(res)) throw new WalletActionError("failed", (res as { error?: { message?: string } })?.error?.message ?? "No account was shared.");
      const addresses = res as string[];
      if (!addresses.length) throw new WalletActionError("failed", "No account was shared.");
      setState((s) => ({ ...s, nimiq: { ...s.nimiq, status: "connected", addresses, error: null } }));
      try {
        localStorage.setItem(LS_KEY, "1");
      } catch {}
      await loadNimBalance(addresses[0]);
    } catch (err) {
      const a = err instanceof WalletActionError ? err : nimiqErrorToAction(err);
      setState((s) => ({ ...s, nimiq: { ...s.nimiq, status: a.kind === "rejected" ? "idle" : "error", error: a.kind === "rejected" ? null : a.message } }));
      throw a;
    }
  }, [loadNimBalance]);

  const connectEvm = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) throw new WalletActionError("unsupported", "No EVM wallet is available here. Open AuraPay in Nimiq Pay to pay with USDT.");
    setState((s) => ({ ...s, evm: { ...s.evm, status: "connecting", error: null } }));
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0]?.toLowerCase();
      if (!address) throw new WalletActionError("failed", "No account was shared.");
      setState((s) => ({ ...s, evm: { ...s.evm, status: "connected", address } }));
      void loadUsdtBalance(address);
      return address;
    } catch (err) {
      const a = err instanceof WalletActionError ? err : evmErrorToAction(err);
      setState((s) => ({ ...s, evm: { ...s.evm, status: a.kind === "rejected" ? "idle" : "error", error: a.kind === "rejected" ? null : a.message } }));
      throw a;
    }
  }, [loadUsdtBalance]);

  // Host detection. Nimiq Pay injects window.nimiq / window.nimiqPay before page scripts run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const injected = typeof window !== "undefined" && (window.nimiq || window.nimiqPay);
      // Nimiq Pay injects its provider before page scripts run, so absence means a plain
      // browser. Report that immediately, but still accept a late injection below.
      if (!injected) setState((s) => ({ ...s, host: "browser", evm: { ...s.evm, available: Boolean(window.ethereum) } }));
      try {
        const { init } = await import("@nimiq/mini-app-sdk");
        const nimiq = await init({ timeout: injected ? 10_000 : 1_500 });
        if (cancelled) return;
        providerRef.current = nimiq;
        setState((s) => ({
          ...s,
          host: "nimiq-pay",
          hostNetwork: window.nimiqPay?.network ?? null,
          evm: { ...s.evm, available: Boolean(window.ethereum) },
        }));
        let remembered = false;
        try {
          remembered = localStorage.getItem(LS_KEY) === "1";
        } catch {}
        if (remembered) void connectNimiq().catch(() => {});
        // An EVM account the user already shared with AuraPay (no prompt): load USDT + POL up front so
        // Pay can warn about a missing gas balance before a payment is started.
        try {
          const accts = window.ethereum ? ((await window.ethereum.request({ method: "eth_accounts" })) as string[]) : [];
          const addr = accts?.[0]?.toLowerCase();
          if (addr && !cancelled) {
            setState((s) => (s.evm.address ? s : { ...s, evm: { ...s.evm, status: "connected", address: addr } }));
            void loadUsdtBalance(addr);
          }
        } catch {}
      } catch {
        if (cancelled) return;
        setState((s) => ({ ...s, host: "browser", evm: { ...s.evm, available: Boolean(window.ethereum) } }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectNimiq, loadUsdtBalance]);

  const refreshBalances = useCallback(async () => {
    const tasks: Promise<void>[] = [];
    if (state.nimiq.addresses[0]) tasks.push(loadNimBalance(state.nimiq.addresses[0]));
    if (state.evm.address) tasks.push(loadUsdtBalance(state.evm.address));
    await Promise.all(tasks);
  }, [state.nimiq.addresses, state.evm.address, loadNimBalance, loadUsdtBalance]);

  const disconnect = useCallback(() => {
    providerRef.current?.disconnect();
    try {
      localStorage.removeItem(LS_KEY);
    } catch {}
    setState((s) => ({
      ...s,
      nimiq: { status: "idle", addresses: [], balanceLuna: null, balanceError: null, error: null },
      evm: { ...s.evm, status: "idle", address: null, usdtBalance: null, polBalance: null, error: null },
    }));
  }, []);

  const payNim = useCallback(async ({ recipient, luna, memo }: { recipient: string; luna: string; memo: string }) => {
    const nimiq = providerRef.current;
    if (!nimiq) throw new WalletActionError("unsupported", "Open AuraPay inside Nimiq Pay to pay with NIM.");
    if (new TextEncoder().encode(memo).length > 64) throw new WalletActionError("failed", "Payment reference too long.");
    const value = Number(luna);
    if (!Number.isSafeInteger(value) || value <= 0) throw new WalletActionError("failed", "Invalid payment amount.");
    try {
      return await nimiq.sendBasicTransactionWithData({ recipient, value, data: memo });
    } catch (err) {
      throw nimiqErrorToAction(err);
    }
  }, []);

  const payUsdt = useCallback(async ({ to, units }: { to: string; units: string }) => {
    const eth = window.ethereum;
    if (!eth) throw new WalletActionError("unsupported", "Open AuraPay inside Nimiq Pay to pay with USDT.");
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) throw new WalletActionError("failed", "No account was shared.");
      const chainId = (await eth.request({ method: "eth_chainId" })) as string;
      if (chainId?.toLowerCase() !== POLYGON_CHAIN_ID) {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: POLYGON_CHAIN_ID }] });
      }
      // Check gas and balance first, so the wallet never shows a transaction that can't go through.
      const bal = await api<{ balance: number; pol?: number | null }>(`/api/wallet/usdt-balance?address=${from}`).catch(() => null);
      if (bal) {
        setState((s) => ({ ...s, evm: { ...s.evm, usdtBalance: bal.balance, polBalance: bal.pol ?? null } }));
        if (bal.balance * 1e6 < Number(units)) throw new WalletActionError("insufficient", "Not enough USDT in your Polygon wallet for this payment.");
        if (bal.pol !== null && bal.pol !== undefined && bal.pol < MIN_POL_FOR_GAS) throw new WalletActionError("insufficient", NO_GAS_MESSAGE);
      }
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, BigInt(units)] });
      const hash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from, to: POLYGON_USDT, data, value: "0x0" }],
      })) as string;
      return { hash, from: from.toLowerCase() };
    } catch (err) {
      throw err instanceof WalletActionError ? err : evmErrorToAction(err);
    }
  }, []);

  const signNimiq = useCallback(async (message: string) => {
    const nimiq = providerRef.current;
    if (!nimiq) throw new WalletActionError("unsupported", "Open AuraPay inside Nimiq Pay to sign in.");
    try {
      const r = await nimiq.sign(message);
      return { publicKey: r.publicKey, signature: r.signature };
    } catch (err) {
      throw nimiqErrorToAction(err);
    }
  }, []);

  const linkEvm = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) throw new WalletActionError("unsupported", "Open AuraPay inside Nimiq Pay to connect your EVM wallet.");
    const address = await connectEvm();
    try {
      const ch = await api<{ id: string; message: string }>("/api/auth/evm/challenge", { method: "POST", json: { address } });
      const signature = (await eth.request({ method: "personal_sign", params: [ch.message, address] })) as string;
      await api("/api/auth/evm/verify", { method: "POST", json: { challengeId: ch.id, signature } });
      return address;
    } catch (err) {
      throw err instanceof WalletActionError ? err : (err as { code?: number }).code ? evmErrorToAction(err) : err;
    }
  }, [connectEvm]);

  const ensureChain = useCallback(async (chainIdHex: string) => {
    const eth = window.ethereum;
    if (!eth) throw new WalletActionError("unsupported", "No EVM wallet available.");
    try {
      const current = (await eth.request({ method: "eth_chainId" })) as string;
      if (current?.toLowerCase() !== chainIdHex.toLowerCase()) {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
      }
    } catch (err) {
      throw evmErrorToAction(err);
    }
  }, []);

  const sendEvmTx = useCallback(
    async ({ chainIdHex, to, data, value }: { chainIdHex: string; to: string; data: string; value?: string }) => {
      const eth = window.ethereum;
      if (!eth) throw new WalletActionError("unsupported", "No EVM wallet available.");
      await ensureChain(chainIdHex);
      try {
        const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        const from = accounts?.[0];
        if (!from) throw new WalletActionError("failed", "No account was shared.");
        const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to, data, value: value ?? "0x0" }] })) as string;
        return { hash, from: from.toLowerCase() };
      } catch (err) {
        throw err instanceof WalletActionError ? err : evmErrorToAction(err);
      }
    },
    [ensureChain],
  );

  const value = useMemo<WalletApi>(
    () => ({ ...state, connectNimiq, connectEvm, refreshBalances, disconnect, payNim, payUsdt, signNimiq, linkEvm, ensureChain, sendEvmTx }),
    [state, connectNimiq, connectEvm, refreshBalances, disconnect, payNim, payUsdt, signNimiq, linkEvm, ensureChain, sendEvmTx],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
