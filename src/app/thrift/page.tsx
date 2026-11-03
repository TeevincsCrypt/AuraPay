"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Plus, Users } from "lucide-react";
import { contributionUrl, type Circle } from "@/components/thrift";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { fmtCrypto } from "@/lib/shared/format";

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

function Invite({ c, onChanged }: { c: Circle; onChanged: () => void }) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const respond = async (accept: boolean) => {
    setBusy(accept);
    setErr(null);
    try {
      await api(`/api/circles/${c.id}/respond`, { method: "POST", json: { accept } });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-4">
      <p className="text-[15px] font-semibold text-fg">{c.name}</p>
      <p className="mt-0.5 text-[13px] text-fg-2">
        @{c.organizer} invited you: {fmtCrypto(c.contribution, c.currency)} {c.frequency === "weekly" ? "every week" : "every month"} with {c.members.length - 1} others. Each member receives the pot once.
      </p>
      {err ? <Notice tone="error" className="mt-3">{err}</Notice> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" loading={busy === false} onClick={() => respond(false)}>
          Decline
        </Button>
        <Button loading={busy === true} onClick={() => respond(true)}>
          Join circle
        </Button>
      </div>
    </Card>
  );
}

function CircleRow({ c }: { c: Circle }) {
  const a = c.myAction;
  const joined = c.members.filter((m) => m.status === "joined").length;
  return (
    <Link href={`/thrift/${c.id}`} className="block">
      <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-surface-2">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
          <Users className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-fg">{c.name}</span>
            {c.status === "forming" ? <Badge>Forming</Badge> : c.status === "completed" ? <Badge tone="up">Completed</Badge> : null}
          </span>
          <span className="block text-[12.5px] text-fg-3">
            {fmtCrypto(c.contribution, c.currency)} · {c.frequency} · {joined} members
            {c.status === "active" && c.currentRound ? ` · round ${c.currentRound}/${c.rounds.length}` : ""}
          </span>
          {a?.type === "pay" ? (
            <span className="mt-1 block text-[12.5px] font-medium text-warn">Pay @{a.to} by {fmtDate(a.dueAt)}</span>
          ) : a?.type === "receive" ? (
            <span className="mt-1 block text-[12.5px] font-medium text-up">You receive this round</span>
          ) : a?.type === "start" ? (
            <span className="mt-1 block text-[12.5px] font-medium text-accent">Waiting for members · start when ready</span>
          ) : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-fg-3" />
      </Card>
    </Link>
  );
}

export default function SavingsPage() {
  const q = useApi<{ circles: Circle[] }>("/api/circles", { pollMs: 30_000 });
  const list = q.data?.circles ?? [];
  const invites = list.filter((c) => c.myStatus === "invited" && c.status === "forming");
  const mine = list.filter((c) => !invites.includes(c));
  const toPay = mine.filter((c) => c.myAction?.type === "pay");

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader
        title="Thrift"
        subtitle="Save together as a group. Everyone contributes each round; each member takes the pot once."
        action={
          <Link href="/thrift/new" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-white">
            <Plus className="size-4" /> New
          </Link>
        }
      />
      {q.loading && !q.data ? (
        <Skeleton className="h-28 w-full" />
      ) : q.error ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !list.length ? (
        <Card className="p-2">
          <EmptyState icon={<Users className="size-5" />} title="No thrift groups yet">
            Start one with friends or family: pick an amount and how often, add their @usernames, and set the payout order. Money goes straight from member to member; AuraPay never holds the pot.
          </EmptyState>
          <div className="px-4 pb-4">
            <Link href="/thrift/new">
              <Button className="w-full">
                <Plus className="size-4" /> Start a thrift
              </Button>
            </Link>
          </div>
        </Card>
      ) : (
        <>
          {invites.length ? (
            <section className="space-y-3">
              <h2 className="text-[13px] font-medium text-fg-2">Invitations</h2>
              {invites.map((c) => (
                <Invite key={c.id} c={c} onChanged={q.refetch} />
              ))}
            </section>
          ) : null}
          {toPay.length ? (
            <Notice tone="warn" title="Contribution due">
              {toPay.map((c) => (
                <Link key={c.id} href={contributionUrl(c, c.myAction!.round!, c.myAction!.to!)} className="block underline-offset-2 hover:underline">
                  {c.name}: pay {fmtCrypto(c.contribution, c.currency)} to @{c.myAction!.to} →
                </Link>
              ))}
            </Notice>
          ) : null}
          {mine.length ? (
            <section className="space-y-3">
              <h2 className="text-[13px] font-medium text-fg-2">Your thrift groups</h2>
              {mine.map((c) => (
                <CircleRow key={c.id} c={c} />
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
