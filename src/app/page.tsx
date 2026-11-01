"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowDownLeft, AtSign, CalendarClock, Lightbulb, Plus, Send, Smartphone, Tv, ListOrdered, ArrowRight } from "lucide-react";
import { ActivityRow } from "@/components/activity-row";
import { UsernameEditor } from "@/components/transfers/username-editor";
import { Landing } from "@/components/landing";
import { Greeting } from "@/components/shell";
import { Avatar, Card, CircleAction, EmptyState, ErrorState, SectionTitle, Skeleton } from "@/components/ui";
import { useApi, useStatus } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet } from "@/lib/client/wallet";
import { countryByCode } from "@/lib/shared/countries";
import { fmtNum, fmtUsd } from "@/lib/shared/format";
import type { ActivityItem } from "@/lib/shared/types";

interface Beneficiary {
  id: string;
  kind: "phone" | "meter";
  countryCode: string;
  label: string;
  value: string;
}

export default function HomePage() {
  const session = useSession();
  if (!session.user) return <Landing />;
  return <Dashboard evm={session.user.evmAddresses[0] ?? null} username={session.user.username} />;
}

function Dashboard({ evm, username }: { evm: string | null; username: string | null }) {
  const w = useWallet();
  const { data: status } = useStatus();
  const usdtQ = useApi<{ balance: number }>(evm ? `/api/wallet/usdt-balance?address=${evm}` : null);
  const activityQ = useApi<{ items: ActivityItem[] }>("/api/activity?limit=5");
  const beneficiariesQ = useApi<{ beneficiaries: Beneficiary[] }>("/api/beneficiaries");

  const nimTestnet = w.hostNetwork === "testnet" || status?.nimiq.network === "testnet";
  const nimAmount = w.nimiq.balanceLuna !== null ? w.nimiq.balanceLuna / 1e5 : null;

  // Total = NIM (USD) + USDT (Polygon). Each part is real or shown as unavailable.
  const parts = useMemo(() => {
    const nimUsd = status?.rates.nimUsd;
    // Testnet NIM has no value: show the amount, but keep it out of the USD total.
    const nim = w.nimiq.balanceLuna !== null && nimUsd && !nimTestnet ? (w.nimiq.balanceLuna / 1e5) * nimUsd : null;
    const usdt = usdtQ.data?.balance ?? w.evm.usdtBalance ?? null;
    return { nim, usdt };
  }, [status, nimTestnet, w.nimiq.balanceLuna, w.evm.usdtBalance, usdtQ.data]);
  const known = [parts.nim, parts.usdt].filter((v): v is number => v !== null);
  const total = known.length ? known.reduce((s, v) => s + v, 0) : null;
  const loading = !status;

  return (
    <div className="space-y-7">
      <Greeting />

      {/* Balance hero */}
      <section className="hero-surface -mx-4 rounded-b-[36px] px-4 pt-6 pb-7 text-center sm:mx-0 sm:rounded-[36px]">
        {loading ? (
          <Skeleton className="mx-auto h-12 w-56" />
        ) : (
          <p className="num text-display font-semibold text-fg">{total !== null ? fmtUsd(total) : "—"}</p>
        )}
        <p className="mt-1 text-[15px] text-fg-2">Total balance</p>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[12px] text-fg-2">
          {w.host === "nimiq-pay" && nimAmount === null ? (
            <button
              onClick={() => void (w.nimiq.status === "connected" ? w.refreshBalances() : w.connectNimiq().catch(() => {}))}
              className="rounded-full bg-white/70 px-2.5 py-1 underline-offset-2 hover:underline"
            >
              NIM · {w.nimiq.status === "connecting" ? "connecting…" : w.nimiq.status === "connected" ? (w.nimiq.balanceError ? "tap to retry" : "loading…") : "tap to connect"}
            </button>
          ) : (
            <span className="rounded-full bg-white/70 px-2.5 py-1">
              NIM {nimAmount !== null ? `${fmtNum(nimAmount, 2)}${nimTestnet ? " · testnet" : parts.nim !== null ? ` · ${fmtUsd(parts.nim)}` : ""}` : "· open in Nimiq Pay"}
            </span>
          )}
          <span className="rounded-full bg-white/70 px-2.5 py-1">USDT {parts.usdt !== null ? fmtUsd(parts.usdt) : evm ? "—" : "· not linked"}</span>
        </div>
        <div className="mx-auto mt-7 grid max-w-[360px] grid-cols-4 gap-2">
          <CircleAction href="/send" icon={<Send className="size-5" />} label="Send" />
          <CircleAction href="/receive" icon={<ArrowDownLeft className="size-5" />} label="Receive" />
          <CircleAction href="/pay?service=airtime" icon={<Smartphone className="size-5" />} label="Airtime" />
          <CircleAction href="/pay?service=electricity" icon={<Lightbulb className="size-5" />} label="Power" />
        </div>
      </section>

      {!username ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <AtSign className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">Claim your @username</p>
              <p className="mt-0.5 text-[13px] text-fg-2">Friends can send you NIM and USDT with it. No long addresses.</p>
            </div>
          </div>
          <div className="mt-4">
            <UsernameEditor />
          </div>
        </Card>
      ) : null}

      {/* Quick pay */}
      <section>
        <SectionTitle action={<Link href="/pay" className="text-[13px] text-fg-3 hover:text-fg-2">See all</Link>}>Quick Pay</SectionTitle>
        <div className="scrollbar-none -mx-4 flex gap-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-1">
          {(beneficiariesQ.data?.beneficiaries ?? []).slice(0, 8).map((b) => (
            <Link key={b.id} href={`/pay?beneficiary=${b.id}`} className="flex w-16 shrink-0 flex-col items-center gap-1.5">
              <span className="relative">
                <Avatar seed={b.value} label={b.label} size={56} />
                <span className="absolute -right-0.5 -bottom-0.5 text-[15px]">{countryByCode(b.countryCode)?.flag}</span>
              </span>
              <span className="w-full truncate text-center text-[12.5px] text-fg-2">{b.label}</span>
            </Link>
          ))}
          <Link href="/pay" className="flex w-16 shrink-0 flex-col items-center gap-1.5">
            <span className="grid size-14 place-items-center rounded-full bg-surface-3 text-fg-2">
              <Plus className="size-5" />
            </span>
            <span className="text-[12.5px] text-fg-3">New</span>
          </Link>
          <Link href="/schedules" className="flex w-16 shrink-0 flex-col items-center gap-1.5">
            <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <CalendarClock className="size-5" />
            </span>
            <span className="text-[12.5px] text-fg-3">Scheduled</span>
          </Link>
        </div>
      </section>

      {/* Promo cards */}
      <section className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0">
        <Link href="/schedules" className="relative w-[78%] shrink-0 overflow-hidden rounded-[24px] bg-gradient-to-br from-[#e8f6ef] to-[#eef7fb] p-5 sm:w-auto">
          <p className="text-[15px] font-semibold text-fg">Bills on autopilot</p>
          <p className="mt-1 max-w-[70%] text-[13px] text-fg-2">Schedule airtime, data, power or TV to pay itself every week or month.</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">Schedule <ArrowRight className="size-3.5" /></span>
          <CalendarClock className="absolute -right-2 -bottom-3 size-24 text-[#bfe3d1]" strokeWidth={1.4} />
        </Link>
        <Link href="/send" className="relative w-[78%] shrink-0 overflow-hidden rounded-[24px] bg-gradient-to-br from-[#eef1ff] to-[#fbeef7] p-5 sm:w-auto">
          <p className="text-[15px] font-semibold text-fg">Send by @username</p>
          <p className="mt-1 max-w-[70%] text-[13px] text-fg-2">NIM or USDT to friends and family, wallet to wallet. Free.</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">Send <ArrowRight className="size-3.5" /></span>
          <Send className="absolute -right-2 -bottom-3 size-24 text-[#c9cdf6]" strokeWidth={1.4} />
        </Link>
        <Link href="/pay?service=cable" className="relative w-[78%] shrink-0 overflow-hidden rounded-[24px] bg-gradient-to-br from-[#fff1e6] to-[#fde6dc] p-5 sm:w-auto">
          <p className="text-[15px] font-semibold text-fg">TV & internet</p>
          <p className="mt-1 max-w-[70%] text-[13px] text-fg-2">Renew DStv, GOtv, StarTimes and internet plans in seconds.</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">Pay a bill <ArrowRight className="size-3.5" /></span>
          <Tv className="absolute -right-2 -bottom-3 size-24 text-[#f6cdb7]" strokeWidth={1.4} />
        </Link>
      </section>

      <div className="grid gap-6">
        <section>
          <SectionTitle action={<Link href="/activity" className="text-[13px] text-fg-3 hover:text-fg-2">See all</Link>}>Transactions</SectionTitle>
          <Card className="overflow-hidden">
            {activityQ.error ? (
              <ErrorState message={activityQ.error.message} onRetry={activityQ.refetch} />
            ) : !activityQ.data ? (
              <div className="space-y-3 p-5">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : activityQ.data.items.length ? (
              <div className="divide-y divide-line py-1">
                {activityQ.data.items.map((i) => (
                  <ActivityRow key={i.id} item={i} />
                ))}
              </div>
            ) : (
              <EmptyState icon={<ListOrdered className="size-5" />} title="No transactions yet">
                Your bills, transfers and refunds will appear here.
              </EmptyState>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
