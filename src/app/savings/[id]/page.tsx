"use client";

import Link from "next/link";
import { use, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock, Crown, Users } from "lucide-react";
import { contributionUrl, type Circle } from "@/components/savings";
import { Badge, Button, Card, cx, ErrorState, KV, Notice, PageHeader, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useMoney } from "@/lib/client/money";
import { fmtCrypto } from "@/lib/shared/format";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

export default function CirclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<{ circle: Circle }>(`/api/circles/${id}`, { pollMs: 20_000 });
  const money = useMoney();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const c = q.data?.circle;

  const act = async (name: string, path: string, json?: unknown) => {
    setBusy(name);
    setErr(null);
    try {
      await api(`/api/circles/${id}/${path}`, { method: "POST", json });
      await q.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[560px] space-y-4">
      <Link href="/savings" className="inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg-2">
        <ArrowLeft className="size-4" /> Savings
      </Link>
      {!c ? (
        q.error ? (
          <Card>
            <ErrorState message={q.error.message} onRetry={q.refetch} />
          </Card>
        ) : (
          <Skeleton className="h-48 w-full" />
        )
      ) : (
        <>
          <PageHeader
            title={c.name}
            subtitle={`${fmtCrypto(c.contribution, c.currency)} ${c.frequency === "weekly" ? "every week" : "every month"} · organised by @${c.organizer}`}
            action={c.status === "forming" ? <Badge>Forming</Badge> : c.status === "active" ? <Badge tone="up">Active</Badge> : <Badge>{c.status === "completed" ? "Completed" : "Cancelled"}</Badge>}
          />
          <Card className="p-5">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-2xl bg-surface-2 p-3">
                <p className="text-xs text-fg-3">Each payout</p>
                <p className="num mt-0.5 text-[18px] font-semibold text-fg">{fmtCrypto(c.pot, c.currency)}</p>
                {money.currency !== "USD" && money.local(money.usdOf(c.pot, c.currency)) ? <p className="num text-xs text-fg-3">≈ {money.local(money.usdOf(c.pot, c.currency))}</p> : null}
              </div>
              <div className="rounded-2xl bg-surface-2 p-3">
                <p className="text-xs text-fg-3">{c.status === "active" ? "Round" : "Members"}</p>
                <p className="num mt-0.5 text-[18px] font-semibold text-fg">
                  {c.status === "active" ? `${c.currentRound ?? c.rounds.length} / ${c.rounds.length}` : c.members.filter((m) => m.status !== "declined").length}
                </p>
              </div>
            </div>

            {c.myAction?.type === "pay" ? (
              <Link href={contributionUrl(c, c.myAction.round!, c.myAction.to!)} className="mt-4 block">
                <Button className="w-full">
                  Pay {fmtCrypto(c.contribution, c.currency)} to @{c.myAction.to} · round {c.myAction.round}
                </Button>
              </Link>
            ) : c.myAction?.type === "receive" ? (
              <Notice tone="success" className="mt-4">
                You receive round {c.myAction.round}. Members pay you directly; you&apos;ll see each contribution below.
              </Notice>
            ) : c.myAction?.type === "accept" ? (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="secondary" loading={busy === "decline"} onClick={() => act("decline", "respond", { accept: false })}>
                  Decline
                </Button>
                <Button loading={busy === "accept"} onClick={() => act("accept", "respond", { accept: true })}>
                  Join circle
                </Button>
              </div>
            ) : c.myAction?.type === "start" ? (
              <div className="mt-4 space-y-2">
                <Button className="w-full" loading={busy === "start"} disabled={c.members.some((m) => m.status === "invited")} onClick={() => act("start", "start")}>
                  Start the circle
                </Button>
                {c.members.some((m) => m.status === "invited") ? <p className="text-center text-xs text-fg-3">You can start once everyone has accepted or declined.</p> : null}
                <Button variant="ghost" className="w-full" loading={busy === "cancel"} onClick={() => act("cancel", "cancel")}>
                  Cancel circle
                </Button>
              </div>
            ) : c.myAction?.type === "wait" ? (
              <Notice tone="info" className="mt-4">Waiting for @{c.organizer} to start the circle.</Notice>
            ) : null}
            {err ? <Notice tone="error" className="mt-3">{err}</Notice> : null}
          </Card>

          {c.rounds.length ? (
            <section className="space-y-2">
              <h2 className="px-1 text-[13px] font-medium text-fg-2">Rounds</h2>
              {c.rounds.map((r) => (
                <Card key={r.round} className={cx("p-4", r.round === c.currentRound && "ring-1 ring-accent")}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[14px] font-semibold text-fg">
                      Round {r.round} → @{r.recipient}
                    </p>
                    {r.complete ? (
                      <Badge tone="up">
                        <CheckCircle2 className="size-3" /> Paid out
                      </Badge>
                    ) : (
                      <Badge tone={new Date(r.dueAt).getTime() < now ? "warn" : "neutral"}>
                        <Clock className="size-3" /> {fmtDate(r.dueAt)}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-fg-3">
                    {r.paid} of {r.expected} contributions received
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.contributions.map((x) => (
                      <span
                        key={x.username}
                        className={cx(
                          "rounded-full px-2.5 py-1 text-[11.5px] font-medium",
                          x.status === "confirmed" ? "bg-up-soft text-up" : x.status === "pending" ? "bg-accent-soft text-accent-strong" : "bg-surface-2 text-fg-3",
                        )}
                      >
                        @{x.username} {x.status === "confirmed" ? "✓" : x.status === "pending" ? "…" : ""}
                      </span>
                    ))}
                  </div>
                </Card>
              ))}
            </section>
          ) : (
            <Card className="divide-y divide-line px-4">
              <p className="flex items-center gap-2 py-3 text-[13px] font-medium text-fg-2">
                <Users className="size-4" /> Members & payout order
              </p>
              {c.members.map((m) => (
                <div key={m.username} className="flex items-center gap-3 py-2.5">
                  <span className="num w-5 text-center text-[13px] font-semibold text-fg-3">{m.position}</span>
                  <span className="flex-1 text-[14px] font-medium text-fg">
                    @{m.username}
                    {m.isMe ? <span className="text-fg-3"> (you)</span> : null}
                    {m.isOrganizer ? <Crown className="ml-1 inline size-3.5 text-warn" /> : null}
                  </span>
                  <Badge tone={m.status === "joined" ? "up" : m.status === "declined" ? "down" : "neutral"}>{m.status === "joined" ? "Joined" : m.status === "declined" ? "Declined" : "Invited"}</Badge>
                </div>
              ))}
            </Card>
          )}
          <Card className="p-4">
            <KV k="Currency" v={c.currency === "USDT" ? "USDT · Polygon" : "NIM"} />
            <KV k="First round" v={fmtDate(c.startAt)} />
            <KV k="Ref" v={c.ref} />
            <p className="mt-2 text-xs leading-relaxed text-fg-3">
              Contributions go straight from each member&apos;s wallet to that round&apos;s recipient. AuraPay checks every payment on-chain but never holds the pot, so a circle relies on members paying on time: invite people you trust.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
