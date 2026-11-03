"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CheckCircle2, ChevronRight, ExternalLink, Lock, LockOpen, Users, Wallet } from "lucide-react";
import { encodeFunctionData } from "viem";
import { Badge, Button, Card, cx, EmptyState, Field, Input, KV, Notice, PageHeader, Skeleton, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useMoney } from "@/lib/client/money";
import { ensureAllowance, waitForReceipt } from "@/lib/client/polygon-tx";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtNum, fmtUsd } from "@/lib/shared/format";
import { POLYGON, TOKENS, toUnits } from "@/lib/shared/polygon-defi";
import { MAX_LOCK_SECONDS, MIN_LOCK_SECONDS, SAVINGS_VAULT_ABI, type SavingsInfo, type SavingsLockDTO } from "@/lib/shared/savings";

interface Position { walletUsdt: number; pol: number }
type Phase = "idle" | "switch" | "approve-reset" | "approve" | "approve-confirm" | "send" | "confirm" | "error";

const STEP: Record<Exclude<Phase, "idle" | "error">, string> = {
  switch: "Switching to Polygon…",
  "approve-reset": "Resetting USDT approval…",
  approve: "Approve USDT in your wallet",
  "approve-confirm": "Waiting for the approval on Polygon…",
  send: "Confirm the lock in your wallet",
  confirm: "Waiting for Polygon to confirm…",
};
const MIN_POL = 0.003;
const PRESETS: { label: string; days: number }[] = [
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
];

