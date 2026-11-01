"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Landmark } from "lucide-react";
import { LtvMeter } from "@/components/charts";
import { StockLogo } from "@/components/invest/stock-row";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, KV, Notice, PageHeader, Segmented, Sheet, SimulatedBadge, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { fmtDate, fmtNum, fmtPct, fmtUsd } from "@/lib/shared/format";
import type { LoanDTO } from "@/lib/shared/types";

interface Overview {
  status: { state: "connected" | "simulator" | "unavailable"; reason: string };
  params: { maxLtv: number; liquidationLtv: number; apr: number; terms: number[] };
  collateral: {
    symbol: string;
    name: string;
    quantity: number;
    lockedQuantity: number;
    availableQuantity: number;
    price: number | null;
    availableValue: number | null;
    advanceRate: number;
    borrowCapacity: number | null;
  }[];
  loans: LoanDTO[];
  totals: {
    eligibleCollateralUsd: number;
    lockedCollateralUsd: number;
    outstandingUsdt: number;
    availableToBorrowUsdt: number;
    currentLtv: number | null;
    health: number | null;
  };
}

const usdt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${fmtNum(v, 2, 2)} USDT`);

function healthLabel(h: number | null): { label: string; tone: "up" | "warn" | "down" | "neutral" } {
  if (h === null) return { label: "No debt", tone: "neutral" };
  if (h >= 1.5) return { label: "Healthy", tone: "up" };
  if (h >= 1.1) return { label: "Watch", tone: "warn" };
  return { label: "At risk", tone: "down" };
}

export default function BorrowPage() {
  const q = useApi<Overview>("/api/borrow");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState("");
  const [term, setTerm] = useState(90);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [repay, setRepay] = useState<LoanDTO | null>(null);

  const d = q.data;
  const chosen = useMemo(() => (d?.collateral ?? []).filter((c) => selected[c.symbol] && c.availableQuantity > 0), [d, selected]);
  const collateralValue = chosen.reduce((s, c) => s + (c.availableValue ?? 0), 0);
  const capacity = chosen.reduce((s, c) => s + (c.borrowCapacity ?? 0), 0);
  const value = Number(amount);
  const ltv = collateralValue > 0 && value > 0 ? value / collateralValue : null;
  const interest = value > 0 && d ? value * d.params.apr * (term / 365) : 0;
  const liquidationValue = d && value > 0 ? value / d.params.liquidationLtv : null;
  const valid = d && value >= 10 && value <= capacity + 1e-6 && chosen.length > 0;

  const open = async () => {
    if (!d) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/borrow/loans", {
        method: "POST",
        json: { amountUsdt: value, termDays: term, collateral: chosen.map((c) => ({ symbol: c.symbol, quantity: c.availableQuantity })), simulated: true },
      });
      setConfirmOpen(false);
      setAmount("");
      setSelected({});
      await q.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const h = healthLabel(d?.totals.health ?? null);

  return (
    <div className="space-y-6">
      <PageHeader title="Borrow" subtitle="Get USDT against your investments — without selling them." action={d?.status.state === "simulator" ? <SimulatedBadge /> : undefined} />

      {d ? (
        <Notice tone={d.status.state === "unavailable" ? "error" : "warn"} title={d.status.state === "simulator" ? "Lending simulator" : "Lending unavailable"}>
          {d.status.reason}
        </Notice>
      ) : null}

      {q.error ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !d ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {/* Dashboard */}
          <Card>
            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              {[
                ["Eligible collateral", fmtUsd(d.totals.eligibleCollateralUsd)],
                ["Outstanding loans", usdt(d.totals.outstandingUsdt)],
                ["Available to borrow", usdt(d.totals.availableToBorrowUsdt)],
                ["Max loan-to-value", fmtPct(d.params.maxLtv * 100, { digits: 0 })],
              ].map(([k, v]) => (
                <div key={k} className="bg-surface px-4 py-3.5 sm:px-5">
                  <p className="text-xs text-fg-3">{k}</p>
                  <p className="num mt-0.5 text-[15px] font-semibold text-fg">{v}</p>
                </div>
              ))}
            </div>
            <div className="px-4 py-4 sm:px-5">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-fg-3">
                  Loan health {d.totals.currentLtv !== null ? `· LTV ${fmtPct(d.totals.currentLtv * 100, { digits: 1 })}` : ""}
                </span>
                <Badge tone={h.tone}>{h.label}</Badge>
              </div>
              <LtvMeter ltv={d.totals.currentLtv} maxLtv={d.params.maxLtv} liquidationLtv={d.params.liquidationLtv} />
            </div>
          </Card>

          {/* Collateral & calculator */}
          {d.status.state === "simulator" ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader title="Use your investments as collateral" subtitle="Only simulated demo positions can be used in the simulator." />
                {d.collateral.length === 0 ? (
                  <EmptyState icon={<Landmark className="size-5" />} title="No eligible investments" action={<Link href="/invest"><Button size="sm" variant="secondary">Go to Invest</Button></Link>}>
                    Place a simulated stock order first, then come back to borrow against it.
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-line pb-1">
                    {d.collateral.map((c) => (
                      <li key={c.symbol}>
                        <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                          <input
                            type="checkbox"
                            disabled={c.availableQuantity <= 0 || c.price === null}
                            checked={Boolean(selected[c.symbol])}
                            onChange={(e) => setSelected((s) => ({ ...s, [c.symbol]: e.target.checked }))}
                            className="size-4 accent-[var(--color-accent)]"
                          />
                          <StockLogo q={{ symbol: c.symbol, logoUrl: null }} size={32} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-fg">{c.symbol}</span>
                            <span className="block text-xs text-fg-3">
                              {fmtNum(c.availableQuantity, 6)} available{c.lockedQuantity > 0 ? ` · ${fmtNum(c.lockedQuantity, 6)} locked` : ""}
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="num block text-sm text-fg">{fmtUsd(c.availableValue)}</span>
                            <span className="num block text-xs text-fg-3">
                              {fmtPct(c.advanceRate * 100, { digits: 0 })} → {usdt(c.borrowCapacity)}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="p-4 sm:p-5">
                <h2 className="text-[13px] font-medium text-fg-2">Loan calculator</h2>
                <div className="mt-3 space-y-4">
                  <Field label="Borrow amount" htmlFor="loan-amt" hint={chosen.length ? `Up to ${usdt(capacity)} with the selected collateral` : "Select collateral first"}>
                    <Input id="loan-amt" inputMode="decimal" placeholder="0" trail="USDT" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} disabled={!chosen.length} />
                  </Field>
                  <Field label="Duration">
                    <Segmented className="w-full" value={String(term)} onChange={(v) => setTerm(Number(v))} options={d.params.terms.map((t) => ({ value: String(t), label: `${t} days` }))} />
                  </Field>
                  <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-1">
                    <KV k="Collateral value" v={fmtUsd(collateralValue)} />
                    <KV k="Loan-to-value" v={ltv !== null ? fmtPct(ltv * 100, { digits: 1 }) : "—"} />
                    <KV k="Interest rate" v={`${fmtPct(d.params.apr * 100, { digits: 1 })} APR (fixed, simple)`} />
                    <KV k={`Interest over ${term} days`} v={usdt(interest)} />
                    <KV k="Estimated repayment" v={usdt(value > 0 ? value + interest : null)} strong />
                    <KV k="Liquidation if collateral falls below" v={fmtUsd(liquidationValue)} />
                  </div>
                  {value > capacity + 1e-6 && chosen.length ? <Notice tone="error">That&apos;s more than this collateral supports.</Notice> : null}
                  <Button size="lg" disabled={!valid} onClick={() => setConfirmOpen(true)}>
                    Review loan
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {/* Loans */}
          <Card>
            <CardHeader title="Your loans" />
            {d.loans.length === 0 ? (
              <EmptyState title="No loans yet">Loans you open will appear here with their health and repayment progress.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {d.loans.map((l) => {
                  const lh = healthLabel(l.status === "active" ? l.health : null);
                  const progress = l.totalOwed > 0 ? Math.min(1, l.repaidUsdt / l.totalOwed) : 0;
                  return (
                    <li key={l.id} className="px-4 py-4 sm:px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-fg">{usdt(l.principalUsdt)}</span>
                            {l.isSimulated ? <SimulatedBadge /> : null}
                            <Badge tone={l.status === "active" ? "accent" : "neutral"}>{l.status}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-fg-3">
                            {l.ref} · {l.termDays} days · {fmtPct(l.apr * 100, { digits: 1 })} APR · due {fmtDate(l.dueAt, false)}
                          </p>
                        </div>
                        {l.status === "active" ? (
                          <Button size="sm" variant="secondary" onClick={() => setRepay(l)}>
                            Repay
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-6 sm:grid-cols-4">
                        <KV k="Interest accrued" v={usdt(l.accruedInterest)} />
                        <KV k="Outstanding" v={usdt(l.outstanding)} />
                        <KV k="Collateral" v={fmtUsd(l.collateralValue)} />
                        <KV k="Health" v={<Badge tone={lh.tone}>{lh.label}</Badge>} />
                      </div>
                      <div className="mt-2">
                        <div className="h-1.5 w-full rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-mint" style={{ width: `${progress * 100}%` }} />
                        </div>
                        <p className="num mt-1 text-[11px] text-fg-3">
                          {fmtPct(progress * 100, { digits: 0 })} repaid · collateral {l.collateral.map((c) => `${fmtNum(c.quantity, 4)} ${c.symbol}`).join(", ")}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="space-y-1.5 text-xs leading-relaxed text-fg-3">
            <p>
              <span className="text-fg-2">How collateral works.</span> Your investments stay yours but are locked while the loan is open. Each asset counts for a share of its value (its advance rate) — more volatile stocks count for less.
            </p>
            <p>
              <span className="text-fg-2">Liquidation risk.</span> If your collateral&apos;s value falls until your loan reaches {fmtPct(d.params.liquidationLtv * 100, { digits: 0 })} of it, collateral can be sold to repay the loan.
            </p>
            <p>
              <span className="text-fg-2">Interest.</span> Simple interest accrues daily at the stated APR on the amount borrowed.
            </p>
          </div>
        </>
      )}

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm loan"
        footer={
          <Button size="lg" loading={busy} onClick={open}>
            Open simulated loan
          </Button>
        }
      >
        {d ? (
          <div className="space-y-4">
            <Notice tone="warn" title="Simulation">
              No USDT will be sent to your wallet and no collateral is actually locked on-chain. This shows how an asset-backed loan would work.
            </Notice>
            <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-1">
              <KV k="You borrow" v={usdt(value)} strong />
              <KV k="Duration" v={`${term} days`} />
              <KV k="Interest" v={`${usdt(interest)} (${fmtPct(d.params.apr * 100, { digits: 1 })} APR)`} />
              <KV k="Repay by end of term" v={usdt(value + interest)} />
              <KV k="Collateral locked" v={chosen.map((c) => `${fmtNum(c.availableQuantity, 4)} ${c.symbol}`).join(", ")} />
              <KV k="Loan-to-value" v={ltv !== null ? fmtPct(ltv * 100, { digits: 1 }) : "—"} />
              <KV k="Liquidation threshold" v={fmtPct(d.params.liquidationLtv * 100, { digits: 0 })} />
            </div>
            {err ? <Notice tone="error">{err}</Notice> : null}
          </div>
        ) : null}
      </Sheet>

      <RepaySheet loan={repay} onClose={() => setRepay(null)} onDone={q.refetch} />
    </div>
  );
}

function RepaySheet({ loan, onClose, onDone }: { loan: LoanDTO | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!loan) return null;
  const v = Number(amount);
  return (
    <Sheet
      open={Boolean(loan)}
      onClose={onClose}
      title="Repay loan"
      footer={
        <Button
          size="lg"
          loading={busy}
          disabled={!(v > 0)}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api(`/api/borrow/loans/${loan.id}/repay`, { method: "POST", json: { amountUsdt: v, simulated: true } });
              setAmount("");
              onClose();
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirm simulated repayment
        </Button>
      }
    >
      <div className="space-y-4">
        <KV k="Outstanding" v={usdt(loan.outstanding)} strong />
        <Field label="Repayment amount">
          <Input inputMode="decimal" trail="USDT" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        </Field>
        <Button variant="secondary" size="sm" onClick={() => setAmount((Math.ceil(loan.outstanding * 100) / 100).toFixed(2))}>
          Repay in full
        </Button>
        <Notice tone="warn">Simulated — no USDT leaves your wallet.</Notice>
        {err ? <Notice tone="error">{err}</Notice> : null}
      </div>
    </Sheet>
  );
}
