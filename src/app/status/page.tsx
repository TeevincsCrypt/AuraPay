"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge, Card, CardHeader, ErrorState, KV, PageHeader, Skeleton } from "@/components/ui";
import { useStatus } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet } from "@/lib/client/wallet";
import { fmtRate, fmtUsd, shortAddress } from "@/lib/shared/format";

type Tone = "up" | "warn" | "down" | "mint" | "neutral";

function Row({ name, state, tone, detail }: { name: string; state: string; tone: Tone; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-fg">{name}</p>
        {detail ? <p className="mt-0.5 text-[13px] text-fg-3">{detail}</p> : null}
      </div>
      <Badge tone={tone}>{state}</Badge>
    </div>
  );
}

export default function StatusPage() {
  const { data: s, error, refetch } = useStatus();
  const w = useWallet();
  const session = useSession();

  return (
    <div className="mx-auto max-w-[640px] space-y-5">
      <PageHeader
        title="Status"
        subtitle="Live state of every integration on this deployment."
        back={
          <Link href="/" aria-label="Back" className="grid size-11 place-items-center rounded-full bg-surface shadow-[var(--shadow-card)]">
            <ArrowLeft className="size-5" />
          </Link>
        }
      />
      {error ? (
        <Card>
          <ErrorState message={error.message} onRetry={refetch} />
        </Card>
      ) : !s ? (
        <Skeleton className="h-64 w-full rounded-[24px]" />
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardHeader title="Account & platform" />
            <div className="divide-y divide-line">
              <Row
                name="Nimiq Pay"
                state={w.host === "nimiq-pay" ? "Connected" : w.host === "detecting" ? "Detecting" : "Not in app"}
                tone={w.host === "nimiq-pay" ? "up" : "neutral"}
                detail={w.host === "browser" ? "Running in a browser — sign in by approving in Nimiq Pay." : `Host network: ${w.hostNetwork ?? "unknown"} · AuraPay expects ${s.nimiq.network}`}
              />
              <Row
                name="Wallet sign-in"
                state={session.user ? "Signed in" : "Signed out"}
                tone={session.user ? "up" : "neutral"}
                detail={session.user ? `${shortAddress(session.user.address, 9, 6)} · ${session.user.evmAddresses.length ? "EVM wallet verified" : "EVM wallet not linked"}` : "Nimiq Pay signature required."}
              />
              <Row
                name="Database"
                state={s.database.ok ? s.database.kind : "Error"}
                tone={s.database.ok ? (s.database.persistent ? "up" : "warn") : "down"}
                detail={s.database.ok ? (s.database.persistent ? "Persistent storage." : "In-memory — local development only.") : s.database.error}
              />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Integrations" />
            <div className="divide-y divide-line">
              <Row
                name={`${s.utilities.provider === "reloadly" ? "Reloadly" : "Flutterwave"} · utilities`}
                state={s.utilities.state === "disconnected" ? "Disconnected" : s.utilities.state === "sandbox" ? "Test mode" : "Live"}
                tone={s.utilities.state === "production" ? "up" : s.utilities.state === "sandbox" ? "mint" : "down"}
                detail={s.utilities.reason ?? (s.utilities.state === "sandbox" ? "Test keys — nothing is delivered." : "Live airtime, data and electricity.")}
              />
              <Row
                name="Exchange rates"
                state={s.rates.state === "live" ? "Live" : "Unavailable"}
                tone={s.rates.state === "live" ? "up" : "down"}
                detail={s.rates.state === "live" ? `CoinGecko · 1 NIM = $${fmtRate(s.rates.nimUsd ?? 0)} · 1 USDT = ${fmtUsd(s.rates.usdtUsd)}` : s.rates.reason}
              />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Payment methods" />
            <div className="divide-y divide-line">
              {(["NIM", "USDT"] as const).map((c) => (
                <Row
                  key={c}
                  name={c === "NIM" ? "NIM · Nimiq" : "USDT · Polygon"}
                  state={s.rails[c].available ? "Available" : "Off"}
                  tone={s.rails[c].available ? "up" : "neutral"}
                  detail={s.rails[c].reason}
                />
              ))}
            </div>
            <div className="border-t border-line px-5 py-2">
              <KV k="NIM merchant" v={<span className="font-mono text-xs">{shortAddress(s.merchant.nimAddress, 9, 9)}</span>} />
              <KV k="Polygon merchant" v={<span className="font-mono text-xs">{shortAddress(s.merchant.polygonAddress, 8, 6)}</span>} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
