"use client";

import { useMemo, useState } from "react";
import { ListOrdered } from "lucide-react";
import { ActivityRow, CATEGORY_LABEL } from "@/components/activity-row";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/hooks";
import type { ActivityItem } from "@/lib/shared/types";

type Cat = "all" | ActivityItem["category"];

const CATS: Cat[] = ["all", "utility_purchase", "transfer_sent", "transfer_received", "earn_deposit", "earn_withdraw", "swap", "bill_schedule", "refund"];

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function ActivityPage() {
  const q = useApi<{ items: ActivityItem[] }>("/api/activity?limit=200", { pollMs: 20_000 });
  const [cat, setCat] = useState<Cat>("all");

  const groups = useMemo(() => {
    const items = (q.data?.items ?? []).filter((i) => cat === "all" || i.category === cat);
    const map = new Map<string, ActivityItem[]>();
    for (const i of items) {
      const k = dayLabel(i.createdAt);
      map.set(k, [...(map.get(k) ?? []), i]);
    }
    return [...map.entries()];
  }, [q.data, cat]);

  return (
    <div className="space-y-5">
      <PageHeader title="Activity" subtitle="Every bill, transfer and refund in one place." />
      <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {CATS.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`h-8 shrink-0 rounded-full border px-3 text-[13px] ${cat === c ? "border-[rgb(139_124_246/0.5)] bg-accent-soft text-accent-strong" : "border-line text-fg-3 hover:text-fg-2"}`}
          >
            {c === "all" ? "All" : CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {q.error ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !q.data ? (
        <Card className="space-y-3 p-5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon={<ListOrdered className="size-5" />} title="Nothing here yet">
            Transactions appear here as soon as you start one.
          </EmptyState>
        </Card>
      ) : (
        groups.map(([day, items]) => (
          <section key={day}>
            <h2 className="mb-2 px-0.5 text-xs font-medium text-fg-3">{day}</h2>
            <Card className="divide-y divide-line overflow-hidden">
              {items.map((i) => (
                <ActivityRow key={i.id} item={i} />
              ))}
            </Card>
          </section>
        ))
      )}
    </div>
  );
}
