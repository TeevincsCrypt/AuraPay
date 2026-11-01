export function fmtUsd(v: number | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const f = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: opts.compact && Math.abs(v) >= 100_000 ? "compact" : "standard",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: opts.sign ? "exceptZero" : "auto",
  });
  return f.format(v);
}

export function fmtMoney(v: number | null | undefined, currency: string, maxDigits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: maxDigits,
    }).format(v);
  } catch {
    return `${fmtNum(v, maxDigits)} ${currency}`;
  }
}

export function fmtNum(v: number | null | undefined, maxDigits = 2, minDigits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxDigits, minimumFractionDigits: minDigits }).format(v);
}

export function fmtCrypto(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (currency === "NIM") return `${fmtNum(v, 2, 2)} NIM`;
  if (currency === "USDT") return `${fmtNum(v, 2, 2)} USDT`;
  return `${fmtNum(v, 4)} ${currency}`;
}

export function fmtPct(v: number | null | undefined, opts: { sign?: boolean; digits?: number } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: opts.digits ?? 2,
    maximumFractionDigits: opts.digits ?? 2,
    signDisplay: opts.sign ? "exceptZero" : "auto",
  }).format(v / 100);
}

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}

export function fmtRelative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(iso, false);
}

export function shortAddress(addr: string | null | undefined, lead = 6, tail = 4): string {
  if (!addr) return "—";
  const a = addr.replace(/\s+/g, " ");
  return a.length <= lead + tail + 1 ? a : `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

export function shortHash(h: string | null | undefined): string {
  return shortAddress(h, 8, 6);
}

/** USD price of one unit, with enough precision for sub-cent assets like NIM. */
export function fmtRate(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v < 0.01 ? v.toFixed(6) : v < 1 ? v.toFixed(4) : v.toFixed(2);
}
