"use client";

import { CheckCircle2, Clock, Loader2, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import type { ActivityStatus, UtilityOrderStatus } from "@/lib/shared/types";
import { cx } from "./ui";

const ACTIVITY: Record<ActivityStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  pending: { label: "Pending", cls: "text-fg-2 bg-surface-3", Icon: Clock },
  processing: { label: "Processing", cls: "text-accent-strong bg-accent-soft", Icon: Loader2 },
  successful: { label: "Successful", cls: "text-up bg-up-soft", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "text-down bg-down-soft", Icon: XCircle },
  refunded: { label: "Refunded", cls: "text-mint bg-mint-soft", Icon: RotateCcw },
  requires_review: { label: "Requires review", cls: "text-warn bg-warn-soft", Icon: ShieldAlert },
};

/** Status always shows icon + label, never colour alone. */
export function StatusPill({ status, className }: { status: ActivityStatus; className?: string }) {
  const s = ACTIVITY[status];
  return (
    <span className={cx("inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium", s.cls, className)}>
      <s.Icon className={cx("size-3.5", status === "processing" && "animate-spin")} aria-hidden />
      {s.label}
    </span>
  );
}

export const ORDER_STATUS_LABEL: Record<UtilityOrderStatus, string> = {
  quoted: "Awaiting payment",
  payment_pending: "Confirming your payment",
  paid: "Payment confirmed",
  fulfilling: "Sending to provider",
  provider_pending: "Processing with provider",
  successful: "Successful",
  failed: "Failed",
  expired: "Quote expired",
  requires_review: "Requires review",
  refunded: "Refunded",
};

export function orderToActivity(s: UtilityOrderStatus): ActivityStatus {
  if (s === "quoted" || s === "payment_pending") return "pending";
  if (s === "paid" || s === "fulfilling" || s === "provider_pending") return "processing";
  if (s === "expired") return "failed";
  return s;
}

export const TERMINAL_ORDER_STATUSES: UtilityOrderStatus[] = ["successful", "failed", "expired", "requires_review", "refunded"];
