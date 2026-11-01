"use client";

import Link from "next/link";
import { useMemo } from "react";
import { LineChart, Lightbulb, Plus, Smartphone, Wifi, ListOrdered, Landmark, ArrowRight } from "lucide-react";
import { ActivityRow } from "@/components/activity-row";
import { StockRow } from "@/components/invest/stock-row";
import { Landing } from "@/components/landing";
import { Greeting } from "@/components/shell";
import { Avatar, Card, CardHeader, CircleAction, EmptyState, ErrorState, SectionTitle, Skeleton } from "@/components/ui";
import { useApi, useStatus } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet } from "@/lib/client/wallet";
import { countryByCode } from "@/lib/shared/countries";
import { fmtUsd } from "@/lib/shared/format";
import type { ActivityItem, MarketStatus, PortfolioDTO, StockQuote } from "@/lib/shared/types";

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
  return <Dashboard evm={session.user.evmAddresses[0] ?? null} />;
}

function Dashboard({ evm }: { evm: string | null }) {
  const w = useWallet();
  const { data: status } = useStatus();
  const portfolioQ = useApi<{ portfolio: PortfolioDTO }>("/api/portfolio");
  const usdtQ = useApi<{ balance: number }>(evm ? `/api/wallet/usdt-balance?address=${evm}` : null);
  const activityQ = useApi<{ items: ActivityItem[] }>("/api/activity?limit=5");
  const beneficiariesQ = useApi<{ beneficiaries: Beneficiary[] }>("/api/beneficiaries");
  const marketsQ = useApi<{ source: string; market: MarketStatus; quotes: StockQuote[] }>("/api/markets/quotes");

  // Total = NIM (USD) + USDT (Polygon) + stock tokens. Each part is real or shown as unavailable.
  const parts = useMemo(() => {
    const nimUsd = status?.rates.nimUsd;
    const nim = w.nimiq.balanceLuna !== null && nimUsd ? (w.nimiq.balanceLuna / 1e5) * nimUsd : null;
    const usdt = usdtQ.data?.balance ?? w.evm.usdtBalance ?? null;
    const stocks = portfolioQ.data?.portfolio.totals.valueUsd ?? null;
    return { nim, usdt, stocks };
  }, [status, w.nimiq.balanceLuna, w.evm.usdtBalance, usdtQ.data, portfolioQ.data]);
  const known = [parts.nim, parts.usdt, parts.stocks].filter((v): v is number => v !== null);
  const total = known.length ? known.reduce((s, v) => s + v, 0) : null;
  const loading = portfolioQ.loading && !portfolioQ.data;

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
          <span className="rounded-full bg-white/70 px-2.5 py-1">NIM {parts.nim !== null ? fmtUsd(parts.nim) : w.host === "nimiq-pay" ? "—" : "· open in Nimiq Pay"}</span>
          <span className="rounded-full bg-white/70 px-2.5 py-1">USDT {parts.usdt !== null ? fmtUsd(parts.usdt) : evm ? "—" : "· not linked"}</span>
          <span className="rounded-full bg-white/70 px-2.5 py-1">Stocks {parts.stocks !== null ? fmtUsd(parts.stocks) : "—"}</span>
        </div>
        <div className="mx-auto mt-7 grid max-w-[360px] grid-cols-4 gap-2">
          <CircleAction href="/pay?service=airtime" icon={<Smartphone className="size-5" />} label="Airtime" />
          <CircleAction href="/pay?service=data" icon={<Wifi className="size-5" />} label="Data" />
          <CircleAction href="/pay?service=electricity" icon={<Lightbulb className="size-5" />} label="Power" />
          <CircleAction href="/invest" icon={<LineChart className="size-5" />} label="Invest" />
        </div>
      </section>

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
        </div>
      </section>

      {/* Promo cards */}
      <section className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0">
        <Link href="/invest" className="relative w-[78%] shrink-0 overflow-hidden rounded-[24px] bg-gradient-to-br from-[#eef1ff] to-[#fbeef7] p-5 sm:w-auto">
          <p className="text-[15px] font-semibold text-fg">Invest from $1</p>
          <p className="mt-1 max-w-[70%] text-[13px] text-fg-2">Own tokenised NVIDIA, Apple and more — held in your own wallet.</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">Explore <ArrowRight className="size-3.5" /></span>
          <LineChart className="absolute -right-2 -bottom-3 size-24 text-[#c9cdf6]" strokeWidth={1.4} />
        </Link>
        <Link href="/borrow" className="relative w-[78%] shrink-0 overflow-hidden rounded-[24px] bg-gradient-to-br from-[#fff1e6] to-[#fde6dc] p-5 sm:w-auto">
          <p className="text-[15px] font-semibold text-fg">Borrow without selling</p>
          <p className="mt-1 max-w-[70%] text-[13px] text-fg-2">Unlock USDC against your stock tokens with Aave.</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">Learn more <ArrowRight className="size-3.5" /></span>
          <Landmark className="absolute -right-2 -bottom-3 size-24 text-[#f6cdb7]" strokeWidth={1.4} />
        </Link>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
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
                Your payments, investments and loans will appear here.
              </EmptyState>
            )}
          </Card>
        </section>

        <section>
          <SectionTitle action={<Link href="/invest" className="text-[13px] text-fg-3 hover:text-fg-2">See all</Link>}>US markets</SectionTitle>
          <Card className="overflow-hidden">
            {marketsQ.error ? (
              <ErrorState message={marketsQ.error.message} onRetry={marketsQ.refetch} />
            ) : !marketsQ.data ? (
              <div className="space-y-3 p-5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : (
              <div className="divide-y divide-line py-1">
                {marketsQ.data.quotes.slice(0, 5).map((q) => (
                  <StockRow key={q.symbol} q={q} />
                ))}
              </div>
            )}
          </Card>
          {marketsQ.data?.source === "tokenized" ? <p className="mt-2 px-1 text-[11.5px] text-fg-3">Prices are live market prices of the tokenised stocks.</p> : null}
        </section>
      </div>

      {portfolioQ.data && !portfolioQ.data.portfolio.evmAddresses.length ? (
        <Card>
          <CardHeader title="Link your EVM wallet" subtitle="Needed for USDT payments, stocks and borrowing. Tap your avatar above to verify it with a signature." />
          <div className="h-3" />
        </Card>
      ) : null}
    </div>
  );
}
