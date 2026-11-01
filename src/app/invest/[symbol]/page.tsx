"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { PriceChart, RangeBar } from "@/components/charts";
import { StockLogo } from "@/components/invest/stock-row";
import { Badge, Button, Card, Change, DemoBadge, ErrorState, Field, Input, KV, Notice, Segmented, Sheet, SimulatedBadge, Skeleton } from "@/components/ui";
import { api, newRequestId } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { fmtCrypto, fmtNum, fmtUsd } from "@/lib/shared/format";
import type { MarketStatus, PricePoint, StockQuote } from "@/lib/shared/types";

type Range = "1W" | "1M" | "3M" | "1Y";

interface Detail {
  mode: "live" | "demo" | "unavailable";
  quote: StockQuote;
  history: { points: PricePoint[]; source: string; reason?: string };
  market: MarketStatus;
}

export default function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const [range, setRange] = useState<Range>("1M");
  const q = useApi<Detail>(`/api/markets/${encodeURIComponent(symbol)}?range=${range}`);
  const [buyOpen, setBuyOpen] = useState(false);
  const d = q.data;
  const first = d?.history.points[0]?.c;
  const last = d?.history.points.at(-1)?.c;
  const rangeChange = first && last ? ((last - first) / first) * 100 : null;

  return (
    <div className="space-y-5 pb-20 lg:pb-0">
      <Link href="/invest" className="inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg-2">
        <ArrowLeft className="size-4" /> Invest
      </Link>

      {q.error && !d ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !d ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-56 w-full" />
        </Card>
      ) : (
        <>
          <header className="flex items-start gap-3">
            <StockLogo q={d.quote} size={48} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-fg">{d.quote.name}</h1>
                {d.mode === "demo" ? <DemoBadge /> : null}
              </div>
              <p className="text-[13px] text-fg-3">
                {d.quote.symbol} · {d.quote.exchange} · {d.quote.sector}
              </p>
            </div>
          </header>

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="num text-[32px] font-semibold tracking-[-0.02em] text-fg">{d.quote.price !== null ? fmtUsd(d.quote.price) : "—"}</p>
                <p className="num text-[13px]">
                  <Change value={d.quote.change} /> <span className="text-fg-3">(<Change percent={d.quote.changePercent} />) today</span>
                </p>
                <p className="mt-1 text-xs text-fg-3">
                  {d.market.isOpen === null ? (d.mode === "demo" ? "Illustrative demo prices — not live." : "Market status unavailable") : d.market.isOpen ? "Market open" : "Market closed · last price"}
                  {d.quote.asOf ? ` · as of ${new Date(d.quote.asOf).toLocaleString()}` : ""}
                </p>
              </div>
              <Segmented<Range> value={range} onChange={setRange} options={(["1W", "1M", "3M", "1Y"] as Range[]).map((r) => ({ value: r, label: r }))} />
            </div>
            <div className="mt-4">
              {q.loading && d.history.points.length === 0 ? (
                <Skeleton className="h-56 w-full" />
              ) : d.history.points.length ? (
                <PriceChart points={d.history.points} intraday={range === "1W"} />
              ) : (
                <div className="grid h-56 place-items-center text-[13px] text-fg-3">{d.history.reason ?? "No history available."}</div>
              )}
            </div>
            {rangeChange !== null ? (
              <p className="num mt-2 text-xs text-fg-3">
                {range} change: <Change percent={rangeChange} />
                {d.history.source === "demo" ? " · demo data" : d.history.source === "twelvedata" ? " · history by Twelve Data" : ""}
              </p>
            ) : null}
          </Card>

          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <Card className="p-4 sm:p-5">
              <h2 className="text-[13px] font-medium text-fg-2">About {d.quote.name}</h2>
              <p className="mt-2 text-sm leading-relaxed text-fg-2">{d.quote.description}</p>
              <div className="mt-4">
                <p className="mb-2 text-xs text-fg-3">Day range</p>
                <RangeBar low={d.quote.dayLow} high={d.quote.dayHigh} value={d.quote.price} />
                <div className="num mt-1.5 flex justify-between text-xs text-fg-3">
                  <span>{fmtUsd(d.quote.dayLow)}</span>
                  <span>{fmtUsd(d.quote.dayHigh)}</span>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-6">
                <KV k="Open" v={fmtUsd(d.quote.open)} />
                <KV k="Prev. close" v={fmtUsd(d.quote.previousClose)} />
                <KV k="Exchange" v={d.quote.exchange} />
                <KV k="Fractional" v="From $1" />
              </div>
            </Card>

            <Card className="hidden h-fit p-5 lg:block">
              <p className="text-sm font-medium text-fg">Buy {d.quote.symbol}</p>
              <p className="mt-1 text-xs text-fg-3">Invest any dollar amount — you get a fraction of a share.</p>
              <Button className="mt-4 w-full" onClick={() => setBuyOpen(true)} disabled={d.quote.price === null}>
                Buy {d.quote.symbol}
              </Button>
            </Card>
          </div>

          <div className="fixed inset-x-0 bottom-[calc(64px+var(--safe-bottom))] z-30 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur-md lg:hidden">
            <Button size="lg" onClick={() => setBuyOpen(true)} disabled={d.quote.price === null}>
              Buy {d.quote.symbol}
            </Button>
          </div>

          <BuySheet open={buyOpen} onClose={() => setBuyOpen(false)} quote={d.quote} onDone={q.refetch} />
        </>
      )}
    </div>
  );
}

