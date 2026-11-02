"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownUp, CheckCircle2, ExternalLink, PiggyBank, Receipt, Wallet } from "lucide-react";
import { encodeFunctionData } from "viem";
import { Button, Card, Field, Input, KV, Notice, PageHeader, Skeleton, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { ensureAllowance, waitForReceipt } from "@/lib/client/polygon-tx";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtNum } from "@/lib/shared/format";
import { POLYGON, QUICKSWAP_ROUTER, toUnits, TOKENS, V2_ROUTER_ABI } from "@/lib/shared/polygon-defi";

type Direction = "NIM_USDT" | "USDT_NIM";
interface SwapCfg { enabled: boolean; reason: string | null; nimToken: string | null; nimDecimals: number | null; reserves: { nim: number; usdt: number } | null }
interface Balances { nim: number; usdt: number; pol: number; allowance: { NIM: number; USDT: number } }
interface Quote { amountOut: string; path: string[]; priceImpact: number | null }
interface Action { id: string; status: "pending" | "confirmed" | "failed"; failureReason: string | null; amountIn: number | null; amountOut: number | null; txHash: string }
type Phase = "idle" | "switch" | "approve-reset" | "approve" | "approve-confirm" | "send" | "confirm" | "done" | "error";

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
  const [dir, setDir] = useState<Direction>("USDT_NIM");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Action | null>(null);

  useEffect(() => {
    api<{ swap: SwapCfg }>("/api/swap/config").then((r) => setCfg(r.swap)).catch((e) => setCfg({ enabled: false, reason: (e as Error).message, nimToken: null, nimDecimals: null, reserves: null }));
  }, []);
  const loadBal = useCallback(async () => {
    if (!owner || !cfg?.enabled) return;
    try {
      setBal((await api<{ balances: Balances }>(`/api/swap/balances?address=${owner}`)).balances);
    } catch {}
  }, [owner, cfg?.enabled]);
  useEffect(() => {
    const t = setTimeout(() => void loadBal(), 0);
    return () => clearTimeout(t);
  }, [loadBal]);

  const inSym = dir === "NIM_USDT" ? "NIM" : "USDT";
  const outSym = dir === "NIM_USDT" ? "USDT" : "NIM";
  const inDec = dir === "NIM_USDT" ? (cfg?.nimDecimals ?? 18) : 6;
  const outDec = dir === "NIM_USDT" ? 6 : (cfg?.nimDecimals ?? 18);
  const debounced = useDebounced(amount, 400);
  const amt = Number(amount);
  const have = bal ? (dir === "NIM_USDT" ? bal.nim : bal.usdt) : null;
  const tooMuch = have !== null && amt > have + 1e-12;
  const busy = phase !== "idle" && phase !== "done" && phase !== "error";

  useEffect(() => {
    if (!cfg?.enabled || !(Number(debounced) > 0)) return;
    let alive = true;
    api<{ quote: Quote }>(`/api/swap/quote?direction=${dir}&amount=${debounced}`)
      .then((r) => alive && (setQuote(r.quote), setQuoteErr(null)))
      .catch((e) => alive && (setQuote(null), setQuoteErr((e as Error).message)));
    return () => {
      alive = false;
    };
  }, [debounced, dir, cfg?.enabled]);
  const liveQuote = Number(debounced) > 0 && debounced === amount ? quote : null;
  const out = liveQuote ? Number(BigInt(liveQuote.amountOut)) / 10 ** outDec : null;
  const minOut = liveQuote ? (BigInt(liveQuote.amountOut) * (10_000n - SLIPPAGE_BPS)) / 10_000n : null;

  const run = async () => {
    if (!owner || !cfg?.nimToken || !liveQuote || !minOut || !bal) return;
    setErr(null);
    setResult(null);
    try {
      setPhase("switch");
      await w.ensureChain(POLYGON.chainIdHex);
      const units = toUnits(amount, inDec);
      const tokenIn = dir === "NIM_USDT" ? cfg.nimToken : TOKENS.USDT.address;
      await ensureAllowance(w.sendEvmTx, { token: tokenIn, spender: QUICKSWAP_ROUTER, units, current: toUnits(bal.allowance[inSym].toFixed(inDec), inDec) }, (s) => setPhase(s));
      setPhase("send");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const { hash, from } = await w.sendEvmTx({
        chainIdHex: POLYGON.chainIdHex,
        to: QUICKSWAP_ROUTER,
        data: encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactTokensForTokens", args: [units, minOut, liveQuote.path as `0x${string}`[], owner as `0x${string}`, deadline] }),
      });
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
      setResult(action);
      setPhase("done");
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
      <PageHeader title="Swap" subtitle="NIM ↔ USDT on Polygon, through QuickSwap." />

      {!cfg ? (
        <Skeleton className="h-60 w-full" />
      ) : !cfg.enabled ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <ArrowDownUp className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">Swapping opens when NIM lands on Polygon</p>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{cfg.reason}</p>
            </div>
          </div>
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
                    Swapped {fmtNum(result.amountIn ?? 0, 4)} {inSym} → {fmtNum(result.amountOut ?? 0, 4)} {outSym}
                  </p>
                  <a href={`${POLYGON.explorer}/tx/${result.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3">
                    View on Polygonscan <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
              {outSym === "USDT" ? (
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
              ) : null}
            </Card>
          ) : null}

          <Card className="space-y-3 p-5">
            <Field label={`You pay (${inSym})`} htmlFor="swap-in" hint={have !== null ? `Balance: ${fmtNum(have, 4)} ${inSym}` : undefined} error={tooMuch ? "More than your balance." : null}>
              <Input id="swap-in" inputMode="decimal" placeholder="0.0" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} trail={inSym} />
            </Field>
            <div className="flex justify-center">
              <button
                aria-label="Switch direction"
                disabled={busy}
                onClick={() => {
                  setDir(dir === "NIM_USDT" ? "USDT_NIM" : "NIM_USDT");
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
            {bal && bal.pol < 0.01 ? <Notice tone="warn">Add a little POL to this wallet for Polygon gas.</Notice> : null}
            {busy ? (
              <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3.5 text-[13.5px] text-fg-2">
                <Spinner className="size-4 text-accent-strong" /> {LABEL[phase]}
              </div>
            ) : null}
            {err ? <Notice tone="error">{err}</Notice> : null}
            <Button size="lg" disabled={!liveQuote || tooMuch || busy || !(amt > 0) || (bal?.pol ?? 1) < 0.01} loading={busy} onClick={run}>
              <ArrowDownUp className="size-4" /> Swap {inSym} → {outSym}
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
