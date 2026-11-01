"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { AtSign, Check, Copy, Send, Share2, Wallet } from "lucide-react";
import { UsernameEditor } from "@/components/transfers/username-editor";
import { Button, Card, Field, Input, Notice, PageHeader, Segmented, Spinner } from "@/components/ui";
import { useStatus } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import type { PayCurrency } from "@/lib/shared/types";

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-fg-3">{label}</p>
        <p className="truncate font-mono text-[12.5px] text-fg">{value}</p>
      </div>
      <button
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-2"
      >
        {copied ? <Check className="size-4 text-up" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

export default function ReceivePage() {
  const session = useSession();
  const w = useWallet();
  const { data: status } = useStatus();
  const user = session.user;
  const [currency, setCurrency] = useState<PayCurrency>("NIM");
  const [amount, setAmount] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A request link: opens AuraPay's Send screen in Nimiq Pay, pre-filled with this @username.
  const link = (() => {
    if (!user?.username || typeof window === "undefined") return null;
    const qs = new URLSearchParams({ to: user.username, currency, ...(Number(amount) > 0 ? { amount } : {}) }).toString();
    return `https://nimpay.app/miniapps/open/${window.location.host}/send?${qs}`;
  })();

  useEffect(() => {
    if (!link) return;
    let alive = true;
    QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: "#111111", light: "#ffffff" } })
      .then((d) => alive && setQr(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [link]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader
        title="Receive"
        subtitle="Share your @username or QR code to get NIM or USDT."
        action={
          <Link href="/send" className="inline-flex h-8 items-center gap-1 rounded-full bg-surface px-3 text-[12.5px] font-medium text-fg-2 shadow-[var(--shadow-card)]">
            <Send className="size-3.5" /> Send
          </Link>
        }
      />

      {!user.username ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
              <AtSign className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">Choose your @username</p>
              <p className="mt-0.5 text-[13px] text-fg-2">People can then send you NIM and USDT by name.</p>
            </div>
          </div>
          <div className="mt-4">
            <UsernameEditor />
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-col items-center text-center">
              <p className="text-[26px] font-semibold tracking-[-0.02em] text-fg">@{user.username}</p>
              <p className="text-[13px] text-fg-3">Scan in Nimiq Pay to send me {currency}</p>
              <div className="mt-4 grid size-56 place-items-center rounded-[24px] bg-white p-3 shadow-[var(--shadow-card)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {qr ? <img src={qr} alt={`QR code to send ${currency} to @${user.username}`} className="size-full" /> : <Spinner />}
              </div>
            </div>
            <div className="mt-5 space-y-3">
              <Segmented<PayCurrency>
                className="w-full"
                value={currency}
                onChange={setCurrency}
                options={[
                  { value: "NIM", label: "NIM" },
                  { value: "USDT", label: "USDT · Polygon", disabled: !user.receiveEvmAddress },
                ]}
              />
              <Field label="Request an amount (optional)" htmlFor="req">
                <Input id="req" inputMode="decimal" placeholder="0" trail={currency} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
              {link ? (
                <Button
                  className="w-full"
                  onClick={async () => {
                    const text = `Send me ${Number(amount) > 0 ? `${amount} ` : ""}${currency} on AuraPay: @${user.username}`;
                    try {
                      if (navigator.share) await navigator.share({ title: "AuraPay", text, url: link });
                      else await navigator.clipboard.writeText(`${text}\n${link}`);
                    } catch {}
                  }}
                >
                  <Share2 className="size-4" /> Share request link
                </Button>
              ) : null}
            </div>
          </Card>

          <Card className="px-5 py-2">
            <p className="pt-2 text-sm font-semibold text-fg">Your addresses</p>
            <p className="text-xs text-fg-3">Anyone can also send directly to these, even without AuraPay.</p>
            <div className="divide-y divide-line">
              <CopyRow label={`NIM · Nimiq ${status?.nimiq.network ?? ""}`} value={user.address} />
              {user.receiveEvmAddress ? <CopyRow label="USDT · Polygon" value={user.receiveEvmAddress} /> : null}
            </div>
            {!user.receiveEvmAddress ? (
              <div className="pb-3">
                <Notice tone="info" className="mt-1">
                  To receive USDT by username, verify your Nimiq Pay USDT wallet once (a signature, no transaction).
                </Notice>
                <Button
                  className="mt-3 w-full"
                  variant="dark"
                  loading={linking}
                  disabled={!w.evm.available}
                  onClick={async () => {
                    setErr(null);
                    setLinking(true);
                    try {
                      await w.linkEvm();
                      await session.refresh();
                    } catch (e) {
                      if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr((e as Error).message);
                    } finally {
                      setLinking(false);
                    }
                  }}
                >
                  <Wallet className="size-4" /> Verify USDT wallet
                </Button>
                {!w.evm.available ? <p className="mt-2 text-xs text-fg-3">Open AuraPay in Nimiq Pay to verify your USDT wallet.</p> : null}
                {err ? <Notice tone="error" className="mt-2">{err}</Notice> : null}
              </div>
            ) : null}
          </Card>
          <Card className="p-5">
            <p className="mb-2 text-sm font-semibold text-fg">Change username</p>
            <UsernameEditor compact />
          </Card>
        </>
      )}
    </div>
  );
}
