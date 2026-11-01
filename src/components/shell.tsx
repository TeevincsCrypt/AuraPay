"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Home, Send, Zap, PiggyBank, ListOrdered, Activity, LogOut, ExternalLink, CheckCircle2, Wallet } from "lucide-react";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtCrypto, shortAddress } from "@/lib/shared/format";
import { SignInPanel } from "./auth/sign-in";
import { CurrencyPicker } from "./currency-picker";
import { UsernameEditor } from "./transfers/username-editor";
import { Avatar, Badge, Button, Card, cx, KV, Notice, Sheet, Spinner } from "./ui";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/send", label: "Send", icon: Send },
  { href: "/pay", label: "Pay", icon: Zap },
  { href: "/savings", label: "Savings", icon: PiggyBank },
  { href: "/activity", label: "Activity", icon: ListOrdered },
] as const;

const PUBLIC_PATHS = ["/auth/approve", "/status"];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export function Logo({ className, light, size = 32 }: { className?: string; light?: boolean; size?: number }) {
  return (
    <span className={cx("flex items-center gap-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/aurapay-mark-128.png"
        alt=""
        width={size}
        height={size}
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
      <span className={cx("text-[18px] font-semibold tracking-[-0.02em]", light ? "text-white" : "text-fg")}>AuraPay</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Account sheet
// ---------------------------------------------------------------------------

export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const user = session.user;

  return (
    <Sheet open={open} onClose={onClose} title="Account">
      {user ? (
        <div className="space-y-4 pb-2">
          <div className="flex items-center gap-3">
            <Avatar seed={user.address} size={52} />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-fg">{user.username ? `@${user.username}` : "Nimiq account"}</p>
              <p className="truncate font-mono text-xs text-fg-3">{user.address}</p>
            </div>
          </div>
          <div className="rounded-[20px] bg-surface-2 p-4">
            <p className="mb-2 text-sm font-semibold text-fg">Username</p>
            <UsernameEditor compact />
          </div>
          <div className="flex items-center justify-between rounded-[20px] bg-surface-2 px-4 py-3">
            <span className="text-sm font-semibold text-fg">Show amounts in</span>
            <CurrencyPicker />
          </div>
          <div className="rounded-[20px] bg-surface-2 px-4 py-1">
            <KV k="NIM balance" v={w.nimiq.balanceLuna !== null ? fmtCrypto(w.nimiq.balanceLuna / 1e5, "NIM") : w.host === "nimiq-pay" ? "—" : "Open in Nimiq Pay"} />
            <KV k="USDT · Polygon" v={w.evm.usdtBalance !== null ? fmtCrypto(w.evm.usdtBalance, "USDT") : "—"} />
          </div>

          <div className="rounded-[20px] bg-surface-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-fg">EVM wallet</p>
              {user.evmAddresses.length ? <Badge tone="up"><CheckCircle2 className="size-3" /> Verified</Badge> : <Badge>Not linked</Badge>}
            </div>
            <p className="mt-1 text-xs text-fg-3">Used to pay with USDT and to receive USDT sent to your @username. Linking proves ownership with a signature.</p>
            {user.evmAddresses.map((a) => (
              <p key={a} className="mt-2 font-mono text-xs text-fg-2">{shortAddress(a, 10, 8)}</p>
            ))}
            {!user.evmAddresses.length ? (
              <Button
                className="mt-3 w-full"
                variant="dark"
                loading={busy}
                disabled={!w.evm.available}
                onClick={async () => {
                  setErr(null);
                  setBusy(true);
                  try {
                    await w.linkEvm();
                    await session.refresh();
                  } catch (e) {
                    if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Wallet className="size-4" /> Verify EVM wallet
              </Button>
            ) : null}
            {!w.evm.available ? <p className="mt-2 text-xs text-fg-3">Open AuraPay in Nimiq Pay to link your EVM wallet.</p> : null}
          </div>
          {err ? <Notice tone="error">{err}</Notice> : null}
          <p className="text-xs leading-relaxed text-fg-3">AuraPay never asks for your recovery phrase or private keys. Every payment is approved in Nimiq Pay.</p>
          <div className="flex gap-2">
            <Link href="/status" onClick={onClose} className="flex-1">
              <Button variant="secondary" className="w-full">
                <Activity className="size-4" /> Status
              </Button>
            </Link>
            <Button
              variant="danger"
              className="flex-1"
              onClick={async () => {
                await session.signOut();
                onClose();
              }}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
        </div>
      ) : (
        <SignInPanel onDone={onClose} />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Header + navigation
// ---------------------------------------------------------------------------

export function Greeting() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const user = session.user;
  if (!user) return null;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setOpen(true)} className="flex min-w-0 items-center gap-3 text-left">
          <Avatar seed={user.address} size={44} />
          <span className="min-w-0">
            <span className="block text-[17px] font-semibold text-fg">Hello{user.username ? `, @${user.username}` : ""} 👋</span>
            <span className="block truncate font-mono text-xs text-fg-3">{user.username ? "Tap to manage your account" : shortAddress(user.address, 9, 4)}</span>
          </span>
        </button>
        <Link href="/status" aria-label="Status" className="grid size-11 place-items-center rounded-full bg-surface text-fg shadow-[var(--shadow-card)]">
          <Activity className="size-[18px]" />
        </Link>
      </div>
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function FloatingNav({ path }: { path: string }) {
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-[calc(14px+var(--safe-bottom))] z-40 flex justify-center px-4 lg:hidden">
      <ul className="flex items-center gap-1.5 rounded-full bg-[rgb(255_255_255/0.82)] p-1.5 shadow-[var(--shadow-float)] ring-1 ring-black/5 backdrop-blur-xl">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(path, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-12 items-center justify-center gap-2 rounded-full transition-all",
                  active ? "bg-accent px-5 text-white" : "w-12 bg-white text-fg shadow-[0_1px_3px_rgb(0_0_0/0.08)]",
                )}
              >
                <Icon className="size-[19px]" strokeWidth={active ? 2.2 : 1.9} />
                {active ? <span className="text-[14px] font-medium">{label}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Sidebar({ path }: { path: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col px-5 py-7 lg:flex">
      <Link href="/" className="px-2">
        <Logo />
      </Link>
      <nav className="mt-9 space-y-1.5" aria-label="Primary">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(path, href);
          return (
            <Link
              key={href}
              href={href}
              className={cx(
                "flex h-12 items-center gap-3 rounded-full px-4 text-[15px] font-medium transition-colors",
                active ? "bg-accent text-white shadow-[0_6px_16px_rgb(232_98_44/0.28)]" : "text-fg-2 hover:bg-white hover:text-fg",
              )}
            >
              <Icon className="size-[19px]" />
              {label}
            </Link>
          );
        })}
      </nav>
      {session.user ? (
        <button onClick={() => setOpen(true)} className="mt-auto flex items-center gap-3 rounded-[20px] bg-white p-3 text-left shadow-[var(--shadow-card)]">
          <Avatar seed={session.user.address} size={40} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-fg">{session.user.username ? `@${session.user.username}` : "My account"}</span>
            <span className="block truncate font-mono text-[11px] text-fg-3">{shortAddress(session.user.address, 9, 4)}</span>
          </span>
        </button>
      ) : null}
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </aside>
  );
}

function SignInGate() {
  return (
    <div className="mx-auto max-w-[440px] pt-6">
      <Card className="p-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Sign in to continue</h1>
        <p className="mt-1 mb-5 text-sm text-fg-2">Use your Nimiq Pay wallet — no passwords, no seed phrases.</p>
        <SignInPanel />
      </Card>
      <p className="mt-4 text-center text-xs text-fg-3">
        New to Nimiq Pay?{" "}
        <a className="inline-flex items-center gap-1 text-accent" href="https://nimiq.com/nimiq-pay" target="_blank" rel="noreferrer">
          Get the app <ExternalLink className="size-3" />
        </a>
      </p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const session = useSession();
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));
  const isLanding = path === "/" && !session.user;

  if (path.startsWith("/auth/")) return <>{children}</>;
  if (session.loading && !isPublic) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (isLanding) return <>{children}</>;

  const gated = !session.user && !isPublic;
  return (
    <div className="app-glow min-h-dvh">
      <div className="mx-auto flex max-w-[1240px]">
        <Sidebar path={path} />
        <div className="min-w-0 flex-1">
          <main className="mx-auto w-full max-w-[880px] px-4 pt-[calc(18px+var(--safe-top))] pb-[calc(110px+var(--safe-bottom))] sm:px-6 lg:px-8 lg:pt-10 lg:pb-16">
            {gated ? <SignInGate /> : children}
          </main>
        </div>
      </div>
      {session.user ? <FloatingNav path={path} /> : null}
    </div>
  );
}
