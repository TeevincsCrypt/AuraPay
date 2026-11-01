"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, AtSign, CalendarClock, Globe, Lightbulb, Send, ShieldCheck, Smartphone, Tv, Wifi, Fingerprint, BadgeCheck, Zap } from "lucide-react";
import { useApi } from "@/lib/client/hooks";
import { TARGET_COUNTRIES } from "@/lib/shared/countries";
import { fmtUsd } from "@/lib/shared/format";
import { SignInSheet } from "./auth/sign-in";
import { Logo } from "./shell";
import { Button, Skeleton } from "./ui";

function LiveCard() {
  const q = useApi<{ nimUsd: number; usdtUsd: number }>("/api/rates");
  const services = [
    { icon: Smartphone, label: "Airtime" },
    { icon: Wifi, label: "Data" },
    { icon: Lightbulb, label: "Electricity" },
    { icon: Tv, label: "Cable TV" },
    { icon: Globe, label: "Internet" },
  ];
  return (
    <div className="rounded-[28px] bg-white/85 p-5 shadow-[var(--shadow-float)] ring-1 ring-black/5 backdrop-blur">
      <div className="flex items-center justify-between">
        <p className="text-[15px] font-semibold text-fg">Live rates</p>
        <span className="flex items-center gap-1.5 text-xs text-fg-3">
          <span className="size-1.5 animate-pulse rounded-full bg-up" /> Live
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          { k: "1 NIM", v: q.data ? `$${q.data.nimUsd < 0.01 ? q.data.nimUsd.toFixed(5) : q.data.nimUsd.toFixed(4)}` : null },
          { k: "1 USDT", v: q.data ? fmtUsd(q.data.usdtUsd) : null },
        ].map((r) => (
          <div key={r.k} className="rounded-2xl bg-surface-2 p-3">
            <p className="text-xs text-fg-3">{r.k}</p>
            {r.v ? <p className="num mt-0.5 text-[18px] font-semibold text-fg">{r.v}</p> : q.error ? <p className="mt-1 text-xs text-fg-3">Unavailable</p> : <Skeleton className="mt-1 h-6 w-20" />}
          </div>
        ))}
      </div>
      <p className="mt-4 text-[13px] font-medium text-fg-2">Pay these bills with NIM or USDT</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {services.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2">
            <c.icon className="size-3.5" /> {c.label}
          </span>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-2xl bg-peach/60 p-3">
        <span className="grid size-9 place-items-center rounded-full bg-white text-accent">
          <AtSign className="size-4" />
        </span>
        <p className="text-[13px] text-fg-2">Send NIM or USDT to any <span className="font-semibold text-fg">@username</span>, free and wallet to wallet.</p>
      </div>
    </div>
  );
}

const PILLARS = [
  {
    icon: Send,
    title: "Send",
    text: "Send NIM or USDT to friends and family by @username. Straight from your wallet to theirs, with no fees from us.",
  },
  {
    icon: Zap,
    title: "Pay",
    text: "Airtime, data, electricity, cable TV and internet across six African countries, paid with NIM or USDT in seconds.",
  },
  {
    icon: CalendarClock,
    title: "Schedule",
    text: "Put bills on autopilot: prepay once and AuraPay pays them at the date and time you choose, every week or month.",
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
            Pay bills across Africa and send money by @username, with NIM or USDT, all from your Nimiq Pay wallet.
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
        <LiveCard />
      </section>

      <section className="mx-auto grid max-w-[1120px] gap-4 px-5 pb-14 md:grid-cols-3">
        {PILLARS.map((p) => (
          <div key={p.title} className="rounded-[28px] bg-white p-6 shadow-[var(--shadow-card)]">
            <span className="grid size-12 place-items-center rounded-2xl bg-peach text-accent">
              <p.icon className="size-5" />
            </span>
            <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.02em] text-fg">{p.title}</h2>
            <p className="mt-1.5 text-[14px] leading-relaxed text-fg-2">{p.text}</p>
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
              { icon: ShieldCheck, t: "Approve every transaction", d: "Every payment and transfer is approved in your wallet and verified on-chain. AuraPay never holds your keys." },
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
        <span>AuraPay is non-custodial: your funds stay in your Nimiq Pay wallet until you approve a payment.</span>
        <Link href="/status" className="hover:text-fg-2">
          System status
        </Link>
      </footer>

      <SignInSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
