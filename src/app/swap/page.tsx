"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownUp, CheckCircle2, ExternalLink, PiggyBank, Receipt, Wallet } from "lucide-react";
import { encodeFunctionData } from "viem";
import { Button, Card, Field, Input, KV, Notice, PageHeader, Segmented, Skeleton, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { ensureAllowance, waitForReceipt } from "@/lib/client/polygon-tx";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtNum } from "@/lib/shared/format";
import { directionAssets, POLYGON, QUICKSWAP_ROUTER, toUnits, TOKENS, V2_ROUTER_ABI, type SwapDirection, type SwapPairId } from "@/lib/shared/polygon-defi";

interface PairCfg { enabled: boolean; reason: string | null; token: string | null; decimals: number | null; reserves: { asset: number; usdt: number } | null }
interface SwapCfg { pairs: Record<SwapPairId, PairCfg> }
interface Balances { nim: number | null; usdt: number; pol: number; allowance: { NIM: number; USDT: number } }
interface Quote { amountOut: string; path: string[]; priceImpact: number | null; decimalsIn: number; decimalsOut: number }
interface Action { id: string; status: "pending" | "confirmed" | "failed"; failureReason: string | null; amountIn: number | null; amountOut: number | null; txHash: string }
type Phase = "idle" | "switch" | "approve-reset" | "approve" | "approve-confirm" | "send" | "confirm" | "done" | "error";