interface Estimate {
  estimate: {
    price: number;
    priceSource: string;
    notionalUsd: number;
    feeUsd: number;
    quantity: number;
    payCurrency: "NIM" | "USDT";
    payAmount: number | null;
    exchangeRate: number | null;
    rateSource: string | null;
    ratesError?: string;
  };
  execution: { state: string; reason: string; simulatorAvailable: boolean };
}

function BuySheet({ open, onClose, quote, onDone }: { open: boolean; onClose: () => void; quote: StockQuote; onDone: () => void }) {
  const [amount, setAmount] = useState("100");
  const [currency, setCurrency] = useState<"NIM" | "USDT">("USDT");
  const [est, setEst] = useState<Estimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [stage, setStage] = useState<"form" | "review" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [doneRef, setDoneRef] = useState<string | null>(null);
  const reqId = useRef(newRequestId());
  const value = Number(amount);

  useEffect(() => {
    if (!open || !(value >= 1)) return;
    const t = setTimeout(async () => {
      try {
        setEst(await api<Estimate>("/api/invest/estimate", { method: "POST", json: { symbol: quote.symbol, notionalUsd: value, payCurrency: currency } }));
        setEstErr(null);
      } catch (e) {
        setEstErr((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [open, value, currency, quote.symbol]);

  const close = () => {
    onClose();
    setTimeout(() => {
      setStage("form");
      setErr(null);
      setAck(false);
      reqId.current = newRequestId();
    }, 200);
  };

  const e = est?.estimate;
  const simAvailable = est?.execution.simulatorAvailable;

  const place = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ref: string }>("/api/invest/orders", {
        method: "POST",
        json: { symbol: quote.symbol, notionalUsd: value, payCurrency: currency, clientRequestId: reqId.current, simulated: true },
      });
      setDoneRef(r.ref);
      setStage("done");
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={stage === "done" ? "Simulated order placed" : stage === "review" ? "Review order" : `Buy ${quote.symbol}`}
      footer={
        stage === "form" ? (
          <Button size="lg" disabled={!e || !(value >= 1) || Boolean(estErr)} onClick={() => setStage("review")}>
            Review order
          </Button>
        ) : stage === "review" ? (
          simAvailable ? (
            <Button size="lg" loading={busy} disabled={!ack} onClick={place}>
              Place simulated order
            </Button>
          ) : (
            <Button size="lg" disabled>
              Execution unavailable
            </Button>
          )
        ) : (
          <Button size="lg" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {stage === "form" ? (
        <div className="space-y-4">
          <Field label="Amount to invest" htmlFor="inv-amt">
            <Input id="inv-amt" inputMode="decimal" lead="$" value={amount} onChange={(x) => setAmount(x.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
          <div className="flex gap-2">
            {[25, 50, 100, 250].map((v) => (
              <button key={v} onClick={() => setAmount(String(v))} className="h-8 flex-1 rounded-lg border border-line bg-surface-2 text-[13px] text-fg-2 hover:border-line-strong">
                ${v}
              </button>
            ))}
          </div>
          <Field label="Pay with">
            <Segmented
              className="w-full"
              value={currency}
              onChange={setCurrency}
              options={[
                { value: "USDT", label: "USDT" },
                { value: "NIM", label: "NIM" },
              ]}
            />
          </Field>
          {estErr ? <Notice tone="error">{estErr}</Notice> : null}
          {e ? (
            <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-1">
              <KV k={`${quote.symbol} price`} v={fmtUsd(e.price)} />
              <KV k="Estimated fee (0.5%)" v={fmtUsd(e.feeUsd)} />
              <KV k="Estimated shares" v={fmtNum(e.quantity, 6)} strong />
              <KV
                k={`You'd pay`}
                v={e.payAmount !== null ? fmtCrypto(e.payAmount, e.payCurrency) : <span className="text-down">Rate unavailable</span>}
              />
              {e.exchangeRate ? <KV k="Rate" v={`1 ${e.payCurrency} = $${e.exchangeRate < 0.01 ? e.exchangeRate.toFixed(6) : e.exchangeRate.toFixed(4)}`} /> : null}
            </div>
          ) : (
            <Skeleton className="h-32 w-full" />
          )}
          <p className="text-xs text-fg-3">Fractional shares: you can invest any amount from $1 when the brokerage supports fractions.</p>
        </div>
      ) : stage === "review" && e ? (
        <div className="space-y-4">
          <Notice tone="warn" title="This will be a simulated order">
            {est!.execution.reason} No NIM or USDT will be charged and you will not own {quote.name} shares. The order is recorded as SIMULATED in your portfolio.
          </Notice>
          <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-1">
            <KV k="Stock" v={`${quote.name} (${quote.symbol})`} />
            <KV k="Amount" v={fmtUsd(e.notionalUsd)} strong />
            <KV k="Price used" v={`${fmtUsd(e.price)}${e.priceSource === "demo" ? " (demo)" : ""}`} />
            <KV k="Estimated shares" v={fmtNum(e.quantity, 6)} />
            <KV k="Real-money equivalent" v={e.payAmount !== null ? fmtCrypto(e.payAmount, e.payCurrency) : "—"} />
          </div>
          <div className="space-y-1.5 text-xs leading-relaxed text-fg-3">
            <p>
              <span className="text-fg-2">Risk.</span> Stock prices can fall as well as rise and you could get back less than you invest. Currency movements between NIM/USDT and USD also affect returns.
            </p>
          </div>
          <label className="flex items-start gap-2.5 text-[13px] text-fg-2">
            <input type="checkbox" checked={ack} onChange={(x) => setAck(x.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />I understand this is a simulation and no real shares are bought.
          </label>
          {err ? <Notice tone="error">{err}</Notice> : null}
        </div>
      ) : (
        <div className="flex flex-col items-center py-4 text-center">
          <CheckCircle2 className="size-10 text-up" />
          <p className="mt-3 text-sm text-fg">
            Simulated purchase of {fmtUsd(value)} of {quote.symbol} recorded.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <SimulatedBadge />
            <Badge>Ref {doneRef}</Badge>
          </div>
        </div>
      )}
    </Sheet>
  );
}
