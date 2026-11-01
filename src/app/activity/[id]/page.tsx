"use client";

import Link from "next/link";
import { use } from "react";
import { ArrowLeft } from "lucide-react";
import { amountText, CATEGORY_LABEL } from "@/components/activity-row";
import { OrderReceipt } from "@/components/pay/receipt";
import { StatusPill } from "@/components/status-pill";
import { Card, Divider, ErrorState, KV, Notice, Skeleton, TestBadge } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import { fmtDate, fmtUsd, shortHash } from "@/lib/shared/format";
import type { ActivityItem, UtilityOrderDTO } from "@/lib/shared/types";

const DETAIL_LABELS: Record<string, string> = {
  token: "Token",
  chainId: "Network ID",
  targetChainId: "Delivered on network ID",
  action: "Action",
  reserveId: "Aave reserve",
  originalRef: "Original order",
};

export default function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<{ item: ActivityItem; order: UtilityOrderDTO | null }>(`/api/activity/${id}`);
  const item = q.data?.item;

  return (
    <div className="mx-auto max-w-[560px] space-y-4">
      <Link href="/activity" className="inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg-2">
        <ArrowLeft className="size-4" /> Activity
      </Link>
      {q.error ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !item ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-40 w-full" />
        </Card>
      ) : (
        <Card className="p-6">
          <p className="text-xs text-fg-3">{CATEGORY_LABEL[item.category]}</p>
          <h1 className="mt-1 text-lg font-semibold text-fg">{item.title}</h1>
          <p className="num mt-1 text-[28px] font-semibold tracking-[-0.02em] text-fg">{amountText(item)}</p>
          {item.amountUsd !== null && item.currency !== "USD" ? <p className="num text-[13px] text-fg-3">≈ {fmtUsd(item.amountUsd)}</p> : null}

          <div className="mt-4">
            {q.data?.order ? (
              <OrderReceipt order={q.data.order} />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={item.status} />
                  {item.environment === "sandbox" ? <TestBadge /> : null}
                </div>
                {typeof item.details.note === "string" ? <Notice tone="warn">{item.details.note}</Notice> : null}
                <div>
                  {Object.entries(item.details)
                    .filter(([k, v]) => k in DETAIL_LABELS && v !== null && v !== undefined && typeof v !== "object")
                    .map(([k, v]) => (
                      <KV key={k} k={DETAIL_LABELS[k]} v={typeof v === "number" ? String(+v.toFixed(6)) : String(v)} />
                    ))}
                </div>
                <Divider />
                <div>
                  <KV k="Reference" v={<span className="font-mono text-xs">{item.ref}</span>} />
                  {item.provider ? <KV k="Provider" v={item.provider} /> : null}
                  {item.providerRef ? <KV k="Provider ref" v={item.providerRef} /> : null}
                  {item.chainTxHash ? <KV k="Transaction" v={shortHash(item.chainTxHash)} /> : null}
                  <KV k="Date" v={fmtDate(item.createdAt)} />
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