/** "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local">. */
function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
function countdown(iso: string, now: number) {
  let s = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export default function SavingsPage() {
  const w = useWallet();
  const session = useSession();
  const money = useMoney();
  const owner = session.user?.evmAddresses[0] ?? null;
  const [info, setInfo] = useState<SavingsInfo | null>(null);
  const [locks, setLocks] = useState<SavingsLockDTO[] | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [unlock, setUnlock] = useState(() => toLocalInput(new Date(Date.now() + 30 * 86400_000)));
  const [agree, setAgree] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [justLocked, setJustLocked] = useState<SavingsLockDTO | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await api<{ savings: SavingsInfo; locks: SavingsLockDTO[] }>("/api/savings");
      setInfo(r.savings);
      setLocks(r.locks);
    } catch (e) {
      setInfo({ enabled: false, reason: (e as Error).message, vaultAddress: null, autoRelease: false });
      setLocks([]);
    }
    if (owner) {
      try {
        setPos((await api<{ position: Position }>(`/api/earn/position?address=${owner}`)).position);
      } catch {}
    }
  }, [owner]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const amt = Number(amount);
  const unlockMs = new Date(unlock).getTime();
  const tooSoon = !Number.isFinite(unlockMs) || unlockMs < now + MIN_LOCK_SECONDS * 1000;
  const tooLate = Number.isFinite(unlockMs) && unlockMs > now + MAX_LOCK_SECONDS * 1000;
  const tooMuch = pos !== null && amt > pos.walletUsdt + 1e-9;
  const noGas = pos !== null && pos.pol < MIN_POL;
  const busy = phase !== "idle" && phase !== "error";
  const canLock = Boolean(info?.enabled && owner && amt > 0 && !tooMuch && !tooSoon && !tooLate && agree && !noGas && !busy);
  const locked = useMemo(() => (locks ?? []).filter((l) => l.status === "locked"), [locks]);
  const total = locked.reduce((s, l) => s + (l.amount ?? 0), 0);

  const lockNow = async () => {
    if (!info?.vaultAddress || !owner || !pos) return;
    setErr(null);
    setJustLocked(null);
    try {
      setPhase("switch");
      await w.ensureChain(POLYGON.chainIdHex);
      const units = toUnits(amount, 6);
      const current = toUnits(((await api<{ allowance: number }>(`/api/savings/allowance?address=${owner}`).catch(() => ({ allowance: 0 }))).allowance).toFixed(6), 6);
      await ensureAllowance(w.sendEvmTx, { token: TOKENS.USDT.address, spender: info.vaultAddress, units, current }, (s) => setPhase(s));
      setPhase("send");
      const unlockAt = BigInt(Math.floor(unlockMs / 1000));
      const { hash, from } = await w.sendEvmTx({
        chainIdHex: POLYGON.chainIdHex,
        to: info.vaultAddress,
        data: encodeFunctionData({ abi: SAVINGS_VAULT_ABI, functionName: "lock", args: [TOKENS.USDT.address, units, unlockAt] }),
      });
      setPhase("confirm");
      const rec = await api<{ lock: SavingsLockDTO }>("/api/savings/locks", { method: "POST", json: { txHash: hash, from, label: label.trim() || null } });
      await waitForReceipt(hash).catch((e) => {
        if (!(e instanceof WalletActionError && e.kind === "unknown_outcome")) throw e;
      });
      let l = rec.lock;
      for (let i = 0; i < 20 && l.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        l = (await api<{ lock: SavingsLockDTO }>(`/api/savings/locks/${l.id}`)).lock;
      }
      if (l.status === "failed") throw new Error(l.failureReason ?? "The lock failed.");
      setJustLocked(l);
      setAmount("");
      setLabel("");
      setAgree(false);
      setPhase("idle");
      void load();
      void w.refreshBalances();
    } catch (e) {
      setPhase("error");
      if (e instanceof WalletActionError && e.kind === "rejected") setErr("Cancelled in your wallet. Nothing was locked.");
      else setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const release = async (l: SavingsLockDTO) => {
    if (!info?.vaultAddress || l.lockId === null) return;
    setErr(null);
    setReleasing(l.id);
    try {
      await w.ensureChain(POLYGON.chainIdHex);
      const { hash } = await w.sendEvmTx({
        chainIdHex: POLYGON.chainIdHex,
        to: info.vaultAddress,
        data: encodeFunctionData({ abi: SAVINGS_VAULT_ABI, functionName: "release", args: [BigInt(l.lockId)] }),
      });
      await waitForReceipt(hash).catch((e) => {
        if (!(e instanceof WalletActionError && e.kind === "unknown_outcome")) throw e;
      });
      await api(`/api/savings/locks/${l.id}/release`, { method: "POST", json: { txHash: hash } });
      await load();
      void w.refreshBalances();
    } catch (e) {
      if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setReleasing(null);
    }
  };

  if (!session.user) return null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader title="Savings" subtitle="Lock USDT until a date you choose. It can't be spent before then, not even by you." />

      <Link href="/thrift" className="block">
        <Card className="flex items-center gap-3 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
            <Users className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-semibold text-fg">Thrift</span>
            <span className="block text-[12.5px] text-fg-3">Save together as a group, one member takes the pot each round.</span>
          </span>
          <ChevronRight className="size-4 text-fg-3" />
        </Card>
      </Link>

      {!info || locks === null ? (
        <Skeleton className="h-64 w-full" />
      ) : !info.enabled ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <Lock className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">Locked savings is coming</p>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{info.reason}</p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <div className="bg-[radial-gradient(120%_100%_at_50%_0%,var(--color-accent-soft),transparent_70%)] px-5 pt-6 pb-5 text-center">
              <p className="text-[13px] font-medium text-fg-2">Locked in Savings</p>
              <p className="num mt-1 text-[38px] font-semibold tracking-[-0.03em] text-fg">{fmtNum(total, 2, 2)} USDT</p>
              <p className="num text-[13px] text-fg-3">
                {money.currency !== "USD" && money.local(total) ? `${money.local(total)} · ` : ""}
                {fmtUsd(total)}
              </p>
            </div>
          </Card>

          {justLocked ? (
            <Notice tone="success" title={`Locked ${fmtNum(justLocked.amount ?? 0, 2, 2)} USDT`}>
              Unlocks {justLocked.unlockAt ? fmtWhen(justLocked.unlockAt) : "at the time you set"}.{" "}
              {info.autoRelease ? "It's sent back to your wallet automatically then." : "Withdraw it here any time after that."}
            </Notice>
          ) : null}

          {!owner ? (
            <Card className="p-5">
              <p className="text-[15px] font-semibold text-fg">Verify your Polygon wallet</p>
              <p className="mt-1 text-[13px] text-fg-2">Savings locks USDT from your own wallet into the Savings Vault contract.</p>
              <Button className="mt-4 w-full" variant="dark" disabled={!w.evm.available} onClick={() => void w.linkEvm().then(() => session.refresh()).catch(() => {})}>
                <Wallet className="size-4" /> Verify wallet
              </Button>
            </Card>
          ) : (
            <Card className="space-y-4 p-5">
              <p className="text-[15px] font-semibold text-fg">New lock</p>
              <Field label="Amount to lock" htmlFor="sv-amt" hint={pos ? `In wallet: ${fmtNum(pos.walletUsdt, 2, 2)} USDT` : undefined} error={tooMuch ? "More than you have." : null}>
                <Input id="sv-amt" inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} trail="USDT" />
              </Field>
              <Field label="Unlock on" htmlFor="sv-when" error={tooSoon ? "Pick a time at least 10 minutes from now." : tooLate ? "The longest lock is 5 years." : null}>
                <Input id="sv-when" type="datetime-local" value={unlock} disabled={busy} min={toLocalInput(new Date(now + MIN_LOCK_SECONDS * 1000))} onChange={(e) => setUnlock(e.target.value)} />
              </Field>
              <div className="scrollbar-none -mt-2 flex gap-2 overflow-x-auto">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    disabled={busy}
                    onClick={() => setUnlock(toLocalInput(new Date(Date.now() + p.days * 86400_000)))}
                    className="shrink-0 rounded-full bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-fg-2 hover:bg-surface-3"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Field label="Goal (optional)" htmlFor="sv-label">
                <Input id="sv-label" placeholder="e.g. Rent, school fees" maxLength={40} value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <label className="flex items-start gap-3 rounded-2xl bg-surface-2 p-3.5 text-[13px] leading-relaxed text-fg-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
                <span>
                  I understand this USDT can&apos;t be withdrawn before <strong className="text-fg">{Number.isFinite(unlockMs) ? fmtWhen(new Date(unlockMs).toISOString()) : "the unlock time"}</strong>, by me or anyone.
                </span>
              </label>
              {noGas ? (
                <Notice tone="warn" title="Add a little POL for gas">
                  Locking is a Polygon transaction, paid in POL. <Link href="/swap" className="font-semibold underline">Swap a little USDT to POL</Link> first.
                </Notice>
              ) : null}
              {busy ? (
                <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3.5 text-[13.5px] text-fg-2">
                  <Spinner className="size-4 text-accent-strong" /> {STEP[phase as keyof typeof STEP]}
                </div>
              ) : null}
              {err ? <Notice tone="error">{err}</Notice> : null}
              <Button size="lg" disabled={!canLock} loading={busy} onClick={lockNow}>
                <Lock className="size-4" /> Lock {amt > 0 ? `${fmtNum(amt, 2, 2)} USDT` : "savings"}
              </Button>
              <div className="border-t border-line pt-2">
                <KV k="Where it's held" v="Savings Vault · Polygon" />
                <KV k="Paid back to" v="Your wallet only" />
                <KV k="At unlock" v={info.autoRelease ? "Sent back automatically" : "Withdraw with one tap"} />
              </div>
            </Card>
          )}

          <div className="space-y-2">
            <h2 className="px-1 text-[13px] font-medium text-fg-2">Your locks</h2>
            {locks.length === 0 ? (
              <EmptyState icon={<Lock className="size-5" />} title="Nothing locked yet">
                Lock USDT for rent, school fees or a goal, and it stays put until the date you pick.
              </EmptyState>
            ) : (
              locks.map((l) => (
                <Card key={l.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className={cx("grid size-10 shrink-0 place-items-center rounded-full", l.status === "released" ? "bg-up-soft text-up" : "bg-accent-soft text-accent-strong")}>
                      {l.status === "released" ? <CheckCircle2 className="size-5" /> : l.unlocked ? <LockOpen className="size-5" /> : <Lock className="size-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[14.5px] font-semibold text-fg">{l.label ?? "Savings"}</p>
                        <p className="num shrink-0 text-[14.5px] font-semibold text-fg">{l.amount !== null ? `${fmtNum(l.amount, 2, 2)} USDT` : "—"}</p>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-[12.5px] text-fg-3">
                        <span>
                          {l.status === "pending"
                            ? "Confirming on Polygon…"
                            : l.status === "failed"
                              ? (l.failureReason ?? "Failed")
                              : l.status === "released"
                                ? `Unlocked${l.releasedBy === "auto" ? " · sent to your wallet" : ""}${l.releasedAt ? ` · ${fmtWhen(l.releasedAt)}` : ""}`
                                : l.unlocked
                                  ? "Unlocked: ready to withdraw"
                                  : `Unlocks in ${countdown(l.unlockAt!, now)}`}
                        </span>
                        {l.status === "locked" && l.unlockAt ? <span className="shrink-0">{fmtWhen(l.unlockAt)}</span> : null}
                        {l.status === "failed" ? <Badge tone="down">Failed</Badge> : null}
                      </div>
                      {l.status === "locked" && l.unlocked ? (
                        <Button className="mt-3 w-full" size="sm" loading={releasing === l.id} disabled={Boolean(releasing) || noGas} onClick={() => void release(l)}>
                          <LockOpen className="size-4" /> Withdraw to wallet
                        </Button>
                      ) : null}
                      <a href={`${POLYGON.explorer}/tx/${l.releaseTxHash ?? l.lockTxHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-fg-3">
                        Polygonscan <ExternalLink className="size-3" />
                      </a>
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>

          <p className="px-1 text-xs leading-relaxed text-fg-3">
            Your USDT goes from your wallet into the AuraPay Savings Vault, a small open contract on Polygon with no owner and no admin. It can&apos;t release a lock before its time, and it can
            only ever pay a lock back to the wallet that made it. Locks don&apos;t earn interest; for that, use{" "}
            <Link href="/earn" className="underline">
              Earn
            </Link>
            . <ArrowLeftRight className="inline size-3" /> Need POL for gas?{" "}
            <Link href="/swap" className="underline">
              Swap
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
