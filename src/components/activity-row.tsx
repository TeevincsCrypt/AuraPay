"use client";

import Link from "next/link";
import { ArrowDownLeft, Landmark, LineChart, RotateCcw, Smartphone, Wallet } from "lucide-react";
import type { ActivityItem } from "@/lib/shared/types";
import { fmtCrypto, fmtRelative, fmtUsd } from "@/lib/shared/format";
import { StatusPill } from "./status-pill";
import { Badge } from "./ui";

const ICON = {
  stock_purchase: LineChart,
  utility_purchase: Smartphone,
  loan_disbursement: Landmark,
  loan_repayment: ArrowDownLeft,
  wallet_payment: Wallet,
  refund: RotateCcw,
} as const;

export const CATEGORY_LABEL: Record<ActivityItem["category"], string> = {
  stock_purchase: "Stock purchase",
  utility_purchase: "Utility payment",
  loan_disbursement: "Loan disbursement",
  loan_repayment: "Loan repayment",
  wallet_payment: "Wallet payment",
  refund: "Refund",
};

export function amountText(i: ActivityItem): string {
  if (i.currency === "USD") return fmtUsd(i.amount);
  return fmtCrypto(i.amount, i.currency);
}

export function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ICON[item.category];
  const incoming = item.category === "loan_disbursement" || item.category === "refund";
  return (
    <Link href={`/activity/${item.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 sm:px-5">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-2">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{item.title}</span>
          {item.isSimulated ? <Badge tone="warn">Sim</Badge> : item.environment === "sandbox" ? <Badge tone="mint">Test</Badge> : null}
        </span>
        <span className="block truncate text-xs text-fg-3">
          {item.subtitle ? `${item.subtitle} · ` : ""}
          {fmtRelative(item.createdAt)}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className={`num text-sm font-medium ${incoming ? "text-up" : "text-fg"}`}>
          {incoming ? "+" : ""}
          {amountText(item)}
        </span>
        <StatusPill status={item.status} className="h-5 px-1.5 text-[10.5px]" />
      </span>
    </Link>
  );
}
