"use client";

import { useMemo, useState } from "react";
import { Search, LineChart } from "lucide-react";
import { AllocationBar, colorForSymbol, RangeBar } from "@/components/charts";
import { StockLogo, StockRow } from "@/components/invest/stock-row";
import { Badge, Card, CardHeader, Change, DemoBadge, EmptyState, ErrorState, Input, Notice, PageHeader, SimulatedBadge, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { fmtNum, fmtUsd } from "@/lib/shared/format";
import type { MarketStatus, PortfolioDTO, StockQuote } from "@/lib/shared/types";
import Link from "next/link";

type Filter = "all" | "gainers" | "losers" | "semis" | "internet";

const FILTERS: { v: Filter; label: string }[] = [
  { v: "all", label: "All" },
  { v: "gainers", label: "Top gainers" },
  { v: "losers", label: "Top losers" },
  { v: "semis", label: "Chips" },
  { v: "internet", label: "Internet" },
];

export default function InvestPage() {
  const marketsQ = useApi<{ mode: "live" | "demo" | "unavailable"; market: MarketStatus; quotes: StockQuote[] }>("/api/markets/quotes", { pollMs: 60_000 });
  const portfolioQ = useApi<{ portfolio: PortfolioDTO; brokerage: { state: string; reason: string } }>("/api/portfolio");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const quotes = useMemo(() => {
    let list = marketsQ.data?.quotes ?? [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
    if (filter === "semis") list = list.filter((s) => s.sector === "Semiconductors");
    if (filter === "internet") list = list.filter((s) => /Internet|E-commerce|Media/.test(s.sector));
    if (filter === "gainers") list = [...list].filter((s) => (s.changePercent ?? 0) > 0).sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
    if (filter === "losers") list = [...list].filter((s) => (s.changePercent ?? 0) < 0).sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0));
    return list;
  }, [marketsQ.data, query, filter]);

  const p = portfolioQ.data?.portfolio;
  const market = marketsQ.data?.market;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invest"
        subtitle="US stocks, priced in dollars, funded with NIM or USDT."
        action={
          market?.isOpen !== null && market ? (
            <Badge tone={market.isOpen ? "up" : "neutral"}>{market.isOpen ? "Market open" : "Market closed"}</Badge>
          ) : undefined
        }
      />

      {portfolioQ.data ? (
        <Notice tone="warn" title="Order execution is not live">
          {portfolioQ.data.brokerage.reason} You can explore real-time market data{marketsQ.data?.mode === "demo" ? " (demo prices on this deployment)" : ""} and practise with simulated orders.
        </Notice>
      ) : null}

      {/* Portfolio */}
      <Card>
        <CardHeader title="Your portfolio" action={p?.hasSimulated ? <SimulatedBadge /> : null} />
        {portfolioQ.error ? (
          <ErrorState message={portfolioQ.error.message} onRetry={portfolioQ.refetch} />
        ) : !p ? (
          <div className="px-5 pb-5">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : p.positions.length === 0 ? (
          <EmptyState icon={<LineChart className="size-5" />} title="No positions yet">
            Pick a company below to see its price history and place a simulated order.
          </EmptyState>
        ) : (
          <div className="pb-2">
            <div className="grid grid-cols-2 gap-4 px-4 pb-4 sm:grid-cols-4 sm:px-5">
              <div>
                <p className="text-xs text-fg-3">Value</p>
                <p className="num text-lg font-semibold text-fg">{fmtUsd(p.totals.marketValueUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-fg-3">Invested</p>
                <p className="num text-lg font-semibold text-fg">{fmtUsd(p.totals.investedUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-fg-3">Today</p>
                <p className="num text-lg font-semibold">
                  <Change value={p.totals.dayChangeUsd} />
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-3">Total return</p>
                <p className="num text-lg font-semibold">
                  <Change percent={p.totals.totalPnlPercent} />
                </p>
              </div>
            </div>
            {p.totals.marketValueUsd ? (
              <div className="px-4 pb-4 sm:px-5">
                <AllocationBar
                  items={p.positions.map((pos) => ({ key: pos.symbol, label: pos.symbol, value: pos.marketValueUsd ?? 0, color: colorForSymbol(pos.symbol) }))}
                />
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="border-y border-line text-left text-xs text-fg-3">
                    <th className="px-4 py-2 font-normal sm:px-5">Asset</th>
                    <th className="px-2 py-2 text-right font-normal">Quantity</th>
                    <th className="px-2 py-2 text-right font-normal">Avg price</th>
                    <th className="px-2 py-2 text-right font-normal">Value</th>
                    <th className="px-4 py-2 text-right font-normal sm:px-5">Unrealised P/L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.positions.map((pos) => (
                    <tr key={pos.symbol} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5 sm:px-5">
                        <Link href={`/invest/${pos.symbol}`} className="flex items-center gap-2.5">
                          <StockLogo q={{ symbol: pos.symbol, logoUrl: null }} size={28} />
                          <span>
                            <span className="block font-medium text-fg">{pos.symbol}</span>
                            <span className="text-[11px] text-warn">{pos.isSimulated ? "Simulated" : pos.verified ? "Verified" : ""}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="num px-2 text-right text-fg-2">{fmtNum(pos.quantity, 6)}</td>
                      <td className="num px-2 text-right text-fg-2">{fmtUsd(pos.avgPrice)}</td>
                      <td className="num px-2 text-right text-fg">{fmtUsd(pos.marketValueUsd)}</td>
                      <td className="num px-4 text-right sm:px-5">
                        <Change value={pos.unrealizedPnlUsd} /> <span className="text-fg-3">(<Change percent={pos.unrealizedPnlPercent} />)</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* Discovery */}
      <section>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 text-[13px] font-medium text-fg-2">
            Discover {marketsQ.data?.mode === "demo" ? <DemoBadge /> : null}
          </h2>
          <div className="sm:w-64">
            <Input placeholder="Search company or ticker" value={query} onChange={(e) => setQuery(e.target.value)} lead={<Search className="size-4" />} aria-label="Search stocks" />
          </div>
        </div>
        <div className="scrollbar-none -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`h-8 shrink-0 rounded-full border px-3 text-[13px] ${filter === f.v ? "border-[rgb(139_124_246/0.5)] bg-accent-soft text-accent-strong" : "border-line text-fg-3 hover:text-fg-2"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {marketsQ.data?.mode === "unavailable" ? (
          <Notice tone="error" className="mb-3">
            Live market data isn&apos;t configured on this deployment, so prices are unavailable.
          </Notice>
        ) : null}
        <Card>
          {marketsQ.error ? (
            <ErrorState message={marketsQ.error.message} onRetry={marketsQ.refetch} />
          ) : !marketsQ.data ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : quotes.length === 0 ? (
            <EmptyState title="No matches">Try another name or ticker.</EmptyState>
          ) : (
            <div className="divide-y divide-line">
              {quotes.map((q) => (
                <StockRow
                  key={q.symbol}
                  q={q}
                  right={
                    <span className="hidden w-28 sm:block">
                      <RangeBar low={q.dayLow} high={q.dayHigh} value={q.price} />
                      <span className="mt-1 block text-center text-[10px] text-fg-3">Day range</span>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Card>
        <p className="mt-3 text-xs leading-relaxed text-fg-3">
          Investing involves risk, including the loss of capital. Prices move and past performance does not guarantee future results.
          {marketsQ.data?.mode === "live" ? " Quotes by Finnhub; may be delayed." : ""}
        </p>
      </section>
    </div>
  );
}