/** POL kept back when swapping POL away, so the wallet can still pay gas afterwards. */
const POL_GAS_RESERVE = 0.05;
const MIN_POL_FOR_GAS = 0.003;
const SLIPPAGE_BPS = 50n; // 0.5%
const LABEL: Record<string, string> = {
  switch: "Switching to Polygon…",
  "approve-reset": "Resetting approval…",
  approve: "Approve in your wallet",
  "approve-confirm": "Waiting for the approval on Polygon…",
  send: "Confirm the swap in your wallet",
  confirm: "Waiting for Polygon to confirm…",
};

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function SwapPage() {
  const w = useWallet();
  const session = useSession();
  const owner = session.user?.evmAddresses[0] ?? null;
  const [cfg, setCfg] = useState<SwapCfg | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [pairId, setPairId] = useState<SwapPairId>("POL");
  const [dir, setDir] = useState<SwapDirection>("USDT_POL");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<(Action & { inSym: string; outSym: string }) | null>(null);

  useEffect(() => {
    const off = (reason: string): PairCfg => ({ enabled: false, reason, token: null, decimals: null, reserves: null });
    api<{ swap: SwapCfg }>("/api/swap/config")
      .then((r) => setCfg(r.swap))
      .catch((e) => setCfg({ pairs: { POL: off((e as Error).message), NIM: off((e as Error).message) } }));
  }, []);
  const pair = cfg?.pairs[pairId] ?? null;
  const loadBal = useCallback(async () => {
    if (!owner) return;
    try {
      setBal((await api<{ balances: Balances }>(`/api/swap/balances?address=${owner}`)).balances);
    } catch {}
  }, [owner]);
  useEffect(() => {
    const t = setTimeout(() => void loadBal(), 0);
    return () => clearTimeout(t);
  }, [loadBal]);

  const { from: inSym, to: outSym } = directionAssets(dir);
  const decOf = (sym: string) => (sym === "USDT" ? 6 : sym === "POL" ? 18 : (pair?.decimals ?? 18));
  const inDec = decOf(inSym);
  const outDec = decOf(outSym);
  const debounced = useDebounced(amount, 400);
  const amt = Number(amount);
  const rawHave = bal ? (inSym === "USDT" ? bal.usdt : inSym === "POL" ? bal.pol : bal.nim) : null;
  const have = rawHave === null ? null : inSym === "POL" ? Math.max(0, rawHave - POL_GAS_RESERVE) : rawHave;
  const tooMuch = have !== null && amt > have + 1e-12;
  const noGas = bal !== null && bal.pol < MIN_POL_FOR_GAS;
  const busy = phase !== "idle" && phase !== "done" && phase !== "error";

  const pickPair = (id: SwapPairId) => {
    setPairId(id);
    setDir(id === "POL" ? "USDT_POL" : "USDT_NIM");
    setAmount("");
    setQuote(null);
    setPhase("idle");
    setErr(null);
  };

  useEffect(() => {
    if (!pair?.enabled || !(Number(debounced) > 0)) return;
    let alive = true;
    api<{ quote: Quote }>(`/api/swap/quote?direction=${dir}&amount=${debounced}`)
      .then((r) => alive && (setQuote(r.quote), setQuoteErr(null)))
      .catch((e) => alive && (setQuote(null), setQuoteErr((e as Error).message)));
    return () => {
      alive = false;
    };
  }, [debounced, dir, pair?.enabled]);
  const liveQuote = Number(debounced) > 0 && debounced === amount && quote && quote.decimalsIn === inDec && quote.decimalsOut === outDec ? quote : null;
  const out = liveQuote ? Number(BigInt(liveQuote.amountOut)) / 10 ** outDec : null;
  const minOut = liveQuote ? (BigInt(liveQuote.amountOut) * (10_000n - SLIPPAGE_BPS)) / 10_000n : null;

  const run = async () => {
    if (!owner || !pair?.token || !liveQuote || !minOut || !bal) return;
    setErr(null);
    setResult(null);
    try {
      setPhase("switch");
      await w.ensureChain(POLYGON.chainIdHex);
      const units = toUnits(amount, inDec);
      const path = liveQuote.path as `0x${string}`[];
      const to = owner as `0x${string}`;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      let tx: { data: string; value?: string };
      if (inSym === "POL") {
        // Native POL in: no approval, the POL rides along as the transaction value.
        tx = { data: encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactETHForTokens", args: [minOut, path, to, deadline] }), value: `0x${units.toString(16)}` };
      } else {
        const tokenIn = inSym === "USDT" ? TOKENS.USDT.address : pair.token;
        const allowed = bal.allowance[inSym as "USDT" | "NIM"];
        await ensureAllowance(w.sendEvmTx, { token: tokenIn, spender: QUICKSWAP_ROUTER, units, current: toUnits(allowed.toFixed(inDec), inDec) }, (s) => setPhase(s));
        tx = {
          data:
            outSym === "POL"
              ? encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactTokensForETH", args: [units, minOut, path, to, deadline] })
              : encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactTokensForTokens", args: [units, minOut, path, to, deadline] }),
        };
      }
      setPhase("send");
      const { hash, from } = await w.sendEvmTx({ chainIdHex: POLYGON.chainIdHex, to: QUICKSWAP_ROUTER, ...tx });
      setPhase("confirm");
      const rec = await api<{ action: Action }>("/api/defi/actions", { method: "POST", json: { kind: "swap", txHash: hash, from, amount, direction: dir } });
      await waitForReceipt(hash).catch((e) => {
        if (!(e instanceof WalletActionError && e.kind === "unknown_outcome")) throw e;
      });
      let action = rec.action;
      for (let i = 0; i < 20 && action.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        action = (await api<{ action: Action }>(`/api/defi/actions/${rec.action.id}`)).action;
      }
      if (action.status === "failed") throw new Error(action.failureReason ?? "The swap failed.");
      setResult({ ...action, inSym, outSym });
      setPhase("done");
      void w.refreshBalances();
      setAmount("");
      void loadBal();
    } catch (e) {
      setPhase("error");
      if (e instanceof WalletActionError && e.kind === "rejected") setErr("Cancelled in your wallet. Nothing was swapped.");
      else setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  if (!session.user) return null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader title="Swap" subtitle="On Polygon, through QuickSwap, straight from your wallet." />

      <Segmented<SwapPairId>
        className="w-full"
        value={pairId}
        onChange={(id) => !busy && pickPair(id)}
        options={[
          { value: "POL", label: "USDT ↔ POL" },
          { value: "NIM", label: "NIM ↔ USDT" },
        ]}
      />

      {!cfg || !pair ? (
        <Skeleton className="h-60 w-full" />
      ) : !pair.enabled ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <ArrowDownUp className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">{pairId === "NIM" ? "Swapping opens when NIM lands on Polygon" : "USDT ↔ POL is unavailable right now"}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{pair.reason}</p>
            </div>
          </div>
          {pairId === "NIM" ? (
            <>
              <div className="mt-4 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
                Your NIM lives on the Nimiq blockchain, and QuickSwap runs on Polygon. Once Nimiq&apos;s bridge mints <strong>NIM on Polygon</strong> (1:1, backed by locked NIM) and a NIM/USDT pool exists, this screen swaps straight from your wallet. Until then:
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Link href="/pay?payWith=NIM">
                  <Button className="w-full">
                    <Receipt className="size-4" /> Pay bills with NIM
                  </Button>
                </Link>
                <Link href="/earn">
                  <Button variant="secondary" className="w-full">
                    <PiggyBank className="size-4" /> Earn on USDT
                  </Button>
                </Link>
              </div>
            </>
          ) : null}
        </Card>
      ) : !owner ? (
        <Card className="p-5">
          <p className="text-[15px] font-semibold text-fg">Verify your Polygon wallet</p>
          <Button className="mt-4 w-full" variant="dark" disabled={!w.evm.available} onClick={() => void w.linkEvm().then(() => session.refresh()).catch(() => {})}>
            <Wallet className="size-4" /> Verify wallet
          </Button>
        </Card>
      ) : (
        <>
          {phase === "done" && result ? (
            <Card className="p-5">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="size-8 shrink-0 text-up" />
                <div>
                  <p className="text-[15px] font-semibold text-fg">
                    Swapped {fmtNum(result.amountIn ?? 0, 4)} {result.inSym} → {fmtNum(result.amountOut ?? 0, 4)} {result.outSym}
                  </p>
                  <a href={`${POLYGON.explorer}/tx/${result.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3">
                    View on Polygonscan <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
              {result.outSym === "USDT" ? (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Link href="/earn">
                    <Button className="w-full">
                      <PiggyBank className="size-4" /> Earn with it
                    </Button>
                  </Link>
                  <Link href="/pay?payWith=USDT&from=swap">
                    <Button variant="secondary" className="w-full">
                      <Receipt className="size-4" /> Pay a bill
                    </Button>
                  </Link>
                </div>
              ) : result.outSym === "POL" ? (
                <p className="mt-3 text-[13px] text-fg-2">Your wallet now has POL for Polygon network fees, so USDT payments, Earn and Savings work.</p>
              ) : null}
            </Card>
          ) : null}

          <Card className="space-y-3 p-5">
            <Field
              label={`You pay (${inSym})`}
              htmlFor="swap-in"
              hint={have !== null ? `Available: ${fmtNum(have, 4)} ${inSym}${inSym === "POL" ? ` (keeps ${POL_GAS_RESERVE} POL for gas)` : ""}` : undefined}
              error={tooMuch ? "More than your balance." : null}
            >
              <Input id="swap-in" inputMode="decimal" placeholder="0.0" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} trail={inSym} />
            </Field>
            <div className="flex justify-center">
              <button
                aria-label="Switch direction"
                disabled={busy}
                onClick={() => {
                  setDir(`${outSym}_${inSym}` as SwapDirection);
                  setAmount("");
                  setQuote(null);
                }}
                className="grid size-11 place-items-center rounded-full bg-surface-2 text-fg-2 hover:bg-surface-3"
              >
                <ArrowDownUp className="size-5" />
              </button>
            </div>
            <Field label={`You receive (${outSym})`}>
              <div className="flex h-14 items-center rounded-[var(--radius-control)] bg-surface-2 px-4 text-[18px] font-semibold text-fg">
                {amt > 0 ? (out !== null ? `≈ ${fmtNum(out, 4)} ${outSym}` : <Spinner className="size-4" />) : <span className="text-fg-3">0.0</span>}
              </div>
            </Field>
            {liveQuote && minOut !== null ? (
              <div className="border-t border-line pt-1">
                <KV k="Minimum received" v={`${fmtNum(Number(minOut) / 10 ** outDec, 4)} ${outSym} (0.5% slippage)`} />
                <KV k="Price impact" v={liveQuote.priceImpact !== null ? `${(liveQuote.priceImpact * 100).toFixed(2)}%` : "—"} />
                <KV k="Route" v="QuickSwap V2 · Polygon" />
              </div>
            ) : null}
            {quoteErr && amt > 0 ? <Notice tone="error">{quoteErr}</Notice> : null}
            {liveQuote?.priceImpact && liveQuote.priceImpact > 0.03 ? <Notice tone="warn">High price impact: the pool is small for this amount.</Notice> : null}
            {noGas ? (
              <Notice tone="warn" title="This swap needs a little POL for gas">
                Every Polygon transaction, including this swap, pays its network fee in POL, and this wallet has almost none. Send about 0.1 POL to it once (from an exchange or another wallet); after that you can top up POL here with USDT whenever you need.
              </Notice>
            ) : null}
            {busy ? (
              <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3.5 text-[13.5px] text-fg-2">
                <Spinner className="size-4 text-accent-strong" /> {LABEL[phase]}
              </div>
            ) : null}
            {err ? <Notice tone="error">{err}</Notice> : null}
            <Button size="lg" disabled={!liveQuote || tooMuch || busy || !(amt > 0) || noGas} loading={busy} onClick={run}>
              <ArrowDownUp className="size-4" /> Swap {inSym} → {outSym}
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
