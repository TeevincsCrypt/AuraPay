"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, AtSign, Plus, X } from "lucide-react";
import type { Circle } from "@/components/savings";
import { Button, Card, Field, Input, Notice, PageHeader, Segmented } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useMoney } from "@/lib/client/money";
import { useSession } from "@/lib/client/session";
import { fmtCrypto } from "@/lib/shared/format";

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function NewCirclePage() {
  const router = useRouter();
  const session = useSession();
  const money = useMoney();
  const me = session.user?.username ?? null;
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<"NIM" | "USDT">("USDT");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [start, setStart] = useState(today());
  const [order, setOrder] = useState<string[]>(() => (me ? [me] : []));
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const u = adding.trim().replace(/^@+/, "").toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(u) || order.includes(u)) return;
    setOrder([...order, u]);
    setAdding("");
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  const amt = Number(amount);
  const others = order.length - 1;
  const usd = money.usdOf(amt > 0 ? amt : null, currency);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ circle: Circle }>("/api/circles", {
        method: "POST",
        json: { name, currency, amount: amt, frequency, startAt: new Date(`${start}T09:00:00`).toISOString(), members: order },
      });
      router.push(`/savings/${r.circle.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (!me) {
    return (
      <div className="mx-auto max-w-[560px]">
        <PageHeader title="New circle" />
        <Notice tone="info">Choose your @username first (on Home or Receive). Members find each other by username.</Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader title="New savings circle" subtitle="Everyone contributes each period; one member takes the pot each round, in the order you set." />
      <Field label="Name" htmlFor="name">
        <Input id="name" placeholder="e.g. Family ajo" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Currency">
        <Segmented<"NIM" | "USDT">
          className="w-full"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: "USDT", label: "USDT · Polygon" },
            { value: "NIM", label: "NIM" },
          ]}
        />
      </Field>
      <Field label="Contribution per member, per period" htmlFor="amount" hint={usd !== null && money.local(usd) ? `≈ ${money.local(usd)}` : undefined}>
        <Input id="amount" inputMode="decimal" placeholder="0" trail={currency} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
      </Field>
      <Field label="How often">
        <Segmented<"weekly" | "monthly">
          className="w-full"
          value={frequency}
          onChange={setFrequency}
          options={[
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ]}
        />
      </Field>
      <Field label="First round due" htmlFor="start">
        <Input id="start" type="date" min={today()} value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>

      <Field label="Members & payout order" hint="Round 1 pays the first person, round 2 the second, and so on. Use the arrows to reorder.">
        <Card className="divide-y divide-line">
          {order.map((u, i) => (
            <div key={u} className="flex items-center gap-2 px-3 py-2.5">
              <span className="num w-6 text-center text-[13px] font-semibold text-fg-3">{i + 1}</span>
              <span className="flex-1 truncate text-[14px] font-medium text-fg">
                @{u}
                {u === me ? <span className="text-fg-3"> (you)</span> : null}
              </span>
              <button aria-label={`Move @${u} up`} className="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-surface-2 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" />
              </button>
              <button aria-label={`Move @${u} down`} className="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-surface-2 disabled:opacity-30" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" />
              </button>
              {u !== me ? (
                <button aria-label={`Remove @${u}`} className="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-surface-2" onClick={() => setOrder(order.filter((x) => x !== u))}>
                  <X className="size-4" />
                </button>
              ) : (
                <span className="size-8" />
              )}
            </div>
          ))}
        </Card>
        <div className="mt-2 flex gap-2">
          <Input
            aria-label="Add member"
            lead={<AtSign className="size-4" />}
            placeholder="username"
            autoCapitalize="none"
            value={adding}
            onChange={(e) => setAdding(e.target.value.replace(/\s/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button className="shrink-0" variant="secondary" onClick={add}>
            <Plus className="size-4" /> Add
          </Button>
        </div>
      </Field>

      {amt > 0 && others > 0 ? (
        <Notice tone="info">
          {order.length} members × {fmtCrypto(amt, currency)}: each member receives <strong>{fmtCrypto(amt * others, currency)}</strong> once, over {order.length} {frequency === "weekly" ? "weeks" : "months"}. Contributions go straight to that round&apos;s recipient.
        </Notice>
      ) : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      <Button size="lg" disabled={name.trim().length < 2 || !(amt > 0) || order.length < 2} loading={busy} onClick={create}>
        Create & invite
      </Button>
    </div>
  );
}
