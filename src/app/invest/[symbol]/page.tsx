"use client";

import Link from "next/link";
import { use, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { PriceChart, RangeBar } from "@/components/charts";
import { BuySheet } from "@/components/invest/buy-sheet";
import { StockLogo } from "@/components/invest/stock-row";
import { Badge, Button, Card, Change, ErrorState, KV, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { fmtNum, fmtUsd } from "@/lib/shared/format";
import { CHAIN_NAMES, ISSUER_LEGAL_URL } from "@/lib/shared/stock-tokens";
import type { MarketStatus, PortfolioDTO, PricePoint, StockQuote } from "@/lib/shared/types";

type Range = "1W" | "1M" | "3M" | "1Y";

interface Detail {
  source: "finnhub" | "tokenized";
  quote: StockQuote;
  history: { points: PricePoint[]; source: string; reason?: string };
  market: MarketStatus;
}

export default function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const [range, setRange] = useState<Range>("1M");
  const q = useApi<Detail>(`/api/markets/${encodeURIComponent(symbol)}?range=${range}`);
  const portfolioQ = useApi<{ portfolio: PortfolioDTO }>("/api/portfolio");
  const [buyOpen, setBuyOpen] = useState(false);
  const d = q.data;
  const first = d?.history.points[0]?.c;
  const last = d?.history.points.at(-1)?.c;
  const rangeChange = first && last ? ((last - first) / first) * 100 : null;
  const holdings = portfolioQ.data?.portfolio.holdings.filter((h) => h.symbol === symbol.toUpperCase()) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/invest" aria-label="Back" className="grid size-11 place-items-center rounded-full bg-surface shadow-[var(--shadow-card)]">
          <ArrowLeft className="size-5" />
        </Link>
        {d ? (
          <div className="flex min-w-0 items-center gap-3">
            <StockLogo q={d.quote} size={40} />
            <div className="min-w-0">
              <h1 className="truncate text-[19px] font-semibold text-fg">{d.quote.name}</h1>
              <p className="text-[13px] text-fg-3">
                {d.quote.symbol} · {d.quote.exchange}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {q.error && !d ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !d ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-56 w-full" />
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <p className="text-[14px] text-fg-2">{d.source === "tokenized" ? "Tokenised price" : "Share price"}</p>
            <p className="num mt-0.5 text-[34px] font-semibold tracking-[-0.03em] text-fg">{d.quote.price !== null ? fmtUsd(d.quote.price) : "—"}</p>
            <p className="num text-[13px]">
              <Change value={d.quote.change} /> <span className="text-fg-3">(<Change percent={d.quote.changePercent} />) today</span>
            </p>
            <div className="mt-4">
              {d.history.points.length ? (
                <PriceChart points={d.history.points} intraday={range === "1W"} />
              ) : (
                <div className="grid h-56 place-items-center text-[13px] text-fg-3">{d.history.reason ?? "No history available."}</div>
              )}
            </div>
            <Segmented<Range> className="mt-4 w-full" value={range} onChange={setRange} options={(["1W", "1M", "3M", "1Y"] as Range[]).map((r) => ({ value: r, label: r }))} />
            {rangeChange !== null ? (
              <p className="num mt-3 text-xs text-fg-3">
                {range} change <Change percent={rangeChange} />
                {d.history.source === "coingecko" ? " · tokenised-stock history (CoinGecko)" : d.history.source === "twelvedata" ? " · Twelve Data" : ""}
              </p>
            ) : null}
          </Card>

          {holdings.length ? (
            <Card className="p-5">
              <p className="text-[15px] font-semibold text-fg">Your position</p>
              {holdings.map((h) => (
                <div key={h.tokenAddress} className="mt-1">
                  <KV k={`${h.tokenSymbol} · ${CHAIN_NAMES[h.chainId]}`} v={`${fmtNum(h.quantity, 6)}`} />
                  <KV k="Value" v={fmtUsd(h.valueUsd)} strong />
                  {h.suppliedQuantity > 0 ? <KV k="Supplied as collateral" v={fmtNum(h.suppliedQuantity, 6)} /> : null}
                  {h.costBasisUsd !== null ? <KV k="Unrealised P/L" v={<Change value={h.unrealizedPnlUsd} />} /> : null}
                </div>
              ))}
            </Card>
          ) : null}

          <Button size="lg" onClick={() => setBuyOpen(true)} disabled={!d.quote.token}>
            Buy {d.quote.symbol}
          </Button>

          <Card className="p-5">
            <h2 className="text-[15px] font-semibold text-fg">About {d.quote.name}</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-2">{d.quote.description}</p>
            {d.quote.dayLow !== null ? (
              <div className="mt-4">
                <p className="mb-2 text-xs text-fg-3">Day range</p>
                <RangeBar low={d.quote.dayLow} high={d.quote.dayHigh} value={d.quote.price} />
                <div className="num mt-1.5 flex justify-between text-xs text-fg-3">
                  <span>{fmtUsd(d.quote.dayLow)}</span>
                  <span>{fmtUsd(d.quote.dayHigh)}</span>
                </div>
              </div>
            ) : null}
            <div className="mt-3">
              <KV k="Sector" v={d.quote.sector} />
              {d.quote.token ? (
                <>
                  <KV k="Token" v={`${d.quote.token.symbol} · ${d.quote.token.issuer}`} />
                  <KV k="Network" v={CHAIN_NAMES[d.quote.token.chainId]} />
                  <KV
                    k="Contract"
                    v={
                      <a
                        className="inline-flex items-center gap-1 font-mono text-xs text-accent"
                        href={`${d.quote.token.chainId === 8453 ? "https://basescan.org" : d.quote.token.chainId === 42161 ? "https://arbiscan.io" : "https://etherscan.io"}/token/${d.quote.token.address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.quote.token.address.slice(0, 8)}…{d.quote.token.address.slice(-6)} <ExternalLink className="size-3" />
                      </a>
                    }
                  />
                  {d.quote.tokenPriceUsd !== null && d.source === "finnhub" ? <KV k="Token price" v={fmtUsd(d.quote.tokenPriceUsd)} /> : null}
                </>
              ) : null}
            </div>
            {d.quote.token ? (
              <p className="mt-3 text-xs leading-relaxed text-fg-3">
                <Badge className="mr-1.5">{d.quote.token.issuer}</Badge>
                Tokenised stocks track the share price but are issued by third parties and may not give shareholder rights.{" "}
                <a className="text-accent" href={ISSUER_LEGAL_URL[d.quote.token.issuer]} target="_blank" rel="noreferrer">
                  Issuer terms
                </a>
              </p>
            ) : null}
          </Card>
          <BuySheet open={buyOpen} onClose={() => { setBuyOpen(false); void portfolioQ.refetch(); }} quote={d.quote} />
        </>
      )}
    </div>
  );
}
