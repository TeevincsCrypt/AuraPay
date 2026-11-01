"use client";

import Link from "next/link";
import type { StockQuote } from "@/lib/shared/types";
import { fmtUsd } from "@/lib/shared/format";
import { colorForSymbol } from "../charts";
import { Change } from "../ui";

/**
 * Brand marks bundled in /public/logos (Simple Icons, CC0), drawn white on the brand colour.
 * Microsoft and Amazon asked Simple Icons to remove their logos, so they get a lettermark.
 * With FINNHUB_API_KEY set, Finnhub's company logos (logoUrl) are used instead.
 */
const BRANDS: Record<string, { color: string; icon?: string; mark?: string }> = {
  NVDA: { color: "#76B900", icon: "nvidia" },
  AAPL: { color: "#000000", icon: "apple" },
  MSFT: { color: "#00A4EF", mark: "MS" },
  TSLA: { color: "#CC0000", icon: "tesla" },
  AMZN: { color: "#232F3E", mark: "a" },
  GOOGL: { color: "#4285F4", icon: "google" },
  META: { color: "#0467DF", icon: "meta" },
  AMD: { color: "#000000", icon: "amd" },
  NFLX: { color: "#000000", icon: "netflix" },
  COIN: { color: "#0052FF", icon: "coinbase" },
};

export function StockLogo({ q, size = 44 }: { q: Pick<StockQuote, "symbol" | "logoUrl">; size?: number }) {
  if (q.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={q.logoUrl} alt="" width={size} height={size} className="shrink-0 rounded-full bg-white object-contain p-1 shadow-[var(--shadow-card)]" style={{ width: size, height: size }} />;
  }
  const brand = BRANDS[q.symbol];
  if (brand?.icon) {
    return (
      <span className="grid shrink-0 place-items-center rounded-full" style={{ width: size, height: size, background: brand.color }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/logos/${brand.icon}.svg`} alt="" style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: brand?.mark ? size * (brand.mark.length > 1 ? 0.34 : 0.5) : Math.max(9, size * 0.24), background: brand?.color ?? colorForSymbol(q.symbol) }}
      aria-hidden
    >
      {brand?.mark ?? q.symbol.slice(0, 4)}
    </span>
  );
}

export function StockRow({ q, right }: { q: StockQuote; right?: React.ReactNode }) {
  return (
    <Link href={`/invest/${q.symbol}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2">
      <StockLogo q={q} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-fg">{q.name}</span>
        <span className="block text-[13px] text-fg-3">{q.symbol}</span>
      </span>
      {right}
      <span className="flex w-24 shrink-0 flex-col items-end">
        <span className="num text-[15px] font-semibold text-fg">{q.price !== null ? fmtUsd(q.price) : "—"}</span>
        <Change percent={q.changePercent} className="text-[13px]" />
      </span>
    </Link>
  );
}
