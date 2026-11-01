"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Landmark, Lightbulb, LineChart, ShieldCheck, Smartphone, Wifi, Fingerprint, BadgeCheck, Zap } from "lucide-react";
import { useApi } from "@/lib/client/hooks";
import { TARGET_COUNTRIES } from "@/lib/shared/countries";
import { fmtUsd } from "@/lib/shared/format";
import type { StockQuote } from "@/lib/shared/types";
import { SignInSheet } from "./auth/sign-in";
import { StockLogo } from "./invest/stock-row";
import { Logo } from "./shell";
import { Button, Change, Skeleton } from "./ui";

function LiveMarkets() {
  const q = useApi<{ source: string; quotes: StockQuote[] }>("/api/markets/quotes");
  const quotes = (q.data?.quotes ?? []).filter((x) => x.price !== null).slice(0, 4);
  return (
    <div className="rounded-[28px] bg-white/85 p-5 shadow-[var(--shadow-float)] ring-1 ring-black/5 backdrop-blur">
      <div className="flex items-center justify-between">
        <p className="text-[15px] font-semibold text-fg">Live US markets</p>
        <span className="flex items-center gap-1.5 text-xs text-fg-3">
          <span className="size-1.5 animate-pulse rounded-full bg-up" /> Live
        </span>
      </div>
      <div className="mt-3 divide-y divide-line">
        {!q.data && !q.error
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="my-3 h-9 w-full" />)
          : quotes.length === 0
            ? <p className="py-6 text-center text-[13px] text-fg-3">Prices are unavailable right now.</p>
            : quotes.map((s) => (
                <div key={s.symbol} className="flex items-center gap-3 py-3">
                  <StockLogo q={s} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-fg">{s.name}</span>
                    <span className="block text-xs text-fg-3">{s.symbol}</span>
                  </span>
                  <span className="text-right">
                    <span className="num block text-sm font-semibold text-fg">{fmtUsd(s.price)}</span>
                    <Change percent={s.changePercent} className="text-xs" />
                  </span>
                </div>
              ))}
      </div>
      {q.data?.source === "tokenized" ? <p className="mt-2 text-[11px] text-fg-3">Market prices of the tokenised stocks you can buy on AuraPay.</p> : null}
    </div>
  );
}

const PILLARS = [
  {
    icon: Zap,
    title: "Pay",
    text: "Airtime, mobile data and electricity across six African countries — paid with NIM or USDT in seconds.",
    chips: [
      { icon: Smartphone, label: "Airtime" },
      { icon: Wifi, label: "Data" },
      { icon: Lightbulb, label: "Electricity" },
    ],
  },
  {
    icon: LineChart,
    title: "Invest",
    text: "Own tokenised US stocks like NVIDIA, Apple and Tesla from $1. They sit in your own wallet — verifiable on-chain.",
    chips: [],
  },
  {
    icon: Landmark,
    title: "Borrow",
    text: "Unlock USDC against your stock tokens through Aave, without selling them. You stay in control of every step.",
    chips: [],
  },
];

export function Landing() {
  const [open, setOpen] = useState(false);
  return (
    <div className="landing-bg min-h-dvh">
      <header className="mx-auto flex max-w-[1120px] items-center justify-between px-5 pt-[calc(20px+var(--safe-top))]">
        <Logo />
        <Button size="sm" variant="dark" onClick={() => setOpen(true)}>
          Sign in
        </Button>
      </header>

      <section className="mx-auto grid max-w-[1120px] items-center gap-10 px-5 pt-12 pb-14 lg:grid-cols-[1.1fr_0.9fr] lg:pt-20">
        <div className="text-center lg:text-left">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1.5 text-xs font-medium text-fg-2 shadow-[var(--shadow-card)]">
            <BadgeCheck className="size-3.5 text-accent" /> A Nimiq Pay Mini App
          </span>
          <h1 className="mt-5 text-[44px] leading-[1.02] font-semibold tracking-[-0.04em] text-fg sm:text-[60px]">
            Your money.
            <br />
            <span className="text-accent">Without borders.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[30rem] text-[16px] leading-relaxed text-fg-2 lg:mx-0">
            Pay bills across Africa, invest in US stocks and borrow against them — all from your Nimiq Pay wallet.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
            <Button size="lg" className="sm:w-auto" onClick={() => setOpen(true)}>
              Sign in with Nimiq Pay <ArrowRight className="size-4" />
            </Button>
            <a href="#how" className="text-sm font-medium text-fg-2 hover:text-fg">
              How it works
            </a>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
            {TARGET_COUNTRIES.map((c) => (
              <span key={c.code} className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-xs text-fg-2">
                <span aria-hidden>{c.flag}</span> {c.name}
              </span>
            ))}
          </div>
        </div>
        <LiveMarkets />
      </section>

      <section className="mx-auto grid max-w-[1120px] gap-4 px-5 pb-14 md:grid-cols-3">
        {PILLARS.map((p) => (
          <div key={p.title} className="rounded-[28px] bg-white p-6 shadow-[var(--shadow-card)]">
            <span className="grid size-12 place-items-center rounded-2xl bg-peach text-accent">
              <p.icon className="size-5" />
            </span>
            <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.02em] text-fg">{p.title}</h2>
            <p className="mt-1.5 text-[14px] leading-relaxed text-fg-2">{p.text}</p>
            {p.chips.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {p.chips.map((c) => (
                  <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2">
                    <c.icon className="size-3.5" /> {c.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </section>

      <section id="how" className="mx-auto max-w-[1120px] px-5 pb-16">
        <div className="rounded-[32px] bg-fg p-7 text-white sm:p-10">
          <h2 className="text-[26px] font-semibold tracking-[-0.025em]">How it works</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {[
              { icon: Smartphone, t: "Open in Nimiq Pay", d: "AuraPay runs inside the Nimiq Pay app. On a computer, scan the sign-in QR code with your phone." },
              { icon: Fingerprint, t: "Sign in with a signature", d: "Your wallet signs a one-time message. No passwords, no seed phrases, and no payment is authorised." },
              { icon: ShieldCheck, t: "Approve every transaction", d: "Payments, purchases and loans are approved in your wallet and verified on-chain before anything is delivered." },
            ].map((s, i) => (
              <div key={s.t}>
                <span className="grid size-11 place-items-center rounded-full bg-white/10">
                  <s.icon className="size-5" />
                </span>
                <p className="mt-3 text-[15px] font-semibold">
                  {i + 1}. {s.t}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-white/70">{s.d}</p>
              </div>
            ))}
          </div>
          <Button size="lg" className="mt-8 sm:w-auto" onClick={() => setOpen(true)}>
            Get started <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1120px] flex-col items-center justify-between gap-3 px-5 pb-10 text-xs text-fg-3 sm:flex-row">
        <span>Tokenised stocks are issued by third parties and may not confer shareholder rights. Investing involves risk.</span>
        <Link href="/status" className="hover:text-fg-2">
          System status
        </Link>
      </footer>

      <SignInSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
