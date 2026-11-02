"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, CheckCircle2, ExternalLink, PiggyBank, Receipt, Users, Wallet } from "lucide-react";
import { encodeFunctionData } from "viem";
import { contributionUrl, type Circle } from "@/components/savings";
import { Button, Card, cx, Field, Input, KV, Notice, PageHeader, Segmented, Skeleton, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useMoney } from "@/lib/client/money";
import { ensureAllowance, waitForReceipt } from "@/lib/client/polygon-tx";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtNum, fmtUsd, shortAddress } from "@/lib/shared/format";
import { AAVE_POOL, AAVE_POOL_ABI, MAX_UINT256, POLYGON, TOKENS, toUnits } from "@/lib/shared/polygon-defi";

interface Position {
  address: string;
  walletUsdt: number;
  supplied: number;
  pol: number;
  allowance: number;
  apy: number | null;
}
interface Action {
  id: string;
  status: "pending" | "confirmed" | "failed";
  failureReason: string | null;
  amountIn: number | null;
  amountOut: number | null;
  txHash: string;
}
type Mode = "deposit" | "withdraw";
type Phase = "idle" | "switch" | "approve-reset" | "approve" | "approve-confirm" | "send" | "confirm" | "done" | "error";

const STEP_LABEL: Record<Exclude<Phase, "idle" | "done" | "error">, string> = {
  switch: "Switching to Polygon…",
  "approve-reset": "Resetting USDT approval…",
  approve: "Approve USDT in your wallet",
  "approve-confirm": "Waiting for the approval on Polygon…",
  send: "Confirm in your wallet",
  confirm: "Waiting for Polygon to confirm…",
};

