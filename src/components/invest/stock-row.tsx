"use client";

import Link from "next/link";
import type { StockQuote } from "@/lib/shared/types";
import { fmtUsd } from "@/lib/shared/format";
import { colorForSymbol } from "../charts";
import { Change } from "../ui";

export function StockLogo({ q, size = 40 }: { q: Pick<StockQuote, "symbol" | "logoUrl">; size?: number }) {
  if (q.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={q.logoUrl} alt="" width={size} height={size} className="shrink-0 rounded-full bg-white object-contain p-1" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full text-[11px] font-bold text-white"
      style={{ width: size, height: size, background: `color-mix(in oklab, ${colorForSymbol(q.symbol)} 70%, #14141c)` }}
      aria-hidden
    >
      {q.symbol.slice(0, 4)}
    </span>
  );
}

export function StockRow({ q, right }: { q: StockQuote; right?: React.ReactNode }) {
  return (
    <Link href={`/invest/${q.symbol}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 sm:px-5">
      <StockLogo q={q} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{q.name}</span>
        <span className="block text-xs text-fg-3">{q.symbol} · {q.sector}</span>
      </span>
      {right}
      <span className="flex w-24 shrink-0 flex-col items-end">
        <span className="num text-sm font-medium text-fg">{q.price !== null ? fmtUsd(q.price) : "—"}</span>
        <Change percent={q.changePercent} className="text-xs" />
      </span>
    </Link>
  );
}
