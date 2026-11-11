"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Image as ImageIcon, KeyRound, LogOut, RefreshCw, Wallet } from "lucide-react";
import { Button, Card, Field, Input, Notice, PageHeader, Skeleton } from "@/components/ui";
import type { AdminStats } from "@/lib/server/admin-stats";

/**
 * Operator dashboard. Not linked from the app. Unlocks with ADMIN_API_TOKEN, kept only in this
 * browser tab (sessionStorage) and sent as a Bearer header to /api/admin/stats.
 */

const KEY = "aurapay.admin.token";
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = (n: number) => `$${fmt(n, 2)}`;
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[12.5px] font-medium text-fg-3">{label}</p>
      <p className="num mt-1 text-[28px] font-semibold tracking-[-0.02em] text-fg">{value}</p>
      {sub ? <p className="text-[12px] text-fg-3">{sub}</p> : null}
    </Card>
  );
}

/** Daily signups, last 30 days: one series, one hue, rounded tops on the baseline, hover tooltip. */
function SignupChart({ data, now }: { data: { day: string; count: number }[]; now: string }) {
  const days = useMemo(() => {
    const byDay = new Map(data.map((d) => [d.day, d.count]));
    const out: { day: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(new Date(now).getTime() - i * 86400_000);
      const k = d.toISOString().slice(0, 10);
      out.push({ day: k, count: byDay.get(k) ?? 0 });
    }
    return out;
  }, [data, now]);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...days.map((d) => d.count));
  const W = 600, H = 160, PAD = 22, bw = (W - PAD) / days.length;
  const label = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-[15px] font-semibold text-fg">New users per day</p>
        <button className="text-[12.5px] text-fg-3 underline-offset-2 hover:underline" onClick={() => setTable(!table)}>
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      <p className="text-[12.5px] text-fg-3">Last 30 days · signed in with a Nimiq wallet</p>
      {table ? (
        <div className="mt-3 max-h-64 overflow-auto text-[13px]">
          <table className="w-full">
            <tbody>
              {days.filter((d) => d.count > 0).reverse().map((d) => (
                <tr key={d.day} className="border-b border-line">
                  <td className="py-1.5 text-fg-2">{label(d.day)}</td>
                  <td className="num py-1.5 text-right text-fg">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {days.every((d) => d.count === 0) ? <p className="py-3 text-fg-3">No signups in the last 30 days.</p> : null}
        </div>
      ) : (
        <div className="relative mt-3">
          <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full" role="img" aria-label="New users per day, last 30 days">
            {[...new Set([Math.round(max / 2), max])].filter((v) => v > 0).map((v) => (
              <g key={v}>
                <line x1={PAD} x2={W} y1={H - (v / max) * (H - 10)} y2={H - (v / max) * (H - 10)} stroke="var(--color-line)" strokeWidth="1" />
                <text x={PAD - 6} y={H - (v / max) * (H - 10) + 4} textAnchor="end" fontSize="10" fill="var(--color-fg-3)">{v}</text>
              </g>
            ))}
            <line x1={PAD} x2={W} y1={H} y2={H} stroke="var(--color-line)" strokeWidth="1" />
            {days.map((d, i) => {
              const h = (d.count / max) * (H - 10);
              const x = PAD + i * bw + 1;
              const w = bw - 2; // 2px gap between bars
              const r = Math.min(4, w / 2, h);
              return (
                <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {/* hit target taller than the mark */}
                  <rect x={PAD + i * bw} y={0} width={bw} height={H} fill="transparent" />
                  {h > 0 ? (
                    <path
                      d={`M${x},${H} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                      fill="var(--color-accent)"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  ) : null}
                </g>
              );
            })}
            {[0, 14, 29].map((i) => (
              <text key={i} x={i === 0 ? PAD : i === 29 ? W : PAD + i * bw + bw / 2} y={H + 15} textAnchor={i === 0 ? "start" : i === 29 ? "end" : "middle"} fontSize="10" fill="var(--color-fg-3)">
                {label(days[i].day)}
              </text>
            ))}
          </svg>
          {hover !== null ? (
            <div
              className="pointer-events-none absolute -top-2 rounded-lg bg-fg px-2.5 py-1.5 text-[12px] text-white shadow"
              style={{ left: `${((PAD + hover * bw + bw / 2) / W) * 100}%`, transform: "translate(-50%, -100%)" }}
            >
              {label(days[hover].day)} · <span className="num font-semibold">{days[hover].count}</span> new
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setToken(sessionStorage.getItem(KEY));
      } catch {}
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const load = useCallback(async (t: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/stats", { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (r.status === 401) {
          try {
            sessionStorage.removeItem(KEY);
          } catch {}
          setToken(null);
        }
        throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      }
      setStats(j.stats);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const t = setTimeout(() => void load(token), 0);
    return () => clearTimeout(t);
  }, [token, load]);

  if (!token) {
    return (
      <div className="mx-auto max-w-[420px] space-y-5 pt-6">
        <PageHeader title="Admin" subtitle="Operator dashboard: users and activity." />
        <Card className="space-y-4 p-5">
          <Field label="Admin token" htmlFor="tok" hint="Your ADMIN_API_TOKEN from Vercel. Kept only in this browser tab.">
            <Input id="tok" type="password" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
          </Field>
          {err ? <Notice tone="error">{err}</Notice> : null}
          <Button
            className="w-full"
            disabled={!input.trim()}
            onClick={() => {
              try {
                sessionStorage.setItem(KEY, input.trim());
              } catch {}
              setToken(input.trim());
            }}
          >
            <KeyRound className="size-4" /> Unlock
          </Button>
        </Card>
      </div>
    );
  }

  const s = stats;
  return (
    <div className="mx-auto max-w-[1040px] space-y-5">
      <PageHeader
        title="Admin"
        subtitle={s ? `Updated ${new Date(s.generatedAt).toLocaleTimeString()}` : "Loading…"}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" loading={busy} onClick={() => token && void load(token)}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  sessionStorage.removeItem(KEY);
                } catch {}
                setToken(null);
                setStats(null);
              }}
            >
              <LogOut className="size-4" /> Lock
            </Button>
          </div>
        }
      />
      {err ? <Notice tone="error">{err}</Notice> : null}
      {!s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Users" value={fmt(s.users.total)} sub={`+${fmt(s.users.new7d)} this week`} />
            <Tile label="Claimed a @username" value={fmt(s.users.withUsername)} sub={`${pct(s.users.withUsername, s.users.total)} of users`} />
            <Tile label="Verified Polygon wallet" value={fmt(s.users.withPolygonWallet)} sub={`${pct(s.users.withPolygonWallet, s.users.total)} of users`} />
            <Tile label="Profile photo" value={fmt(s.users.withPhoto)} sub={`${pct(s.users.withPhoto, s.users.total)} of users`} />
            <Tile label="Active · 24 hours" value={fmt(s.users.active24h)} />
            <Tile label="Active · 7 days" value={fmt(s.users.active7d)} />
            <Tile label="Active · 30 days" value={fmt(s.users.active30d)} />
            <Tile label="Bills paid" value={fmt(s.activity.bills.count)} sub={`${usd(s.activity.bills.usd)} total`} />
          </div>

          <SignupChart data={s.signupsByDay} now={s.generatedAt} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-5">
              <p className="text-[15px] font-semibold text-fg">Bills</p>
              <div className="mt-2 space-y-1.5 text-[13.5px]">
                {s.activity.bills.byService.length ? (
                  s.activity.bills.byService.map((b) => (
                    <div key={b.service} className="flex justify-between"><span className="capitalize text-fg-2">{b.service}</span><span className="num text-fg">{fmt(b.count)}</span></div>
                  ))
                ) : (
                  <p className="text-fg-3">None yet.</p>
                )}
                {s.activity.billsByCurrency.map((b) => (
                  <div key={b.currency} className="flex justify-between text-fg-3"><span>Paid in {b.currency}</span><span className="num">{fmt(b.count)} · {usd(b.usd)}</span></div>
                ))}
                <div className="flex justify-between text-fg-3"><span>Autopay schedules</span><span className="num">{fmt(s.activity.schedules)}</span></div>
              </div>
            </Card>
            <Card className="p-5">
              <p className="text-[15px] font-semibold text-fg">Transfers</p>
              <div className="mt-2 space-y-1.5 text-[13.5px]">
                {s.activity.transfers.length ? (
                  s.activity.transfers.map((t) => (
                    <div key={t.currency} className="flex justify-between"><span className="text-fg-2">{t.currency}</span><span className="num text-fg">{fmt(t.count)} · {fmt(t.amount, t.currency === "NIM" ? 0 : 2)} {t.currency}</span></div>
                  ))
                ) : (
                  <p className="text-fg-3">None yet.</p>
                )}
                <div className="flex justify-between text-fg-3"><span>Swaps</span><span className="num">{fmt(s.activity.swaps)}</span></div>
                <div className="flex justify-between text-fg-3"><span>Earn deposits</span><span className="num">{fmt(s.activity.earnDeposits)}</span></div>
              </div>
            </Card>
            <Card className="p-5">
              <p className="text-[15px] font-semibold text-fg">Savings & Thrift</p>
              <div className="mt-2 space-y-1.5 text-[13.5px]">
                <div className="flex justify-between"><span className="text-fg-2">Active locks</span><span className="num text-fg">{fmt(s.activity.savings.active)} · {fmt(s.activity.savings.lockedUsdt, 2)} USDT</span></div>
                <div className="flex justify-between"><span className="text-fg-2">Locks released</span><span className="num text-fg">{fmt(s.activity.savings.released)}</span></div>
                {s.activity.thrifts.map((t) => (
                  <div key={t.status} className="flex justify-between text-fg-3"><span className="capitalize">Thrift · {t.status}</span><span className="num">{fmt(t.count)}</span></div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5">
              <p className="text-[15px] font-semibold text-fg">Newest users</p>
              <p className="text-[12.5px] text-fg-3">latest {s.recentUsers.length}</p>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-fg-3">
                    <th className="px-5 py-2 font-medium">User</th>
                    <th className="py-2 font-medium">Nimiq address</th>
                    <th className="py-2 font-medium">Polygon</th>
                    <th className="py-2 text-right font-medium">Bills</th>
                    <th className="py-2 text-right font-medium">Sent</th>
                    <th className="py-2 text-right font-medium">Joined</th>
                    <th className="px-5 py-2 text-right font-medium">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recentUsers.map((u, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="px-5 py-2.5 font-medium text-fg">
                        {u.username ? `@${u.username}` : <span className="text-fg-3">no username</span>}
                        {u.hasPhoto ? <ImageIcon className="ml-1.5 inline size-3.5 text-fg-3" aria-label="has photo" /> : null}
                      </td>
                      <td className="py-2.5 font-mono text-[12px] text-fg-2">{u.nimAddress}</td>
                      <td className="py-2.5">{u.polygonVerified ? <span className="inline-flex items-center gap-1 text-up"><CheckCircle2 className="size-3.5" /> Verified</span> : <span className="inline-flex items-center gap-1 text-fg-3"><Wallet className="size-3.5" /> —</span>}</td>
                      <td className="num py-2.5 text-right text-fg">{u.bills}</td>
                      <td className="num py-2.5 text-right text-fg">{u.transfers}</td>
                      <td className="py-2.5 text-right text-fg-2">{new Date(u.joinedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</td>
                      <td className="px-5 py-2.5 text-right text-fg-2">{ago(u.lastActiveAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!s.recentUsers.length ? <p className="px-5 pb-5 text-[13px] text-fg-3">No users yet.</p> : null}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
