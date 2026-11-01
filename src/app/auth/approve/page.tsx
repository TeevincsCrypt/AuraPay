"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Laptop, ShieldAlert } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { Button, Card, Input, Notice, Spinner } from "@/components/ui";
import { Logo } from "@/components/shell";

interface Pending {
  code: string;
  message: string;
  requesterUserAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

function Approve() {
  const params = useSearchParams();
  const router = useRouter();
  const w = useWallet();
  const session = useSession();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const lookup = async (c: string) => {
    setError(null);
    setPending(null);
    try {
      setPending(await api<Pending>(`/api/auth/remote?code=${encodeURIComponent(c)}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load this request.");
    }
  };

  useEffect(() => {
    const c = params.get("code");
    if (!c) return;
    let alive = true;
    api<Pending>(`/api/auth/remote?code=${encodeURIComponent(c)}`)
      .then((p) => alive && setPending(p))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't load this request."));
    return () => {
      alive = false;
    };
  }, [params]);

  const approve = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await w.signNimiq(pending.message);
      await api("/api/auth/remote/approve", { method: "POST", json: { code: pending.code, ...signed } });
      await session.refresh();
      setDone(true);
    } catch (e) {
      if (!(e instanceof WalletActionError && e.kind === "rejected")) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing-bg min-h-dvh px-4 pt-[calc(24px+var(--safe-top))] pb-10">
      <div className="mx-auto max-w-[440px]">
        <Logo />
        <h1 className="mt-8 text-[28px] font-semibold tracking-[-0.025em] text-fg">Approve sign-in</h1>
        <p className="mt-1 text-sm text-fg-2">Sign in to AuraPay on another device with your Nimiq Pay wallet.</p>

        <Card className="mt-6 p-5">
          {done ? (
            <div className="flex flex-col items-center py-4 text-center">
              <CheckCircle2 className="size-12 text-up" />
              <p className="mt-3 text-[17px] font-semibold text-fg">Sign-in approved</p>
              <p className="mt-1 text-sm text-fg-2">You can return to your other device. You&apos;re signed in here too.</p>
              <Button className="mt-5" onClick={() => router.push("/")}>
                Open AuraPay
              </Button>
            </div>
          ) : w.host === "browser" ? (
            <Notice tone="warn" title="Open this page in Nimiq Pay">
              Approving a sign-in needs your Nimiq Pay wallet.{" "}
              <a className="font-medium text-accent" href={`https://nimpay.app/miniapps/open/${typeof window !== "undefined" ? window.location.host : ""}/auth/approve?code=${encodeURIComponent(code)}`}>
                Open in Nimiq Pay
              </a>
            </Notice>
          ) : !pending ? (
            <div className="space-y-3">
              <Input placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono tracking-[0.12em] uppercase" aria-label="Sign-in code" />
              {error ? <Notice tone="error">{error}</Notice> : null}
              <Button size="lg" disabled={code.replace(/[^A-Z0-9]/gi, "").length !== 8} onClick={() => void lookup(code)}>
                Continue
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-[20px] bg-surface-2 p-4">
                <span className="grid size-11 place-items-center rounded-full bg-white text-fg shadow-[var(--shadow-card)]">
                  <Laptop className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-fg">{describeDevice(pending.requesterUserAgent)}</p>
                  <p className="text-xs text-fg-3">
                    Code <span className="font-mono">{pending.code}</span> · requested {new Date(pending.createdAt).toLocaleTimeString()}
                  </p>
                </div>
              </div>
              <Notice tone="warn" title="Only approve if you started this">
                Approving gives that device access to your AuraPay account. Never approve a code someone else gave you.
              </Notice>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <Button size="lg" loading={busy} onClick={approve}>
                Approve with Nimiq Pay
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-xs text-fg-3">
                <ShieldAlert className="size-3.5" /> Signing does not authorise any payment.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function ApprovePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Approve />
    </Suspense>
  );
}
