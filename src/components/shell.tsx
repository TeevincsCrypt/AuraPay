"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { Home, LineChart, Landmark, Zap, ListOrdered, Wallet, Settings2, ExternalLink } from "lucide-react";
import { useStatus } from "@/lib/client/hooks";
import { useWallet } from "@/lib/client/wallet";
import { fmtCrypto, shortAddress } from "@/lib/shared/format";
import { Badge, Button, cx, KV, Notice, Sheet } from "./ui";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/invest", label: "Invest", icon: LineChart },
  { href: "/borrow", label: "Borrow", icon: Landmark },
  { href: "/pay", label: "Pay", icon: Zap },
  { href: "/activity", label: "Activity", icon: ListOrdered },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export function Logo({ className }: { className?: string }) {
  // Unique gradient id: a duplicated id inside the hidden sidebar copy would blank this one.
  const gid = `aura-g-${useId().replace(/:/g, "")}`;
  return (
    <span className={cx("flex items-center gap-2", className)}>
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a197ff" />
            <stop offset="1" stopColor="#4fd1c5" />
          </linearGradient>
        </defs>
        <rect width="28" height="28" rx="8" fill="#14141c" />
        <path d="M8 20 L14 7 L20 20" fill="none" stroke={`url(#${gid})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.6 15.5 H17.4" stroke={`url(#${gid})`} strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span className="text-[17px] font-semibold tracking-[-0.02em] text-fg">AuraPay</span>
    </span>
  );
}

function ModeBadge() {
  const { data } = useStatus();
  if (!data) return null;
  const label = { development: "Dev", demo: "Demo", sandbox: "Sandbox", production: "Live" }[data.appMode];
  const tone = data.appMode === "production" ? "up" : data.appMode === "sandbox" ? "mint" : "warn";
  return (
    <Link href="/status" aria-label="Environment and integration status">
      <Badge tone={tone}>{label} mode</Badge>
    </Link>
  );
}

export function WalletButton({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const connected = w.nimiq.status === "connected";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cx(
          "flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors",
          connected ? "border-line-strong bg-surface-2 text-fg" : "border-[rgb(139_124_246/0.35)] bg-accent-soft text-accent-strong",
        )}
      >
        <Wallet className="size-4" aria-hidden />
        {w.host === "detecting" ? "…" : connected ? shortAddress(w.nimiq.addresses[0], 4, 4) : compact ? "Connect" : "Connect wallet"}
      </button>
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const { data: status } = useStatus();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"nim" | "evm" | null>(null);
  const deepLink = typeof window !== "undefined" ? `https://nimpay.app/miniapps/open/${window.location.host}` : "#";
  const networkMismatch = w.hostNetwork && status && w.hostNetwork !== status.nimiq.network;

  return (
    <Sheet open={open} onClose={onClose} title="Wallet">
      <div className="space-y-4 pb-2">
        {w.host === "browser" ? (
          <Notice tone="info" title="You're viewing AuraPay in a browser">
            Wallet features need Nimiq Pay. Open AuraPay as a Mini App to connect your wallet and pay with NIM or USDT. You can still explore — demo features are clearly labelled.
            <div className="mt-2">
              <a href={deepLink} className="inline-flex items-center gap-1 font-medium text-accent-strong">
                Open in Nimiq Pay <ExternalLink className="size-3.5" />
              </a>
            </div>
          </Notice>
        ) : null}

        <div className="rounded-xl border border-line bg-surface-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-fg">Nimiq (NIM)</span>
            {w.nimiq.status === "connected" ? <Badge tone="up">Connected</Badge> : <Badge>Not connected</Badge>}
          </div>
          {w.nimiq.status === "connected" ? (
            <div className="mt-2">
              <KV k="Address" v={<span className="font-mono text-xs">{shortAddress(w.nimiq.addresses[0], 9, 9)}</span>} />
              <KV k="Balance" v={w.nimiq.balanceLuna !== null ? fmtCrypto(w.nimiq.balanceLuna / 1e5, "NIM") : w.nimiq.balanceError ?? "—"} />
              <KV k="Network" v={w.hostNetwork ?? "unknown"} />
            </div>
          ) : (
            <Button
              className="mt-3 w-full"
              disabled={w.host !== "nimiq-pay"}
              loading={busy === "nim"}
              onClick={async () => {
                setErr(null);
                setBusy("nim");
                try {
                  await w.connectNimiq();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Connect Nimiq Pay
            </Button>
          )}
          {networkMismatch ? (
            <p className="mt-2 text-xs text-warn">
              Nimiq Pay is on {w.hostNetwork}, but AuraPay expects {status!.nimiq.network}. Switch networks in Nimiq Pay to pay with NIM.
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-line bg-surface-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-fg">USDT on Polygon</span>
            {w.evm.status === "connected" ? <Badge tone="up">Connected</Badge> : <Badge>Not connected</Badge>}
          </div>
          {w.evm.status === "connected" ? (
            <div className="mt-2">
              <KV k="Address" v={<span className="font-mono text-xs">{shortAddress(w.evm.address, 8, 6)}</span>} />
              <KV k="Balance" v={w.evm.usdtBalance !== null ? fmtCrypto(w.evm.usdtBalance, "USDT") : "Unavailable"} />
            </div>
          ) : (
            <Button
              variant="secondary"
              className="mt-3 w-full"
              disabled={!w.evm.available}
              loading={busy === "evm"}
              onClick={async () => {
                setErr(null);
                setBusy("evm");
                try {
                  await w.connectEvm();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Connect USDT wallet
            </Button>
          )}
          <p className="mt-2 text-xs text-fg-3">USDT payments need a little POL for the Polygon network fee.</p>
        </div>

        {err ? <Notice tone="error">{err}</Notice> : null}
        <p className="text-xs leading-relaxed text-fg-3">
          AuraPay never asks for your recovery phrase or private keys. Every payment is approved in your wallet&apos;s own confirmation screen.
        </p>
        {w.nimiq.status === "connected" || w.evm.status === "connected" ? (
          <Button variant="ghost" size="sm" onClick={() => w.disconnect()}>
            Disconnect
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

function ModeBanner() {
  const { data } = useStatus();
  if (!data || data.appMode === "production") return null;
  const text =
    data.appMode === "development"
      ? "Development mode — investing and borrowing are simulated; payments may be simulated. Everything simulated is labelled."
      : data.appMode === "sandbox"
      ? "Sandbox mode — top-ups use the provider's test environment and are not delivered."
      : "Demo mode — investing and borrowing are simulated; payments may be simulated. Everything simulated is labelled.";
  return (
    <div className="border-b border-[rgb(251_191_36/0.14)] bg-[rgb(251_191_36/0.06)] px-4 py-1.5 text-center text-[11.5px] text-warn">
      {text}{" "}
      <Link href="/status" className="underline underline-offset-2">
        Details
      </Link>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="min-h-dvh">
      <ModeBanner />
      <div className="mx-auto flex max-w-[1240px]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line px-4 py-6 lg:flex">
          <Link href="/" className="px-2">
            <Logo />
          </Link>
          <nav className="mt-8 space-y-1" aria-label="Primary">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cx(
                  "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                  isActive(path, href) ? "bg-surface-2 text-fg" : "text-fg-3 hover:bg-surface hover:text-fg-2",
                )}
              >
                <Icon className={cx("size-[18px]", isActive(path, href) && "text-accent-strong")} aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto space-y-3">
            <Link href="/status" className={cx("flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] text-fg-3 hover:text-fg-2", path === "/status" && "text-fg")}>
              <Settings2 className="size-4" aria-hidden /> Status & integrations
            </Link>
            <div className="px-2">
              <WalletButton />
            </div>
          </div>
        </aside>

        <div className="app-glow min-w-0 flex-1">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-bg/85 px-4 pt-[var(--safe-top)] backdrop-blur-md lg:hidden">
            <Link href="/">
              <Logo />
            </Link>
            <div className="flex items-center gap-2">
              <ModeBadge />
              <WalletButton compact />
            </div>
          </header>
          <div className="hidden h-14 items-center justify-end gap-3 px-8 lg:flex">
            <ModeBadge />
          </div>
          <main className="mx-auto w-full max-w-[920px] px-4 pt-5 pb-[calc(96px+var(--safe-bottom))] sm:px-6 lg:px-8 lg:pt-0 lg:pb-16">{children}</main>
        </div>
      </div>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[rgb(10_10_15/0.92)] pb-[var(--safe-bottom)] backdrop-blur-md lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(path, href);
            return (
              <li key={href} className="flex-1">
                <Link href={href} className={cx("flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-fg" : "text-fg-3")}>
                  <Icon className={cx("size-[21px]", active && "text-accent-strong")} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
