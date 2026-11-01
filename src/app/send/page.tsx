"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AtSign, CheckCircle2, QrCode, Repeat, Send as SendIcon, Wallet } from "lucide-react";
import { RepeatSheet } from "@/components/recurring";
import { UsernameEditor } from "@/components/transfers/username-editor";
import { Avatar, Button, Card, cx, Field, Input, Keypad, KV, Notice, PageHeader, Segmented, SlideToConfirm, Spinner, TestBadge } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useApi, useStatus } from "@/lib/client/hooks";
import { useMoney } from "@/lib/client/money";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { fmtCrypto, fmtUsd, shortAddress } from "@/lib/shared/format";
import type { PayCurrency, TransferDTO, UsernameProfile } from "@/lib/shared/types";

type Step = "form" | "review" | "sending" | "done";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const clean = (s: string) => s.trim().replace(/^@+/, "").toLowerCase();

function SendFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const session = useSession();
  const w = useWallet();
  const { data: status } = useStatus();
  const ratesQ = useApi<{ nimUsd: number; usdtUsd: number }>("/api/rates");
  const listQ = useApi<{ transfers: TransferDTO[]; recent: string[] }>("/api/transfers");

  const money = useMoney();
  const [step, setStep] = useState<Step>("form");
  const recurringId = params.get("recurring");
  // A savings-circle contribution: recipient, amount and currency are fixed by the circle.
  const circleId = params.get("circle");
  const circleRound = Number(params.get("round") ?? 0) || undefined;
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [to, setTo] = useState(() => clean(params.get("to") ?? ""));
  const [currency, setCurrency] = useState<PayCurrency>(() => (params.get("currency") === "USDT" ? "USDT" : "NIM"));
  const [amountText, setAmountText] = useState(() => params.get("amount") ?? "");
  const [note, setNote] = useState(() => params.get("note")?.slice(0, 40) ?? "");
  const [transfer, setTransfer] = useState<TransferDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; unknown?: boolean } | null>(null);

  const debounced = useDebounced(clean(to), 400);
  const lookup = useApi<{ user: UsernameProfile }>(/^[a-z][a-z0-9_]{2,19}$/.test(debounced) ? `/api/users/${debounced}` : null);
  const recipient = lookup.data?.user && lookup.data.user.username === debounced ? lookup.data.user : null;

  const me = session.user;
  const self = recipient && me?.username === recipient.username;
  const amount = Number(amountText);
  const rate = currency === "NIM" ? ratesQ.data?.nimUsd : ratesQ.data?.usdtUsd;
  const usd = amount > 0 && rate ? amount * rate : null;
  const nimBalance = w.nimiq.balanceLuna !== null ? w.nimiq.balanceLuna / 1e5 : null;
  const balance = currency === "NIM" ? nimBalance : w.evm.usdtBalance;
  const overBalance = balance !== null && amount > balance;
  const usdtBlocked = currency === "USDT" && recipient && !recipient.polygonAddress;
  const testnet = currency === "NIM" && status?.nimiq.network === "testnet";
  const networkMismatch = currency === "NIM" && w.hostNetwork && status && w.hostNetwork !== status.nimiq.network;
  const canReview = Boolean(recipient && !self && amount > 0 && !usdtBlocked && !overBalance);

  // Prepares the transfer: the server fixes the recipient address, exact amount and memo.
  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      let fromAddress: string | undefined;
      if (currency === "USDT") fromAddress = me?.evmAddresses[0] ?? (await w.linkEvm().then(async (a) => (await session.refresh(), a)));
      if (currency === "NIM" && w.nimiq.status !== "connected") await w.connectNimiq();
      const r = await api<{ transfer: TransferDTO }>("/api/transfers", {
        method: "POST",
        json: { toUsername: recipient!.username, currency, amount, note: note.trim() || undefined, fromAddress, ...(circleId ? { circleId, round: circleRound } : {}) },
      });
      setTransfer(r.transfer);
      setStep("review");
    } catch (e) {
      if (!(e instanceof WalletActionError && e.kind === "rejected")) setError({ msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const send = useCallback(async () => {
    if (!transfer) return;
    setBusy(true);
    setError(null);
    try {
      let txHash: string;
      if (transfer.currency === "NIM") {
        if (networkMismatch) throw new WalletActionError("failed", `Switch Nimiq Pay to ${status!.nimiq.network} to send.`);
        txHash = await w.payNim({ recipient: transfer.toAddress, luna: transfer.amountAtomic, memo: transfer.memo ?? "" });
      } else {
        const r = await w.payUsdt({ to: transfer.toAddress, units: transfer.amountAtomic });
        if (transfer.fromAddress && r.from.toLowerCase() !== transfer.fromAddress.toLowerCase()) {
          throw new WalletActionError("failed", "Your wallet sent from a different address than the one you verified. Contact support with the transaction hash.");
        }
        txHash = r.hash;
      }
      setStep("sending");
      const r = await api<{ transfer: TransferDTO }>(`/api/transfers/${transfer.id}/submit`, { method: "POST", json: { txHash } });
      setTransfer(r.transfer);
      if (recurringId && r.transfer.status === "confirmed") void api(`/api/recurring/${recurringId}/paid`, { method: "POST" }).catch(() => {});
      setStep(r.transfer.status === "pending" ? "sending" : "done");
    } catch (e) {
      if (e instanceof WalletActionError) setError(e.kind === "rejected" ? { msg: "Cancelled. Nothing was sent." } : { msg: e.message, unknown: e.kind === "unknown_outcome" });
      else setError({ msg: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [transfer, w, networkMismatch, status, recurringId]);

  // While confirming on-chain, poll the transfer.
  useEffect(() => {
    if (step !== "sending" || !transfer) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<{ transfer: TransferDTO }>(`/api/transfers/${transfer.id}`);
        if (stop) return;
        setTransfer(r.transfer);
        if (r.transfer.status !== "pending") {
          if (recurringId && r.transfer.status === "confirmed") void api(`/api/recurring/${recurringId}/paid`, { method: "POST" }).catch(() => {});
          setStep("done");
          void listQ.refetch();
          return;
        }
      } catch {}
      if (!stop) setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, transfer?.id]);

  const reset = () => {
    setStep("form");
    setTransfer(null);
    setAmountText("");
    setNote("");
    setError(null);
    router.replace("/send");
  };

  if (!me) return null;

  if (!me.username) {
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
            <AtSign className="size-5" />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-fg">Choose your @username</p>
            <p className="mt-0.5 text-[13px] text-fg-2">Send and receive NIM and USDT with a name instead of a long address.</p>
          </div>
        </div>
        <div className="mt-4">
          <UsernameEditor />
        </div>
      </Card>
    );
  }

  if (step === "done" && transfer) {
    const ok = transfer.status === "confirmed";
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center text-center">
          {ok ? <CheckCircle2 className="size-10 text-up" /> : <SendIcon className="size-9 text-down" />}
          <p className="mt-3 text-base font-medium text-fg">{ok ? `Sent to @${transfer.counterparty}` : "Transfer not confirmed"}</p>
          <p className="num mt-1 text-[28px] font-semibold tracking-[-0.02em] text-fg">{fmtCrypto(transfer.amount, transfer.currency)}</p>
          {transfer.amountUsd && !testnet ? <p className="num text-[13px] text-fg-3">≈ {money.currency !== "USD" && money.local(transfer.amountUsd) ? `${money.local(transfer.amountUsd)} · ` : ""}{fmtUsd(transfer.amountUsd)}</p> : null}
          {!ok ? <p className="mt-2 text-[13px] text-fg-3">{transfer.failureReason}</p> : null}
        </div>
        <div className="mt-5 border-t border-line pt-2">
          {transfer.note ? <KV k="Note" v={transfer.note} /> : null}
          <KV k="To" v={<span className="font-mono text-xs">{shortAddress(transfer.toAddress, 10, 6)}</span>} />
          {transfer.txHash ? <KV k="Transaction" v={<span className="font-mono text-xs">{shortAddress(transfer.txHash, 10, 6)}</span>} /> : null}
          <KV k="Ref" v={transfer.ref} />
        </div>
        {ok && !recurringId ? (
          <>
            <Button variant="secondary" className="mt-5 w-full" onClick={() => setRepeatOpen(true)}>
              <Repeat className="size-4" /> Make it recurring
            </Button>
            <RepeatSheet open={repeatOpen} onClose={() => setRepeatOpen(false)} source={{ transferId: transfer.id }} label={`${fmtCrypto(transfer.amount, transfer.currency)} to @${transfer.counterparty}`} />
          </>
        ) : null}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => router.push(circleId ? `/savings/${circleId}` : "/activity")}>
            View activity
          </Button>
          <Button onClick={reset}>Send again</Button>
        </div>
      </Card>
    );
  }

  if (step === "sending" && transfer) {
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center text-center">
          <Spinner className="size-7 text-accent-strong" />
          <p className="mt-3 text-base font-medium text-fg">Confirming on {transfer.currency === "NIM" ? "Nimiq" : "Polygon"}</p>
          <p className="mt-1 text-[13px] text-fg-3">{transfer.failureReason ?? "This usually takes a few seconds."}</p>
        </div>
      </Card>
    );
  }

  if (step === "review" && transfer) {
    return (
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar seed={transfer.toAddress} label={transfer.counterparty} size={44} />
              <div className="min-w-0">
                <p className="text-xs text-fg-3">You&apos;re sending to</p>
                <p className="truncate text-[17px] font-semibold text-fg">@{transfer.counterparty}</p>
              </div>
            </div>
            {testnet ? <TestBadge /> : null}
          </div>
          <p className="num mt-4 text-[32px] font-semibold tracking-[-0.02em] text-fg">{fmtCrypto(transfer.amount, transfer.currency)}</p>
          {transfer.amountUsd && !testnet ? <p className="num text-[13px] text-fg-3">≈ {money.currency !== "USD" && money.local(transfer.amountUsd) ? `${money.local(transfer.amountUsd)} · ` : ""}{fmtUsd(transfer.amountUsd)}</p> : null}
          <div className="mt-4 border-t border-line pt-2">
            {transfer.note ? <KV k="Note" v={transfer.note} /> : null}
            <KV k="To address" v={<span className="font-mono text-xs">{shortAddress(transfer.toAddress, 10, 6)}</span>} />
            <KV k="Network" v={transfer.currency === "NIM" ? `Nimiq ${status?.nimiq.network ?? ""}` : "Polygon"} />
            <KV k="AuraPay fee" v="Free" />
          </div>
        </Card>
        <p className="px-1 text-xs leading-relaxed text-fg-3">
          Goes straight from your wallet to @{transfer.counterparty}&apos;s wallet. AuraPay never holds it. Blockchain transfers can&apos;t be reversed, so check the username.
          {transfer.currency === "USDT" ? " Your wallet charges a small Polygon network fee." : ""}
        </p>
        {networkMismatch ? <Notice tone="warn">Nimiq Pay is on {w.hostNetwork}; switch it to {status!.nimiq.network} to send.</Notice> : null}
        {error ? (
          <Notice tone={error.unknown ? "warn" : "error"} title={error.unknown ? "Status unknown" : undefined}>
            {error.msg}
          </Notice>
        ) : null}
        <SlideToConfirm label={busy ? "Waiting for your wallet…" : `Slide to send ${fmtCrypto(transfer.amount, transfer.currency)}`} loading={busy} disabled={Boolean(error?.unknown) || Boolean(networkMismatch)} onConfirm={() => void send()} />
        <Button variant="ghost" className="w-full" onClick={() => setStep("form")}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {circleId ? (
        <Notice tone="info" title={`Savings circle · round ${circleRound}`}>
          Your contribution goes straight to @{clean(to)}. The amount and currency are set by the circle.
        </Notice>
      ) : null}
      <Field
        label="To"
        htmlFor="to"
        error={lookup.error && clean(to).length >= 3 ? lookup.error.message : self ? "That's you." : null}
        hint={recipient && !self ? `✓ @${recipient.username}${recipient.polygonAddress ? " · NIM & USDT" : " · NIM only"}` : "Their AuraPay @username"}
      >
        <Input id="to" lead={<AtSign className="size-4" />} placeholder="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} readOnly={Boolean(circleId)} value={to} onChange={(e) => setTo(e.target.value.replace(/\s/g, ""))} />
      </Field>
      {listQ.data?.recent.length ? (
        <div className="scrollbar-none -mx-4 -mt-2 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {listQ.data.recent.map((u) => (
            <button key={u} onClick={() => setTo(u)} className={cx("shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium", clean(to) === u ? "bg-accent text-white" : "bg-surface text-fg-2 shadow-[var(--shadow-card)]")}>
              @{u}
            </button>
          ))}
        </div>
      ) : null}

      <Field label="Currency">
        <Segmented<PayCurrency>
          className="w-full"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: "NIM", label: "NIM" },
            { value: "USDT", label: "USDT · Polygon" },
          ]}
        />
      </Field>
      {usdtBlocked ? <Notice tone="warn">@{recipient!.username} hasn&apos;t set up a USDT wallet yet. Send NIM instead.</Notice> : null}

      <Field label="Amount" hint={balance !== null ? `Balance ${fmtCrypto(balance, currency)}${testnet ? " · testnet" : ""}` : undefined} error={overBalance ? "More than your balance." : null}>
        <div className="hero-surface rounded-[24px] px-4 py-6 text-center">
          <input
            inputMode="decimal"
            placeholder="0"
            aria-label={`Amount in ${currency}`}
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num w-full bg-transparent text-center text-[38px] font-semibold tracking-[-0.03em] text-fg outline-none placeholder:text-fg-3"
          />
          <p className="text-[13px] text-fg-2">
            {currency}
            {usd !== null && !testnet ? ` · ≈ ${money.currency !== "USD" && money.local(usd) ? `${money.local(usd)} · ` : ""}${fmtUsd(usd)}` : ""}
          </p>
        </div>
        <div className="mt-3 sm:hidden">
          <Keypad value={amountText} onChange={setAmountText} maxDecimals={currency === "NIM" ? 5 : 6} />
        </div>
      </Field>

      <Field label="Note (optional)" htmlFor="note" hint={currency === "NIM" ? "Saved with the transfer and included in the Nimiq transaction." : "Saved with the transfer."}>
        <Input id="note" placeholder="e.g. Lunch 🍲" maxLength={40} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {currency === "USDT" && !me.evmAddresses.length ? (
        <Notice tone="info">
          <Wallet className="mr-1 inline size-3.5" /> You&apos;ll verify your USDT wallet once with a signature before sending.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error.msg}</Notice> : null}
      <Button size="lg" disabled={!canReview} loading={busy} onClick={review}>
        Review
      </Button>
    </div>
  );
}

export default function SendPage() {
  return (
    <div className="mx-auto max-w-[560px]">
      <PageHeader
        title="Send"
        subtitle="NIM or USDT to any AuraPay @username. Free, wallet to wallet."
        action={
          <Link href="/receive" className="inline-flex h-8 items-center gap-1 rounded-full bg-surface px-3 text-[12.5px] font-medium text-fg-2 shadow-[var(--shadow-card)]">
            <QrCode className="size-3.5" /> Receive
          </Link>
        }
      />
      <Suspense fallback={<Spinner />}>
        <SendFlow />
      </Suspense>
    </div>
  );
}
