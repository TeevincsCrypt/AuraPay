"use client";

import { useState } from "react";
import Link from "next/link";
import { BellRing, CalendarPlus, Pause, Play, Repeat, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { fmtMoney } from "@/lib/shared/format";
import { Badge, Button, Card, Field, Input, Notice, Segmented, Sheet } from "./ui";

export type Frequency = "once" | "weekly" | "monthly";

export interface RecurringItem {
  id: string;
  kind: "bill" | "transfer";
  title: string;
  payload: Record<string, unknown>;
  frequency: Frequency;
  nextDueAt: string | null;
  active: boolean;
  lastPaidAt: string | null;
  timesPaid: number;
  due: "overdue" | "today" | "soon" | "later" | null;
  payUrl: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function defaultFirstDue(f: Frequency): string {
  const d = new Date();
  if (f === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return toDateInput(d);
}

export function fmtDue(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const DUE_BADGE: Record<NonNullable<RecurringItem["due"]>, { label: string; tone: "down" | "warn" | "accent" | "neutral" }> = {
  overdue: { label: "Overdue", tone: "down" },
  today: { label: "Due today", tone: "warn" },
  soon: { label: "Due soon", tone: "accent" },
  later: { label: "Upcoming", tone: "neutral" },
};

/** "Repeat this payment": creates a reminder from a completed bill order or transfer. */
export function RepeatSheet({ open, onClose, source, label }: { open: boolean; onClose: () => void; source: { orderId: string } | { transferId: string }; label: string }) {
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [date, setDate] = useState(() => defaultFirstDue("monthly"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<RecurringItem | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Due at 09:00 local time on the chosen day.
      const due = new Date(`${date}T09:00:00`);
      const r = await api<{ item: RecurringItem }>("/api/recurring", { method: "POST", json: { ...source, frequency, firstDueAt: due.toISOString() } });
      setSaved(r.item);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Repeat this payment">
      {saved ? (
        <div className="space-y-4 pb-2">
          <Notice tone="success" title="Reminder set">
            {saved.title} is due {fmtDue(saved.nextDueAt)}
            {saved.frequency !== "once" ? `, then every ${saved.frequency === "weekly" ? "week" : "month"}` : ""}. It shows on Home when it&apos;s due, and paying takes one tap.
          </Notice>
          <a href={`/api/recurring/${saved.id}/ics`} className="block">
            <Button variant="secondary" className="w-full">
              <CalendarPlus className="size-4" /> Add to my calendar (phone alert)
            </Button>
          </a>
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-4 pb-2">
          <p className="text-[13px] text-fg-2">{label}</p>
          <Field label="Repeat">
            <Segmented<Frequency>
              className="w-full"
              value={frequency}
              onChange={(f) => {
                setFrequency(f);
                setDate(defaultFirstDue(f));
              }}
              options={[
                { value: "once", label: "Once" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
              ]}
            />
          </Field>
          <Field label={frequency === "once" ? "Remind me on" : "Next payment due"} htmlFor="due">
            <Input id="due" type="date" min={toDateInput(new Date())} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <p className="text-xs leading-relaxed text-fg-3">
            Your wallet can&apos;t be charged without you, so we remind you and prefill everything: paying takes one tap. To have a bill pay itself, use <span className="text-fg-2">Schedule</span> in Pay (prepaid autopay).
          </p>
          {err ? <Notice tone="error">{err}</Notice> : null}
          <Button className="w-full" loading={busy} disabled={!date} onClick={save}>
            <Repeat className="size-4" /> Set reminder
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function amountLabel(item: RecurringItem): string {
  const p = item.payload;
  if (item.kind === "transfer") return `${p.amount} ${p.currency}`;
  if (typeof p.amountLocal === "number" && typeof p.localCurrency === "string") return fmtMoney(p.amountLocal, p.localCurrency, 0);
  return typeof p.productDescription === "string" ? p.productDescription : "";
}

export function RecurringCard({ item, onChanged }: { item: RecurringItem; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const badge = item.due ? DUE_BADGE[item.due] : null;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14.5px] font-semibold text-fg">{item.title}</p>
          <p className="text-[12.5px] text-fg-3">
            {amountLabel(item)} · {item.frequency === "once" ? "once" : item.frequency === "weekly" ? "every week" : "every month"}
            {item.active && item.nextDueAt ? ` · next ${fmtDue(item.nextDueAt)}` : item.active ? "" : " · paused"}
          </p>
        </div>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : !item.active ? <Badge>{item.timesPaid ? "Done" : "Paused"}</Badge> : null}
      </div>
      {err ? <Notice tone="error" className="mt-3">{err}</Notice> : null}
      <div className="mt-3 flex items-center gap-2">
        {item.active ? (
          <Link href={item.payUrl}>
            <Button size="sm">
              <BellRing className="size-3.5" /> Pay now
            </Button>
          </Link>
        ) : null}
        {item.active && item.nextDueAt ? (
          <a href={`/api/recurring/${item.id}/ics`}>
            <Button size="sm" variant="secondary" aria-label="Add to calendar">
              <CalendarPlus className="size-3.5" />
            </Button>
          </a>
        ) : null}
        {item.nextDueAt || item.active ? (
          <Button size="sm" variant="secondary" loading={busy === "toggle"} onClick={() => act("toggle", () => api(`/api/recurring/${item.id}`, { method: "PATCH", json: { active: !item.active } }))}>
            {item.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} {item.active ? "Pause" : "Resume"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" aria-label="Delete reminder" loading={busy === "delete"} onClick={() => act("delete", () => api(`/api/recurring/${item.id}`, { method: "DELETE" }))}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}
