"use client";

import Link from "next/link";
import { ArrowUpRight, Landmark, LineChart, Lightbulb, Smartphone, Wifi, ListOrdered } from "lucide-react";
import { ActivityRow } from "@/components/activity-row";
import { StockRow } from "@/components/invest/stock-row";
import { WalletButton } from "@/components/shell";
import { Badge, Card, CardHeader, Change, DemoBadge, EmptyState, ErrorState, SimulatedBadge, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { useWallet } from "@/lib/client/wallet";
import { fmtCrypto, fmtUsd } from "@/lib/shared/format";
import type { ActivityItem, MarketStatus, PortfolioDTO, StockQuote } from "@/lib/shared/types";

const ACTIONS = [
  { href: "/invest", label: "Buy stocks", icon: LineChart },
  { href: "/borrow", label: "Borrow", icon: Landmark },
  { href: "/pay?service=airtime", label: "Airtime", icon: Smartphone },
  { href: "/pay?service=data", label: "Data", icon: Wifi },
  { href: "/pay?service=electricity", label: "Electricity", icon: Lightbulb },
];

export default function HomePage() {
  const w = useWallet();
  const portfolioQ = useApi<{ portfolio: PortfolioDTO }>("/api/portfolio");
  const activityQ = useApi<{ items: ActivityItem[] }>("/api/activity?limit=5");
  const marketsQ = useApi<{ mode: string; market: MarketStatus; quotes: StockQuote[] }>("/api/markets/quotes");

  const p = portfolioQ.data?.portfolio;
  const hasPositions = Boolean(p?.positions.length);

  return (
    <div className="space-y-6">
      {/* Hero: portfolio value + balances */}
      <section className="pt-1">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-fg-2">Total portfolio value</p>
          {p?.hasSimulated ? <SimulatedBadge /> : null}
        </div>
        {portfolioQ.loading && !p ? (
          <Skeleton className="mt-2 h-10 w-48" />
        ) : (
          <p className="num mt-1 text-display font-semibold text-fg">{hasPositions ? fmtUsd(p!.totals.marketValueUsd) : fmtUsd(0)}</p>
        )}
        {hasPositions ? (
          <p className="num mt-1 text-[13px]">
            <Change value={p!.totals.dayChangeUsd} className="mr-1" />
            <span className="text-fg-3">
              (<Change percent={p!.totals.dayChangePercent} />) today
            </span>
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-fg-3">No investments yet.</p>
        )}
      </section>

      {/* Balances */}
      <Card>
        <CardHeader title="Available balance" action={w.nimiq.status !== "connected" ? <WalletButton compact /> : <Badge tone="up">Nimiq Pay</Badge>} />
        <div className="grid grid-cols-2 divide-x divide-line px-0 pb-4">
          <div className="px-4 sm:px-5">
            <p className="text-xs text-fg-3">NIM</p>
            <p className="num mt-1 text-lg font-semibold text-fg">
              {w.nimiq.balanceLuna !== null ? fmtCrypto(w.nimiq.balanceLuna / 1e5, "NIM") : <span className="text-fg-3">—</span>}
            </p>
            {w.nimiq.status === "connected" && w.hostNetwork === "testnet" ? <p className="text-[11px] text-mint">Testnet</p> : null}
          </div>
          <div className="px-4 sm:px-5">
            <p className="text-xs text-fg-3">USDT · Polygon</p>
            <p className="num mt-1 text-lg font-semibold text-fg">{w.evm.usdtBalance !== null ? fmtCrypto(w.evm.usdtBalance, "USDT") : <span className="text-fg-3">—</span>}</p>
          </div>
        </div>
        {w.host === "browser" ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-fg-3 sm:px-5">Balances appear when AuraPay runs inside Nimiq Pay. Nothing here is a real balance until a wallet is connected.</p>
        ) : null}
      </Card>

      {/* Quick actions */}
      <section aria-label="Quick actions" className="grid grid-cols-5 gap-2">
        {ACTIONS.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className="group flex flex-col items-center gap-2 rounded-xl py-2 text-center">
            <span className="grid size-12 place-items-center rounded-2xl border border-line bg-surface text-fg-2 transition-colors group-hover:border-[rgb(139_124_246/0.4)] group-hover:text-accent-strong">
              <Icon className="size-5" aria-hidden />
            </span>
            <span className="text-[11.5px] leading-tight text-fg-2">{label}</span>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Portfolio summary */}
        <Card>
          <CardHeader
            title="Portfolio"
            action={
              <Link href="/invest" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
                Invest <ArrowUpRight className="size-3.5" />
              </Link>
            }
          />
          {portfolioQ.error ? (
            <ErrorState message={portfolioQ.error.message} onRetry={portfolioQ.refetch} />
          ) : !p ? (
            <div className="space-y-2 px-5 pb-5">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ) : hasPositions ? (
            <div className="grid grid-cols-2 gap-px bg-line">
              {[
                ["Total invested", fmtUsd(p.totals.investedUsd)],
                ["Current value", fmtUsd(p.totals.marketValueUsd)],
                ["Today", <Change key="d" value={p.totals.dayChangeUsd} />],
                ["Overall", <Change key="o" percent={p.totals.totalPnlPercent} />],
              ].map(([k, v], i) => (
                <div key={i} className="bg-surface px-4 py-3 sm:px-5">
                  <p className="text-xs text-fg-3">{k}</p>
                  <p className="num mt-0.5 text-[15px] font-medium text-fg">{v}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<LineChart className="size-5" />} title="Start investing">
              Get exposure to global companies like NVIDIA and Apple from $1.
            </EmptyState>
          )}
          {p?.hasSimulated ? <p className="px-4 py-2.5 text-[11.5px] text-warn sm:px-5">Simulated positions — not real shares.</p> : null}
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader
            title="Recent activity"
            action={
              <Link href="/activity" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
                See all <ArrowUpRight className="size-3.5" />
              </Link>
            }
          />
          {activityQ.error ? (
            <ErrorState message={activityQ.error.message} onRetry={activityQ.refetch} />
          ) : !activityQ.data ? (
            <div className="space-y-3 px-5 pb-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : activityQ.data.items.length ? (
            <div className="divide-y divide-line pb-1">
              {activityQ.data.items.map((i) => (
                <ActivityRow key={i.id} item={i} />
              ))}
            </div>
          ) : (
            <EmptyState icon={<ListOrdered className="size-5" />} title="No activity yet">
              Your payments, investments and loans will appear here.
            </EmptyState>
          )}
        </Card>
      </div>

      {/* Market overview */}
      <Card>
        <CardHeader
          title="US markets"
          subtitle={
            marketsQ.data?.market.isOpen === true ? "Market open" : marketsQ.data?.market.isOpen === false ? "Market closed · latest prices" : undefined
          }
          action={marketsQ.data?.mode === "demo" ? <DemoBadge /> : marketsQ.data?.mode === "unavailable" ? <Badge tone="down">Unavailable</Badge> : null}
        />
        {marketsQ.error ? (
          <ErrorState message={marketsQ.error.message} onRetry={marketsQ.refetch} />
        ) : !marketsQ.data ? (
          <div className="space-y-3 px-5 pb-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-line pb-1">
            {marketsQ.data.quotes.slice(0, 5).map((q) => (
              <StockRow key={q.symbol} q={q} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
