"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2 } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useStatus } from "@/lib/client/hooks";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { countryByCode } from "@/lib/shared/countries";
import { fmtCrypto, fmtMoney, fmtUsd } from "@/lib/shared/format";
import type { BillScheduleDTO, ScheduleFrequency, ScheduleStatus } from "@/lib/shared/types";
import { Badge, Button, Card, cx, Field, Input, KV, Notice, Segmented, SlideToConfirm, Spinner, TestBadge } from "../ui";

export interface ScheduleChoice {
  startLocal: string; // yyyy-MM-ddTHH:mm in the device's time zone
  frequency: ScheduleFrequency;
  totalRuns: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Tomorrow at 09:00 local time. */
export function defaultSchedule(): ScheduleChoice {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return { startLocal: toLocalInput(d), frequency: "monthly", totalRuns: 3 };
}

export const FREQ_LABEL: Record<ScheduleFrequency, string> = { once: "Once", weekly: "Every week", monthly: "Every month" };

export function fmtWhen(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The "when" controls: date & time, repeat, number of payments. */
export function ScheduleOptions({ value, onChange }: { value: ScheduleChoice; onChange: (v: ScheduleChoice) => void }) {
  const min = toLocalInput(new Date());
  return (
    <div className="space-y-4 rounded-[20px] border border-line bg-surface p-4">
      <Field label="First payment" htmlFor="sched-start" hint="Uses your device's time zone. We pay automatically at this time.">
        <Input id="sched-start" type="datetime-local" min={min} value={value.startLocal} onChange={(e) => onChange({ ...value, startLocal: e.target.value })} />
      </Field>
      <Field label="Repeat">
        <Segmented<ScheduleFrequency>
          className="w-full"
          value={value.frequency}
          onChange={(f) => onChange({ ...value, frequency: f, totalRuns: f === "once" ? 1 : Math.max(2, value.totalRuns) })}
          options={[
            { value: "once", label: "Once" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ]}
        />
      </Field>
      {value.frequency !== "once" ? (
        <Field label="Number of payments" hint="You prepay all of them now. Cancel any time and the unused ones are refunded.">
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" aria-label="Fewer payments" disabled={value.totalRuns <= 2} onClick={() => onChange({ ...value, totalRuns: value.totalRuns - 1 })}>
              −
            </Button>
            <span className="num w-10 text-center text-lg font-semibold text-fg">{value.totalRuns}</span>
            <Button size="sm" variant="secondary" aria-label="More payments" disabled={value.totalRuns >= 12} onClick={() => onChange({ ...value, totalRuns: value.totalRuns + 1 })}>
              +
            </Button>
          </div>
        </Field>
      ) : null}
    </div>
  );
}

export function describeSchedule(s: Pick<BillScheduleDTO, "frequency" | "totalRuns" | "startAt">): string {
  if (s.frequency === "once") return `Once · ${fmtWhen(s.startAt)}`;
  return `${FREQ_LABEL[s.frequency]} · ${s.totalRuns} payments from ${fmtWhen(s.startAt)}`;
}

const STATUS: Record<ScheduleStatus, { label: string; tone: "neutral" | "up" | "warn" | "down" | "accent" }> = {
  quoted: { label: "Awaiting payment", tone: "neutral" },
  payment_pending: { label: "Confirming payment", tone: "accent" },
  active: { label: "Active", tone: "up" },
  completed: { label: "Completed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  requires_review: { label: "In review", tone: "warn" },
  refunded: { label: "Refunded", tone: "neutral" },
};

export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Review + pay for a schedule quote (all runs prepaid in one transaction). */
export function ScheduleReview({ schedule, onPaid, onExpired }: { schedule: BillScheduleDTO; onPaid: (s: BillScheduleDTO) => void; onExpired: () => void }) {
  const w = useWallet();
  const { data: status } = useStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; unknown?: boolean } | null>(null);
  const [closed, setClosed] = useState(false);
  const [left, setLeft] = useState(() => Math.max(0, new Date(schedule.quote.expiresAt).getTime() - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, new Date(schedule.quote.expiresAt).getTime() - Date.now())), 1000);
    return () => clearInterval(t);
  }, [schedule.quote.expiresAt]);
  const q = schedule.quote;
  const country = countryByCode(schedule.countryCode);
  const phone = schedule.service === "airtime" || schedule.service === "data";
  const networkMismatch = q.payCurrency === "NIM" && w.hostNetwork && status && w.hostNetwork !== status.nimiq.network;
  const balance = q.payCurrency === "NIM" ? (w.nimiq.balanceLuna !== null ? w.nimiq.balanceLuna / 1e5 : null) : w.evm.usdtBalance;
  const insufficient = balance !== null && balance < q.payAmount;

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let txHash: string;
      if (q.payCurrency === "NIM") {
        if (networkMismatch) throw new WalletActionError("failed", `Switch Nimiq Pay to ${status!.nimiq.network} to pay.`);
        txHash = await w.payNim({ recipient: schedule.payToAddress!, luna: q.payAmountAtomic, memo: schedule.memo! });
      } else {
        const r = await w.payUsdt({ to: schedule.payToAddress!, units: q.payAmountAtomic });
        if (schedule.payerAddress && r.from !== schedule.payerAddress) throw new WalletActionError("failed", "The paying wallet changed since the quote. Please start again.");
        txHash = r.hash;
      }
      const r = await api<{ schedule: BillScheduleDTO }>(`/api/schedules/${schedule.id}/payment`, { method: "POST", json: { txHash } });
      onPaid(r.schedule);
    } catch (e) {
      if (e instanceof WalletActionError && e.kind === "insufficient") {
        await api(`/api/schedules/${schedule.id}/cancel`, { method: "POST", json: { reason: "insufficient_funds" } }).catch(() => {});
        setClosed(true);
        setError({ msg: `${e.message} Nothing was charged and this schedule was closed. Top up your wallet, then start again.` });
      } else if (e instanceof WalletActionError) setError(e.kind === "rejected" ? { msg: "Payment cancelled. Nothing was charged." } : { msg: e.message, unknown: e.kind === "unknown_outcome" });
      else setError({ msg: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [q, schedule, w, onPaid, networkMismatch, status]);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-fg-3">You&apos;re prepaying {schedule.totalRuns > 1 ? `${schedule.totalRuns} payments` : "1 payment"}</p>
            <p className="num mt-1 text-[30px] font-semibold tracking-[-0.02em] text-fg">{fmtCrypto(q.payAmount, q.payCurrency)}</p>
            <p className="num text-[13px] text-fg-3">≈ {fmtUsd(q.totalUsd)}</p>
          </div>
          {schedule.environment === "sandbox" ? <TestBadge /> : null}
        </div>
        <div className="mt-4 border-t border-line pt-2">
          <KV k="When" v={describeSchedule(schedule)} />
          <KV k="To" v={`${country?.flag ?? ""} ${phone ? `+${schedule.recipient}` : schedule.recipient}`} />
          <KV k="Provider" v={schedule.operatorName} />
          {schedule.productDescription ? <KV k="Product" v={schedule.productDescription} /> : null}
          {schedule.amountLocal !== null && schedule.localCurrency ? <KV k="Each payment" v={fmtMoney(schedule.amountLocal, schedule.localCurrency)} /> : null}
          <KV k="Per payment" v={`${fmtUsd(schedule.perRunUsd)} incl. ${fmtUsd(q.serviceFeeUsd)} fee`} />
          <KV k="Total" v={fmtUsd(q.totalUsd)} strong />
        </div>
      </Card>
      <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-xs leading-relaxed text-fg-3">
        <p>
          <span className="text-fg-2">How it works.</span> Your wallet can&apos;t be charged later without you, so you prepay every payment now in one transaction. We confirm it on-chain,
          then pay {schedule.operatorName} automatically at each scheduled time. The amount each recipient gets is fixed now.
        </p>
        <p>
          <span className="text-fg-2">Cancel any time.</span> Payments that haven&apos;t run yet are refunded to the wallet you paid from. If a payment can&apos;t be delivered, it&apos;s refunded too.
        </p>
      </div>
      {error ? (
        <Notice tone={error.unknown ? "warn" : "error"} title={error.unknown ? "Payment status unknown" : undefined}>
          {error.msg}
        </Notice>
      ) : null}
      {insufficient && !closed && left > 0 ? (
        <Notice tone="warn" title={`Not enough ${q.payCurrency}`}>
          You have {fmtCrypto(balance, q.payCurrency)} but prepaying costs {fmtCrypto(q.payAmount, q.payCurrency)}. Top up, choose fewer payments, or pay with the other currency.
        </Notice>
      ) : null}
      {left <= 0 || closed ? (
        <Button size="lg" variant="secondary" onClick={onExpired}>
          {closed ? "Start again" : "Quote expired — get a new price"}
        </Button>
      ) : (
        <>
          <SlideToConfirm
            label={busy ? "Waiting for your wallet…" : `Slide to prepay ${fmtCrypto(q.payAmount, q.payCurrency)}`}
            loading={busy}
            disabled={Boolean(error?.unknown) || Boolean(networkMismatch) || insufficient}
            onConfirm={() => void confirm()}
          />
          <p className="num text-center text-xs text-fg-3">
            Price held for {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} · Ref {schedule.ref}
          </p>
        </>
      )}
    </div>
  );
}

