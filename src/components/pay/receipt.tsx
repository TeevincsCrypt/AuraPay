"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { UtilityOrderDTO } from "@/lib/shared/types";
import { countryByCode } from "@/lib/shared/countries";
import { fmtCrypto, fmtDate, fmtMoney, fmtRate, fmtUsd, shortHash } from "@/lib/shared/format";
import { ORDER_STATUS_LABEL, StatusPill, orderToActivity } from "../status-pill";
import { Divider, KV, Notice, TestBadge } from "../ui";

const SERVICE = { airtime: "Airtime", data: "Mobile data", electricity: "Electricity" } as const;

function CopyValue({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-2 hover:text-fg"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {display ?? value}
      {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function explorerUrl(order: Pick<UtilityOrderDTO, "quote" | "paymentTxHash" | "environment">): string | null {
  if (!order.paymentTxHash) return null;
  if (order.quote.payCurrency === "USDT") return `https://polygonscan.com/tx/${order.paymentTxHash}`;
  if (order.quote.payCurrency === "NIM") return `https://${order.environment === "sandbox" ? "test." : ""}nimiq.watch/#${order.paymentTxHash}`;
  return null;
}

export function OrderReceipt({ order }: { order: UtilityOrderDTO }) {
  const country = countryByCode(order.countryCode);
  const delivery = order.deliveryDetails ?? {};
  const token = (delivery.token as string | undefined) ?? null;
  const pin = delivery.pin as Record<string, unknown> | null | undefined;
  const sandbox = order.environment === "sandbox";
  const url = explorerUrl(order);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={orderToActivity(order.status)} />
        {sandbox ? <TestBadge /> : null}
      </div>

      {sandbox && order.status === "successful" ? (
        <Notice tone="info">
          Test transaction processed by the provider&apos;s sandbox. No real airtime, data or electricity was delivered.
        </Notice>
      ) : null}
      {order.status === "requires_review" ? (
        <Notice tone="warn" title="We're looking into this">
          {order.statusReason ?? "Your payment was received but the provider couldn't confirm delivery."} If delivery can&apos;t be completed, your payment will be refunded to the wallet it came from.
          Reference: <span className="font-mono">{order.ref}</span>
        </Notice>
      ) : null}
      {order.status === "payment_pending" && order.statusReason ? <Notice tone="info">{order.statusReason}</Notice> : null}

      <div>
        <KV k="Status" v={ORDER_STATUS_LABEL[order.status]} />
        <KV k="Service" v={`${SERVICE[order.service]} · ${country?.flag ?? ""} ${country?.name ?? order.countryCode}`} />
        <KV k="Provider" v={order.operatorName} />
        <KV k={order.service === "electricity" ? "Meter / account" : "Recipient"} v={<span className="font-mono text-xs">{order.service === "electricity" ? order.recipient : `+${order.recipient}`}</span>} />
        {order.productDescription ? <KV k="Product" v={order.productDescription} /> : null}
        {order.amountLocal !== null && order.localCurrency ? <KV k="Value" v={fmtMoney(order.amountLocal, order.localCurrency)} /> : null}
      </div>

      {token ? (
        <div className="rounded-[20px] bg-peach p-4 text-center">
          <p className="text-xs text-fg-3">Electricity token</p>
          <p className="num mt-1 font-mono text-lg tracking-widest text-fg">{token}</p>
          <div className="mt-2">
            <CopyValue value={token} display="Copy token" />
          </div>
        </div>
      ) : null}
      {pin && (pin.code || pin.serial) ? (
        <div className="rounded-[18px] bg-surface-2 p-3 text-xs text-fg-2">
          {pin.code ? <KV k="PIN" v={String(pin.code)} /> : null}
          {pin.serial ? <KV k="Serial" v={String(pin.serial)} /> : null}
          {pin.info1 ? <p className="mt-1 text-fg-3">{String(pin.info1)}</p> : null}
        </div>
      ) : null}

      <Divider />
      <div>
        <KV k="Provider cost" v={fmtUsd(order.quote.providerCostUsd)} />
        <KV k="AuraPay fee" v={fmtUsd(order.quote.serviceFeeUsd)} />
        <KV k="Total" v={fmtUsd(order.quote.totalUsd)} strong />
        <KV
          k="Paid with"
          v={fmtCrypto(order.quote.payAmount, order.quote.payCurrency)}
        />
        <KV k="Rate" v={`1 ${order.quote.payCurrency} = $${fmtRate(order.quote.exchangeRate)} (${order.quote.rateSource})`} />
      </div>

      <Divider />
      <div>
        <KV k="Reference" v={<CopyValue value={order.ref} />} />
        {order.paymentTxHash ? (
          <KV
            k="Payment tx"
            v={
              url ? (
                <a className="font-mono text-xs text-accent-strong" href={url} target="_blank" rel="noreferrer">
                  {shortHash(order.paymentTxHash)}
                </a>
              ) : (
                shortHash(order.paymentTxHash)
              )
            }
          />
        ) : null}
        {order.providerTransactionId ? <KV k="Provider ref" v={<span className="font-mono text-xs">{order.providerTransactionId}</span>} /> : null}
        <KV k="Created" v={fmtDate(order.createdAt)} />
        {order.fulfilledAt ? <KV k="Completed" v={fmtDate(order.fulfilledAt)} /> : null}
      </div>
    </div>
  );
}
