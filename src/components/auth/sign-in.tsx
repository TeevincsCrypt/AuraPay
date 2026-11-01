"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, ShieldCheck, Smartphone } from "lucide-react";
import { useSession, type RemoteRequest } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { Button, Notice, Sheet, Spinner } from "../ui";

/** Sign in with Nimiq Pay — one tap inside the app, QR/code approval anywhere else. */
export function SignInPanel({ onDone }: { onDone?: () => void }) {
  const w = useWallet();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (w.host === "detecting") {
    return (
      <div className="grid place-items-center py-10">
        <Spinner />
      </div>
    );
  }

  if (w.host === "nimiq-pay") {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-[20px] bg-surface-2 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" />
          <p className="text-[13px] leading-relaxed text-fg-2">
            Nimiq Pay will ask you to sign a short sign-in message. It proves you own your wallet and <strong className="text-fg">does not authorise any payment</strong>.
          </p>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button
          size="lg"
          loading={busy}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              await session.signInHere();
              onDone?.();
            } catch (e) {
              if (!(e instanceof WalletActionError && e.kind === "rejected")) setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign in with Nimiq Pay
        </Button>
      </div>
    );
  }

  return <RemoteSignIn onDone={onDone} />;
}

function RemoteSignIn({ onDone }: { onDone?: () => void }) {
  const session = useSession();
  const [req, setReq] = useState<RemoteRequest | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "waiting" | "expired" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const start = useCallback(async () => {
    try {
      const r = await session.startRemote();
      setReq(r);
      setQr(await QRCode.toDataURL(r.deepLink, { margin: 1, width: 480, color: { dark: "#111111", light: "#ffffff" } }));
      setStatus("waiting");
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }, [session]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => alive && void start(), 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [start]);

  useEffect(() => {
    if (!req || status !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await session.pollRemote(req);
        if (stopped) return;
        if (s === "approved") return onDoneRef.current?.();
        if (s === "expired" || s === "consumed") return setStatus("expired");
      } catch {
        /* keep polling */
      }
      if (!stopped) setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [req, status, session]);

  if (status === "loading") return <div className="grid place-items-center py-10"><Spinner /></div>;
  if (status === "error") return <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={() => { setStatus("loading"); void start(); }}>Try again</Button>}>{error}</Notice>;

  return (
    <div className="space-y-4">
      {status === "expired" ? (
        <Notice tone="warn" action={<Button size="sm" variant="secondary" onClick={() => { setStatus("loading"); void start(); }}>New code</Button>}>
          This sign-in request expired.
        </Notice>
      ) : null}
      <div className="flex flex-col items-center rounded-[24px] bg-surface-2 p-5 text-center">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="QR code to approve sign-in in Nimiq Pay" className="size-48 rounded-2xl bg-white p-2" />
        ) : null}
        <p className="mt-4 text-[13px] text-fg-2">Scan with your phone camera to open AuraPay in Nimiq Pay, then approve.</p>
        <div className="mt-4 w-full">
          <p className="text-[11px] tracking-wide text-fg-3 uppercase">Or enter this code in AuraPay inside Nimiq Pay</p>
          <button
            onClick={() => req && navigator.clipboard?.writeText(req.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
            className="mt-1.5 inline-flex items-center gap-2 font-mono text-[26px] font-semibold tracking-[0.12em] text-fg"
          >
            {req?.code}
            {copied ? <Check className="size-4 text-up" /> : <Copy className="size-4 text-fg-3" />}
          </button>
        </div>
      </div>
      <a href={req?.deepLink} className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-accent text-[16px] font-medium text-white">
        <Smartphone className="size-5" /> Open in Nimiq Pay
      </a>
      <p className="flex items-center justify-center gap-2 text-xs text-fg-3">
        <Spinner className="size-3.5" /> Waiting for approval in Nimiq Pay…
      </p>
    </div>
  );
}

export function SignInSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Sign in with Nimiq Pay">
      {open ? <SignInPanel onDone={onClose} /> : null}
    </Sheet>
  );
}