/** Shown after paying: waits for on-chain confirmation, then confirms the schedule is active. */
export function ScheduleConfirmed({ schedule: initial, onDone }: { schedule: BillScheduleDTO; onDone: () => void }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const stopped = useRef(false);
  useEffect(() => {
    stopped.current = false;
    const tick = async () => {
      try {
        const r = await api<{ schedule: BillScheduleDTO }>(`/api/schedules/${initial.id}`);
        if (stopped.current) return;
        setS(r.schedule);
        if (r.schedule.status !== "payment_pending") return;
      } catch {}
      if (!stopped.current) setTimeout(tick, 3000);
    };
    if (initial.status === "payment_pending") void tick();
    return () => {
      stopped.current = true;
    };
  }, [initial]);

  const pending = s.status === "payment_pending";
  return (
    <Card className="p-6">
      <div className="flex flex-col items-center text-center">
        {pending ? <Spinner className="size-7 text-accent-strong" /> : s.status === "active" || s.status === "completed" ? <CheckCircle2 className="size-9 text-up" /> : <CalendarClock className="size-9 text-warn" />}
        <p className="mt-3 text-base font-medium text-fg">
          {pending ? "Confirming your payment" : s.status === "active" || s.status === "completed" ? "Bill scheduled" : "Needs attention"}
        </p>
        <p className="mt-1 text-[13px] text-fg-3">
          {pending
            ? "This usually takes a few seconds."
            : s.status === "active"
              ? s.nextRunAt
                ? `Next payment ${fmtWhen(s.nextRunAt)} · ${s.runsDone} of ${s.totalRuns} done`
                : `${s.runsDone} of ${s.totalRuns} done`
              : s.status === "completed"
                ? "All payments have run."
                : s.statusReason ?? ""}
        </p>
      </div>
      {s.runs.length ? (
        <div className="mt-5 border-t border-line pt-2">
          {s.runs.map((r) => (
            <KV key={r.run} k={`Payment ${r.run}`} v={r.status === "successful" ? "Delivered" : r.status === "requires_review" ? "In review" : "Processing"} />
          ))}
        </div>
      ) : null}
      <div className={cx("mt-5 grid gap-2", pending ? "grid-cols-1" : "grid-cols-2")}>
        <Button variant="secondary" onClick={() => router.push("/schedules")}>
          View schedules
        </Button>
        {!pending ? <Button onClick={onDone}>New payment</Button> : null}
      </div>
    </Card>
  );
}
