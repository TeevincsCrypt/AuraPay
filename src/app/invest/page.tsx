"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, LineChart } from "lucide-react";
import { AllocationBar, colorForSymbol } from "@/components/charts";
import { StockLogo, StockRow } from "@/components/invest/stock-row";
import { Badge, Card, Change, Chips, EmptyState, ErrorState, Input, Notice, PageHeader, SectionTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { fmtNum, fmtUsd } from "@/lib/shared/format";
import { CHAIN_NAMES } from "@/lib/shared/stock-tokens";
import type { MarketStatus, PortfolioDTO, StockQuote } from "@/lib/shared/types";

type Filter = "all" | "gainers" | "losers" | "semis" | "internet";

export default function InvestPage() {
  const marketsQ = useApi<{ source: string; market: MarketStatus; quotes: StockQuote[] }>("/api/markets/quotes", { pollMs: 60_000 });
  const portfolioQ = useApi<{ portfolio: PortfolioDTO }>("/api/portfolio");
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
    <div className="space-y-7">
      <PageHeader
        title="Invest"
        subtitle="Tokenised US stocks, held in your own wallet."
        action={market && market.isOpen !== null ? <Badge tone={market.isOpen ? "up" : "neutral"}>{market.isOpen ? "Market open" : "Market closed"}</Badge> : undefined}
      />

      {/* Portfolio */}
      <section className="hero-surface -mx-4 rounded-[32px] px-5 pt-5 pb-6 sm:mx-0">
        <p className="text-[15px] text-fg-2">Portfolio value</p>
        {!p && !portfolioQ.error ? (
          <Skeleton className="mt-2 h-10 w-44" />
        ) : (
          <p className="num mt-1 text-[36px] font-semibold tracking-[-0.03em] text-fg">{p ? fmtUsd(p.totals.valueUsd) : "—"}</p>
        )}
        {p && p.holdings.length ? (
          <p className="num mt-1 text-[13px]">
            <Change value={p.totals.dayChangeUsd} /> <span className="text-fg-3">today</span>
            {p.totals.totalPnlPercent !== null ? (
              <>
                <span className="mx-1.5 text-fg-3">·</span>
                <Change percent={p.totals.totalPnlPercent} /> <span className="text-fg-3">all time</span>
              </>
            ) : null}
          </p>
        ) : null}
        {p && p.holdings.length && p.totals.valueUsd ? (
          <div className="mt-5">
            <AllocationBar items={p.holdings.map((h) => ({ key: `${h.symbol}-${h.chainId}`, label: h.symbol, value: h.valueUsd ?? 0, color: colorForSymbol(h.symbol) }))} />
          </div>
        ) : null}
      </section>

      {portfolioQ.error ? (
        <Card>
          <ErrorState message={portfolioQ.error.message} onRetry={portfolioQ.refetch} />
        </Card>
      ) : p ? (
        <section>
          <SectionTitle>Your holdings</SectionTitle>
          {p.errors.length ? <Notice tone="warn" className="mb-3">{p.errors.join(" ")}</Notice> : null}
          <Card className="overflow-hidden">
            {!p.evmAddresses.length ? (
              <EmptyState icon={<LineChart className="size-5" />} title="Link your EVM wallet">
                Verify your Nimiq Pay EVM wallet (tap your avatar on Home) to see your stock tokens.
              </EmptyState>
            ) : p.holdings.length === 0 ? (
              <EmptyState icon={<LineChart className="size-5" />} title="No stocks yet">
                Pick a company below to buy your first tokenised share — from $1.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line py-1">
                {p.holdings.map((h) => (
                  <li key={`${h.symbol}-${h.chainId}-${h.tokenAddress}`}>
                    <Link href={`/invest/${h.symbol}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2">
                      <StockLogo q={{ symbol: h.symbol, logoUrl: null }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold text-fg">{h.name}</span>
                        <span className="block text-[13px] text-fg-3">
                          {fmtNum(h.quantity, 4)} {h.tokenSymbol} · {CHAIN_NAMES[h.chainId]}
                          {h.suppliedQuantity > 0 ? ` · ${fmtNum(h.suppliedQuantity, 4)} as collateral` : ""}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-[15px] font-semibold text-fg">{fmtUsd(h.valueUsd)}</span>
                        {h.unrealizedPnlUsd !== null ? <Change value={h.unrealizedPnlUsd} className="text-[13px]" /> : <Change value={h.dayChangeUsd} className="text-[13px]" />}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      ) : null}

      {/* Discovery */}
      <section className="space-y-3">
        <SectionTitle>Discover</SectionTitle>
        <Input placeholder="Search company or ticker" value={query} onChange={(e) => setQuery(e.target.value)} lead={<Search className="size-4" />} aria-label="Search stocks" />
        <Chips<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "gainers", label: "Top gainers" },
            { value: "losers", label: "Top losers" },
            { value: "semis", label: "Chips" },
            { value: "internet", label: "Internet" },
          ]}
        />
        <Card className="overflow-hidden">
          {marketsQ.error ? (
            <ErrorState message={marketsQ.error.message} onRetry={marketsQ.refetch} />
          ) : !marketsQ.data ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : quotes.length === 0 ? (
            <EmptyState title="No matches">Try another name or ticker.</EmptyState>
          ) : (
            <div className="divide-y divide-line py-1">
              {quotes.map((q) => (
                <StockRow key={q.symbol} q={q} />
              ))}
            </div>
          )}
        </Card>
        <p className="px-1 text-xs leading-relaxed text-fg-3">
          {marketsQ.data?.source === "tokenized" ? "Prices are live market prices of the tokenised stocks (CoinGecko). " : "Quotes by Finnhub; may be delayed. "}
          Tokenised stocks are issued by third parties and may not confer shareholder rights. Investing involves risk.
        </p>
      </section>
    </div>
  );
}
