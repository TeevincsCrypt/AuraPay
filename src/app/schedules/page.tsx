"use client";

import Link from "next/link";
import { useState } from "react";
import { CalendarClock, Plus, Repeat } from "lucide-react";
import { describeSchedule, fmtWhen, ScheduleStatusBadge } from "@/components/pay/schedule";
import { RecurringCard, type RecurringItem } from "@/components/recurring";
import { Button, Card, EmptyState, ErrorState, KV, Notice, PageHeader, Segmented, Skeleton, TestBadge } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { countryByCode } from "@/lib/shared/countries";
import { fmtCrypto, fmtMoney, fmtUsd } from "@/lib/shared/format";
import type { BillScheduleDTO } from "@/lib/shared/types";

const SERVICE: Record<BillScheduleDTO["service"], string> = { airtime: "Airtime", data: "Mobile data", electricity: "Electricity", cable: "Cable TV", internet: "Internet" };
const RUN_LABEL: Record<string, string> = { successful: "Delivered", requires_review: "In review", refunded: "Refunded", failed: "Failed" };

function ScheduleCard({ s, onChanged }: { s: BillScheduleDTO; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const country = countryByCode(s.countryCode);
  const phone = s.service === "airtime" || s.service === "data";
  const remaining = s.totalRuns - s.runsDone;

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/schedules/${s.id}/cancel`, { method: "POST" });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-fg">
            {SERVICE[s.service]} · {s.operatorName}
          </p>
          <p className="truncate text-[13px] text-fg-3">
            {country?.flag} {s.recipientLabel ? `${s.recipientLabel} · ` : ""}
            {phone ? `+${s.recipient}` : s.recipient}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {s.environment === "sandbox" ? <TestBadge /> : null}
          <ScheduleStatusBadge status={s.status} />
        </div>
      </div>
      <div className="mt-3 border-t border-line pt-2">
        <KV k="Schedule" v={describeSchedule(s)} />
        {s.amountLocal !== null && s.localCurrency ? <KV k="Each payment" v={fmtMoney(s.amountLocal, s.localCurrency)} /> : null}
        {s.productDescription ? <KV k="Product" v={s.productDescription} /> : null}
        <KV k="Progress" v={`${s.runsDone} of ${s.totalRuns} paid`} />
        {s.status === "active" && s.nextRunAt ? <KV k="Next payment" v={fmtWhen(s.nextRunAt)} strong /> : null}
        <KV k="Prepaid" v={`${fmtCrypto(s.quote.payAmount, s.quote.payCurrency)} · ${fmtUsd(s.quote.totalUsd)}`} />
      </div>
      {s.runs.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...s.runs].reverse().map((r) => (
            <Link key={r.run} href={`/activity`} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-fg-2">
              #{r.run} {RUN_LABEL[r.status] ?? "Processing"}
            </Link>
          ))}
        </div>
      ) : null}
      {s.refundDue ? (
        <Notice tone="info" className="mt-3">
          {s.statusReason ?? "Unused payments will be refunded to the wallet you paid from."}
        </Notice>
      ) : s.status === "requires_review" && s.statusReason ? (
        <Notice tone="warn" className="mt-3">
          {s.statusReason}
        </Notice>
      ) : null}
      {err ? <Notice tone="error" className="mt-3">{err}</Notice> : null}
      {s.status === "active" || s.status === "quoted" ? (
        <div className="mt-4">
          {confirming ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy} onClick={cancel}>
                {s.status === "active" && remaining > 0 ? `Cancel & refund ${remaining}` : "Cancel"}
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
              Cancel schedule
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function RemindersTab() {
  const q = useApi<{ items: RecurringItem[] }>("/api/recurring", { pollMs: 60_000 });
  const items = q.data?.items ?? [];
  const due = items.filter((i) => i.due === "overdue" || i.due === "today" || i.due === "soon");
  const rest = items.filter((i) => !due.includes(i));
  if (q.loading && !q.data) return <Skeleton className="h-32 w-full" />;
  if (q.error) return <Card><ErrorState message={q.error.message} onRetry={q.refetch} /></Card>;
  if (!items.length) {
    return (
      <Card className="p-2">
        <EmptyState icon={<Repeat className="size-5" />} title="No reminders yet">
          After paying a bill or sending to a @username, tap <strong>Repeat this payment</strong>. We&apos;ll remind you when it&apos;s due and prefill everything, so paying takes one tap.
        </EmptyState>
      </Card>
    );
  }
  return (
    <>
      {due.length ? (
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-fg-2">Due soon</h2>
          {due.map((i) => (
            <RecurringCard key={i.id} item={i} onChanged={q.refetch} />
          ))}
        </section>
      ) : null}
      {rest.length ? (
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-fg-2">{due.length ? "Later" : "Your reminders"}</h2>
          {rest.map((i) => (
            <RecurringCard key={i.id} item={i} onChanged={q.refetch} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function AutopayTab() {
  const q = useApi<{ schedules: BillScheduleDTO[] }>("/api/schedules", { pollMs: 30_000 });
  const list = q.data?.schedules ?? [];
  const upcoming = list.filter((s) => s.status === "active" || s.status === "payment_pending" || s.status === "quoted");
  const past = list.filter((s) => !upcoming.includes(s));
  if (q.loading && !q.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (q.error) return <Card><ErrorState message={q.error.message} onRetry={q.refetch} /></Card>;
  if (!list.length) {
    return (
      <Card className="p-2">
        <EmptyState icon={<CalendarClock className="size-5" />} title="No autopay bills yet">
          In Pay, pick a bill and choose <strong>Schedule</strong>: prepay once and it pays itself, once or every week or month.
        </EmptyState>
      </Card>
    );
  }
  return (
    <>
      {upcoming.length ? (
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-fg-2">Upcoming</h2>
          {upcoming.map((s) => (
            <ScheduleCard key={s.id} s={s} onChanged={q.refetch} />
          ))}
        </section>
      ) : null}
      {past.length ? (
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-fg-2">Past</h2>
          {past.map((s) => (
            <ScheduleCard key={s.id} s={s} onChanged={q.refetch} />
          ))}
        </section>
      ) : null}
    </>
  );
}

export default function SchedulesPage() {
  const [tab, setTab] = useState<"reminders" | "autopay">("reminders");
  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader
        title="Scheduled"
        subtitle="Reminders for recurring payments, and bills that pay themselves."
        action={
          <Link href="/pay" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-white">
            <Plus className="size-4" /> New
          </Link>
        }
      />
      <Segmented<"reminders" | "autopay">
        className="w-full"
        value={tab}
        onChange={setTab}
        options={[
          { value: "reminders", label: "Reminders" },
          { value: "autopay", label: "Autopay" },
        ]}
      />
      {tab === "reminders" ? <RemindersTab /> : <AutopayTab />}
    </div>
  );
}
