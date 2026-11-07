"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Building2, Clock, Landmark, Receipt, Send } from "lucide-react";
import { Badge, Button, Card, Field, Input, KV, Notice, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { fmtNum } from "@/lib/shared/format";
import type { TransferCurrency } from "@/lib/shared/types";

/**
 * Cash in / cash out (naira ↔ NIM, USDT, POL). Not live: AuraPay's registration with the Corporate
 * Affairs Commission (CAC) for handling customer money is still in progress. This page only shows
 * what's coming and live market rates for reference. It never collects bank details or money.
 */

type Mode = "buy" | "sell";
interface Rates {
  nimUsd: number;
  usdtUsd: number;
  polUsd: number | null;
  fiat: { currency: string; perUsd: number | null } | null;
}

const ASSETS: { id: TransferCurrency; name: string; net: string }[] = [
  { id: "NIM", name: "Nimiq", net: "Nimiq" },
  { id: "USDT", name: "Tether USD", net: "Polygon" },
  { id: "POL", name: "Polygon", net: "Polygon" },
];

export default function CashPage() {
  const [mode, setMode] = useState<Mode>("buy");
  const [asset, setAsset] = useState<TransferCurrency>("USDT");
  const [amount, setAmount] = useState("");
  const ratesQ = useApi<Rates>("/api/rates?fiat=NGN");

  const r = ratesQ.data;
  const usd = r ? (asset === "NIM" ? r.nimUsd : asset === "USDT" ? r.usdtUsd : r.polUsd) : null;
  const ngnPerUnit = usd && r?.fiat?.perUsd ? usd * r.fiat.perUsd : null;
  const amt = Number(amount);
  // Buy: you enter naira → about this much crypto. Sell: you enter crypto → about this much naira.
  const estimate = ngnPerUnit && amt > 0 ? (mode === "buy" ? amt / ngnPerUnit : amt * ngnPerUnit) : null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      <PageHeader title="Cash in & out" subtitle="Buy and sell NIM, USDT and POL with naira, straight to and from your bank." action={<Badge tone="warn">Coming soon</Badge>} />

      <Notice tone="warn" title="Not available yet">
        We&apos;re completing AuraPay&apos;s registration with the Corporate Affairs Commission (CAC) before we handle naira for customers. Buying and selling will open here once that&apos;s
        done. Nothing on this page moves money, and we don&apos;t ask for bank details yet.
      </Notice>

      <Card className="space-y-4 p-5">
        <Segmented<Mode>
          className="w-full"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setAmount("");
          }}
          options={[
            { value: "buy", label: "Buy (cash in)" },
            { value: "sell", label: "Sell (cash out)" },
          ]}
        />

        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Asset">
          {ASSETS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={asset === a.id}
              onClick={() => setAsset(a.id)}
              className={`rounded-2xl border p-3 text-left transition ${asset === a.id ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
            >
              <span className="block text-[14px] font-semibold text-fg">{a.id}</span>
              <span className="block text-[11.5px] text-fg-3">{a.net}</span>
            </button>
          ))}
        </div>

        <Field label={mode === "buy" ? "You pay (NGN)" : `You sell (${asset})`} htmlFor="cash-amt" hint="Preview only: try an amount to see today's market value.">
          <Input
            id="cash-amt"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            trail={mode === "buy" ? "NGN" : asset}
          />
        </Field>

        <div className="rounded-2xl bg-surface-2 px-4 py-1">
          {!r ? (
            <Skeleton className="my-3 h-5 w-2/3" />
          ) : (
            <>
              <KV k={`1 ${asset} today`} v={ngnPerUnit ? `≈ ₦${fmtNum(ngnPerUnit, ngnPerUnit < 10 ? 4 : 2, 2)}` : "—"} />
              <KV
                k={mode === "buy" ? "You'd get about" : "You'd get about"}
                v={estimate !== null ? (mode === "buy" ? `${fmtNum(estimate, asset === "USDT" ? 2 : 4)} ${asset}` : `₦${fmtNum(estimate, 2, 2)}`) : "—"}
              />
              <KV k="Fees" v="Shown before you confirm, at launch" />
            </>
          )}
        </div>
        <p className="text-[11.5px] leading-relaxed text-fg-3">Market rate for reference only (CoinGecko, converted at our bill provider&apos;s naira rate). Final rates and fees will be quoted when cash in & out opens.</p>

        <Button size="lg" disabled>
          <Clock className="size-4" /> {mode === "buy" ? `Buy ${asset}` : `Sell ${asset}`}: coming soon
        </Button>
      </Card>

      <Card className="p-5">
        <p className="text-[15px] font-semibold text-fg">How it will work</p>
        <ol className="mt-3 space-y-3 text-[13.5px] text-fg-2">
          <li className="flex gap-3">
            <Landmark className="mt-0.5 size-4 shrink-0 text-accent-strong" />
            <span>
              <strong className="text-fg">Cash in:</strong> pay naira by bank transfer to a dedicated account; NIM, USDT or POL arrives in your own Nimiq Pay wallet.
            </span>
          </li>
          <li className="flex gap-3">
            <ArrowUpFromLine className="mt-0.5 size-4 shrink-0 text-accent-strong" />
            <span>
              <strong className="text-fg">Cash out:</strong> send NIM, USDT or POL from your wallet; naira lands in your verified Nigerian bank account.
            </span>
          </li>
          <li className="flex gap-3">
            <Building2 className="mt-0.5 size-4 shrink-0 text-accent-strong" />
            <span>
              <strong className="text-fg">Verified and on the record:</strong> identity checks (KYC) and limits as required, every order in your Activity.
            </span>
          </li>
        </ol>
      </Card>

      <div>
        <p className="mb-2 px-1 text-[13px] font-medium text-fg-2">Until then, you can</p>
        <div className="grid grid-cols-3 gap-2">
          <Link href="/pay">
            <Card className="flex h-full flex-col items-center gap-1.5 p-3 text-center">
              <Receipt className="size-5 text-accent-strong" />
              <span className="text-[12.5px] font-medium text-fg">Pay bills</span>
            </Card>
          </Link>
          <Link href="/swap">
            <Card className="flex h-full flex-col items-center gap-1.5 p-3 text-center">
              <ArrowLeftRight className="size-5 text-accent-strong" />
              <span className="text-[12.5px] font-medium text-fg">Swap USDT ↔ POL</span>
            </Card>
          </Link>
          <Link href="/receive">
            <Card className="flex h-full flex-col items-center gap-1.5 p-3 text-center">
              <ArrowDownToLine className="size-5 text-accent-strong" />
              <span className="text-[12.5px] font-medium text-fg">Receive</span>
            </Card>
          </Link>
        </div>
      </div>
      <p className="px-1 text-xs text-fg-3">
        <Send className="mr-1 inline size-3" /> Sending crypto to friends stays free and wallet to wallet, as today.
      </p>
    </div>
  );
}
