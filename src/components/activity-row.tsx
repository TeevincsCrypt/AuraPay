"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, CalendarClock, Landmark, LineChart, RotateCcw, Smartphone, Wallet, ShieldPlus, ShieldMinus } from "lucide-react";
import type { ActivityItem } from "@/lib/shared/types";
import { fmtCrypto, fmtNum, fmtRelative, fmtUsd } from "@/lib/shared/format";
import { cx } from "./ui";

const ICON = {
  stock_purchase: LineChart,
  utility_purchase: Smartphone,
  loan_disbursement: Landmark,
  loan_repayment: ArrowUpRight,
  collateral_deposit: ShieldPlus,
  collateral_withdrawal: ShieldMinus,
  wallet_payment: Wallet,
  refund: RotateCcw,
  bill_schedule: CalendarClock,
} as const;

export const CATEGORY_LABEL: Record<ActivityItem["category"], string> = {
  stock_purchase: "Stock purchase",
  utility_purchase: "Utility payment",
  loan_disbursement: "Borrowed",
  loan_repayment: "Loan repayment",
  collateral_deposit: "Collateral added",
  collateral_withdrawal: "Collateral withdrawn",
  wallet_payment: "Wallet payment",
  refund: "Refund",
  bill_schedule: "Scheduled bills",
};

const STATUS_TEXT: Record<ActivityItem["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  successful: "Completed",
  failed: "Failed",
  refunded: "Refunded",
  requires_review: "In review",
};

export function amountText(i: ActivityItem): string {
  if (i.currency === "USD") return fmtUsd(i.amount);
  if (i.currency === "NIM" || i.currency === "USDT") return fmtCrypto(i.amount, i.currency);
  return `${fmtNum(i.amount, 4)} ${i.currency}`;
}

const INCOMING = new Set<ActivityItem["category"]>(["loan_disbursement", "refund", "collateral_withdrawal"]);

export function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ICON[item.category] ?? ArrowDownLeft;
  const incoming = INCOMING.has(item.category);
  const failed = item.status === "failed";
  return (
    <Link href={`/activity/${item.id}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-peach text-accent">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold text-fg">{item.title}</span>
          {item.environment === "sandbox" ? <span className="rounded-full bg-mint-soft px-1.5 text-[10px] font-semibold text-mint">TEST</span> : null}
        </span>
        <span className="block truncate text-[13px] text-fg-3">{fmtRelative(item.createdAt)}{item.subtitle ? ` · ${item.subtitle}` : ""}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className={cx("num text-[15px] font-semibold", failed ? "text-fg-3 line-through" : incoming ? "text-up" : "text-down")}>
          {incoming ? "+" : "−"}
          {amountText(item)}
        </span>
        <span className={cx("text-[12px]", item.status === "requires_review" ? "text-warn" : failed ? "text-down" : "text-fg-3")}>{STATUS_TEXT[item.status]}</span>
      </span>
    </Link>
  );
}