export default function EarnPage() {
  const w = useWallet();
  const session = useSession();
  const money = useMoney();
  const owner = session.user?.evmAddresses[0] ?? null;
  const [pos, setPos] = useState<Position | null>(null);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const [isMax, setIsMax] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ mode: Mode; action: Action } | null>(null);
  const [linking, setLinking] = useState(false);
  const [dueCircle, setDueCircle] = useState<Circle | null>(null);

  const load = useCallback(async () => {
    if (!owner) return;
    try {
      const r = await api<{ position: Position }>(`/api/earn/position?address=${owner}`);
      setPos(r.position);
      setPosErr(null);
    } catch (e) {
      setPosErr((e as Error).message);
    }
  }, [owner]);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const amt = Number(amount);
  const max = mode === "deposit" ? (pos?.walletUsdt ?? 0) : (pos?.supplied ?? 0);
  const tooMuch = pos !== null && amt > max + 1e-9;
  const noGas = pos !== null && pos.pol < 0.01;
  const busy = phase !== "idle" && phase !== "done" && phase !== "error";
  const canSubmit = Boolean(owner && pos && amt > 0 && !tooMuch && !busy);

  const run = async () => {
    if (!owner || !pos) return;
    setErr(null);
    setResult(null);
    try {
      setPhase("switch");
      await w.ensureChain(POLYGON.chainIdHex);
      const units = toUnits(amount, 6);
      let hash: string, from: string;
      if (mode === "deposit") {
        await ensureAllowance(w.sendEvmTx, { token: TOKENS.USDT.address, spender: AAVE_POOL, units, current: toUnits(pos.allowance.toFixed(6), 6) }, (s) => setPhase(s));
        setPhase("send");
        ({ hash, from } = await w.sendEvmTx({
          chainIdHex: POLYGON.chainIdHex,
          to: AAVE_POOL,
          data: encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "supply", args: [TOKENS.USDT.address, units, owner as `0x${string}`, 0] }),
        }));
      } else {
        setPhase("send");
        ({ hash, from } = await w.sendEvmTx({
          chainIdHex: POLYGON.chainIdHex,
          to: AAVE_POOL,
          // "Max" withdraws everything including interest accrued since the balance was read.
          data: encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "withdraw", args: [TOKENS.USDT.address, isMax ? MAX_UINT256 : units, owner as `0x${string}`] }),
        }));
      }
      setPhase("confirm");
      // Record right away (so it's in Activity even if this screen closes), then wait for the chain.
      const rec = await api<{ action: Action }>("/api/defi/actions", {
        method: "POST",
        json: { kind: mode === "deposit" ? "earn_supply" : "earn_withdraw", txHash: hash, from, amount: isMax ? undefined : amount },
      });
      await waitForReceipt(hash).catch((e) => {
        if (!(e instanceof WalletActionError && e.kind === "unknown_outcome")) throw e;
      });
      let action = rec.action;
      for (let i = 0; i < 20 && action.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        action = (await api<{ action: Action }>(`/api/defi/actions/${rec.action.id}`)).action;
      }
      if (action.status === "failed") throw new Error(action.failureReason ?? "The transaction failed.");
      setResult({ mode, action });
      setPhase("done");
      setAmount("");
      setIsMax(false);
      void load();
      if (mode === "withdraw") {
        // If a savings-circle contribution in USDT is due, offer it directly.
        api<{ circles: Circle[] }>("/api/circles")
          .then((r) => setDueCircle(r.circles.find((c) => c.currency === "USDT" && c.myAction?.type === "pay") ?? null))
          .catch(() => {});
      }
    } catch (e) {
      setPhase("error");
      if (e instanceof WalletActionError && e.kind === "rejected") setErr("Cancelled in your wallet. Nothing was sent.");
      else setErr((e as Error).message);
    }
  };

  if (!session.user) return null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader
        title="Earn"
        subtitle="Put idle USDT to work on Aave, on Polygon. Withdraw any time."
        action={
          <Link href="/swap" className="inline-flex h-8 items-center gap-1 rounded-full bg-surface px-3 text-[12.5px] font-medium text-fg-2 shadow-[var(--shadow-card)]">
            <ArrowLeftRight className="size-3.5" /> Swap
          </Link>
        }
      />

      {!owner ? (
        <Card className="p-5">
          <p className="text-[15px] font-semibold text-fg">Verify your USDT wallet</p>
          <p className="mt-1 text-[13px] text-fg-2">Earn uses the USDT in your Nimiq Pay wallet on Polygon. Verify it once with a signature (no transaction).</p>
          <Button
            className="mt-4 w-full"
            variant="dark"
            loading={linking}
            disabled={!w.evm.available}
            onClick={async () => {
              setLinking(true);
              try {
                await w.linkEvm();
                await session.refresh();
              } catch (e) {
                if (!(e instanceof WalletActionError && e.kind === "rejected")) setPosErr((e as Error).message);
              } finally {
                setLinking(false);
              }
            }}
          >
            <Wallet className="size-4" /> Verify USDT wallet
          </Button>
          {!w.evm.available ? <p className="mt-2 text-xs text-fg-3">Open AuraPay in Nimiq Pay to continue.</p> : null}
        </Card>
      ) : (
        <>
          {/* Position */}
          <section className="hero-surface -mx-4 rounded-[32px] px-5 pt-6 pb-6 text-center sm:mx-0">
            <p className="text-[13px] font-medium text-fg-2">Supplied on Aave</p>
            {pos ? (
              <>
                <p className="num mt-1 text-[40px] font-semibold tracking-[-0.03em] text-fg">{fmtNum(pos.supplied, 2, 2)} USDT</p>
                <p className="num text-[13px] text-fg-3">
                  {money.currency !== "USD" && money.local(pos.supplied) ? `${money.local(pos.supplied)} · ` : ""}
                  {fmtUsd(pos.supplied)}
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2 text-left">
                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-[11px] text-fg-3">Supply APY</p>
                    <p className="num mt-0.5 text-[17px] font-semibold text-up">{pos.apy !== null ? `${(pos.apy * 100).toFixed(2)}%` : "—"}</p>
                  </div>
                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-[11px] text-fg-3">Wallet USDT</p>
                    <p className="num mt-0.5 text-[17px] font-semibold text-fg">{fmtNum(pos.walletUsdt, 2, 2)}</p>
                  </div>
                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-[11px] text-fg-3">POL (gas)</p>
                    <p className={cx("num mt-0.5 text-[17px] font-semibold", noGas ? "text-down" : "text-fg")}>{fmtNum(pos.pol, 3)}</p>
                  </div>
                </div>
                {pos.apy !== null && pos.supplied > 0 ? (
                  <p className="mt-3 text-[12.5px] text-fg-2">≈ {fmtUsd(pos.supplied * pos.apy)} a year at today&apos;s rate (variable)</p>
                ) : null}
              </>
            ) : posErr ? (
              <Notice tone="error" className="mt-3 text-left">{posErr}</Notice>
            ) : (
              <Skeleton className="mx-auto mt-2 h-12 w-48" />
            )}
          </section>

          {noGas ? <Notice tone="warn" title="Add a little POL for gas">Polygon transactions need a small amount of POL (about 0.01–0.05 per transaction) in the same wallet.</Notice> : null}

          {/* Result */}
          {phase === "done" && result ? (
            <Card className="p-5">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="size-8 shrink-0 text-up" />
                <div>
                  <p className="text-[15px] font-semibold text-fg">
                    {result.mode === "deposit" ? `Deposited ${fmtNum(result.action.amountIn ?? 0, 2, 2)} USDT` : `Withdrew ${fmtNum(result.action.amountOut ?? 0, 2, 2)} USDT`}
                  </p>
                  <a href={`${POLYGON.explorer}/tx/${result.action.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
                    View on Polygonscan <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
              {result.mode === "withdraw" ? (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Link href="/pay?payWith=USDT&from=earn">
                    <Button className="w-full">
                      <Receipt className="size-4" /> Pay a bill
                    </Button>
                  </Link>
                  <Link href={dueCircle ? contributionUrl(dueCircle, dueCircle.myAction!.round!, dueCircle.myAction!.to!) : "/savings"}>
                    <Button variant="secondary" className="w-full">
                      <Users className="size-4" /> {dueCircle ? "Pay circle" : "Add to savings circle"}
                    </Button>
                  </Link>
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-fg-2">It starts earning right away. Withdraw any time; interest is added to your balance continuously.</p>
              )}
            </Card>
          ) : null}

          {/* Form */}
          <Card className="space-y-4 p-5">
            <Segmented<Mode>
              className="w-full"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setAmount("");
                setIsMax(false);
                setPhase("idle");
                setErr(null);
              }}
              options={[
                { value: "deposit", label: "Deposit" },
                { value: "withdraw", label: "Withdraw" },
              ]}
            />
            <Field
              label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
              htmlFor="earn-amt"
              hint={pos ? `${mode === "deposit" ? "In wallet" : "Supplied"}: ${fmtNum(max, 2, 2)} USDT` : undefined}
              error={tooMuch ? "More than you have." : null}
            >
              <Input
                id="earn-amt"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                disabled={busy}
                onChange={(e) => {
                  setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                  setIsMax(false);
                }}
                trail={
                  <button
                    type="button"
                    className="rounded-full bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent-strong"
                    disabled={!pos || busy}
                    onClick={() => {
                      setAmount((Math.floor(max * 1e6) / 1e6).toString());
                      setIsMax(mode === "withdraw");
                    }}
                  >
                    Max
                  </button>
                }
              />
            </Field>

            {busy ? (
              <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3.5 text-[13.5px] text-fg-2">
                <Spinner className="size-4 text-accent-strong" /> {STEP_LABEL[phase as keyof typeof STEP_LABEL]}
              </div>
            ) : null}
            {err ? <Notice tone="error">{err}</Notice> : null}

            <Button size="lg" disabled={!canSubmit || noGas} loading={busy} onClick={run}>
              <PiggyBank className="size-4" /> {mode === "deposit" ? "Deposit to Earn" : isMax ? "Withdraw everything" : "Withdraw"}
            </Button>

            <div className="border-t border-line pt-2">
              <KV k="Protocol" v="Aave V3 · Polygon" />
              <KV k="Wallet" v={<span className="font-mono text-xs">{shortAddress(owner, 8, 6)}</span>} />
              {mode === "deposit" ? <KV k="Steps" v={pos && pos.allowance >= amt && amt > 0 ? "1 transaction" : "Approve, then deposit"} /> : <KV k="Steps" v="1 transaction" />}
            </div>
          </Card>

          <p className="px-1 text-xs leading-relaxed text-fg-3">
            Your USDT is supplied from your own wallet to Aave&apos;s audited lending pool and you receive aPolUSDT, which grows as interest accrues. AuraPay never holds it. The rate is variable and set by Aave; smart-contract risk applies. USDT can&apos;t be borrowed against here.
          </p>
        </>
      )}
    </div>
  );
}
