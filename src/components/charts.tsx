"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { PricePoint } from "@/lib/shared/types";
import { fmtUsd } from "@/lib/shared/format";
import { cx } from "./ui";

/**
 * Hand-built SVG charts. Single-series price chart: 2px orange line, soft area,
 * dashed crosshair with an orange value pill (hover/touch). Part-to-whole uses a
 * gapped bar plus a labelled legend so identity never relies on colour alone.
 * Categorical colours: validated light palette (white surface), fixed order per entity.
 */

export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;

const SYMBOL_SLOT: Record<string, number> = { NVDA: 0, AAPL: 1, MSFT: 2, TSLA: 3, AMZN: 4, GOOGL: 5, META: 6, AMD: 7 };
export function colorForSymbol(symbol: string): string {
  const slot = SYMBOL_SLOT[symbol];
  return slot === undefined ? "#9b958f" : SERIES[slot];
}

export function Sparkline({ points, width = 72, height = 28, positive }: { points: number[]; width?: number; height?: number; positive?: boolean | null }) {
  if (points.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`)
    .join(" ");
  const stroke = positive === null || positive === undefined ? "var(--color-fg-3)" : positive ? "var(--color-up)" : "var(--color-down)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function RangeBar({ low, high, value }: { low: number | null; high: number | null; value: number | null }) {
  if (low === null || high === null || value === null || high <= low) return <div className="h-1 w-full rounded-full bg-surface-3" />;
  const pct = Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
  return (
    <div className="relative h-1 w-full rounded-full bg-surface-3" aria-label={`Day range ${low} to ${high}`}>
      <div className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-white" style={{ left: `${pct}%` }} />
    </div>
  );
}

export function PriceChart({ points, height = 230, intraday }: { points: PricePoint[]; height?: number; intraday?: boolean }) {
  const gid = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const padTop = 30;
  const padBottom = 8;

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const vals = points.map((p) => p.c);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => padTop + (1 - (v - min) / span) * (H - padTop - padBottom);
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join(" ");
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { x, y, line, area, min, max };
  }, [points, H]);

  if (!geo) return <div style={{ height }} className="grid place-items-center text-[13px] text-fg-3">No price history available.</div>;

  const onMove = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHover(Math.round(rel * (points.length - 1)));
  };
  const idx = hover ?? points.length - 1;
  const hp = points[idx];
  const left = `${(idx / (points.length - 1)) * 100}%`;
  const fmtT = (t: string) =>
    new Date(t).toLocaleString("en-GB", intraday ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });

  return (
    <div className="relative select-none">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full touch-pan-y"
        style={{ height }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
        role="img"
        aria-label={`Price chart from ${fmtUsd(points[0].c)} to ${fmtUsd(points[points.length - 1].c)}`}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={padTop + f * (H - padTop - padBottom)} y2={padTop + f * (H - padTop - padBottom)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={geo.area} fill={`url(#${gid})`} />
        <path d={geo.line} fill="none" stroke="var(--color-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null ? (
          <line x1={geo.x(idx)} x2={geo.x(idx)} y1={14} y2={H} stroke="var(--color-fg-3)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-[3px] ring-white" style={{ left, top: geo.y(hp.c) }} />
      <div
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-[130%] rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-white shadow-md"
        style={{ left: `clamp(40px, ${left}, calc(100% - 40px))`, top: geo.y(hp.c) }}
      >
        <span className="num">{fmtUsd(hp.c)}</span>
      </div>
      {hover !== null ? (
        <div className="pointer-events-none absolute top-0 -translate-x-1/2 text-[11px] text-fg-3" style={{ left: `clamp(30px, ${left}, calc(100% - 30px))` }}>
          {fmtT(hp.t)}
        </div>
      ) : null}
      <div className="mt-2 flex justify-between text-[11px] text-fg-3">
        <span>{fmtT(points[0].t)}</span>
        <span className="num">
          Low {fmtUsd(geo.min)} · High {fmtUsd(geo.max)}
        </span>
        <span>{fmtT(points[points.length - 1].t)}</span>
      </div>
    </div>
  );
}

export function AllocationBar({ items }: { items: { key: string; label: string; value: number; color: string }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return null;
  return (
    <div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Portfolio allocation">
        {items.map((i) => (
          <div
            key={i.key}
            onMouseEnter={() => setHover(i.key)}
            onMouseLeave={() => setHover(null)}
            className={cx("h-full transition-opacity first:rounded-l-full last:rounded-r-full", hover && hover !== i.key && "opacity-40")}
            style={{ width: `${(i.value / total) * 100}%`, background: i.color, minWidth: 3 }}
            title={`${i.label}: ${((i.value / total) * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {items.map((i) => (
          <li key={i.key} className={cx("flex items-center gap-2 text-xs transition-opacity", hover && hover !== i.key && "opacity-50")} onMouseEnter={() => setHover(i.key)} onMouseLeave={() => setHover(null)}>
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: i.color }} aria-hidden />
            <span className="text-fg-2">{i.label}</span>
            <span className="num ml-auto text-fg-3">{((i.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Aave health factor: liquidation at 1.0. Status is shown with a label, never colour alone. */
export function HealthMeter({ healthFactor }: { healthFactor: number | null }) {
  const hf = healthFactor;
  const scale = 3;
  const pct = hf === null ? 100 : Math.min(100, (hf / scale) * 100);
  const state = hf === null ? "none" : hf < 1.1 ? "critical" : hf < 1.5 ? "warn" : "ok";
  const fill = state === "critical" ? "var(--color-down)" : state === "warn" ? "var(--color-warn)" : "var(--color-up)";
  return (
    <div>
      <div className="relative h-2.5 w-full rounded-full bg-surface-3">
        {hf !== null ? <div className="h-full rounded-full" style={{ width: `${pct}%`, background: fill }} /> : null}
        <div className="absolute -top-1 h-[18px] w-0.5 rounded bg-down" style={{ left: `${(1 / scale) * 100}%` }} aria-hidden />
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-fg-3">
        <span className="absolute -translate-x-1/2 text-down" style={{ left: `${(1 / scale) * 100}%` }}>
          Liquidation 1.0
        </span>
        <span className="absolute right-0">3.0+</span>
      </div>
    </div>
  );
}
