"use client";

import { Badge, Card, CardHeader, ErrorState, KV, PageHeader, Skeleton } from "@/components/ui";
import { useStatus } from "@/lib/client/hooks";
import { useWallet } from "@/lib/client/wallet";
import { fmtUsd, shortAddress } from "@/lib/shared/format";

type Tone = "up" | "warn" | "down" | "mint" | "neutral";

function Row({ name, state, tone, detail }: { name: string; state: string; tone: Tone; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <p className="text-sm text-fg">{name}</p>
        {detail ? <p className="mt-0.5 text-xs text-fg-3">{detail}</p> : null}
      </div>
      <Badge tone={tone}>{state}</Badge>
    </div>
  );
}

export default function StatusPage() {
  const { data: s, error, refetch } = useStatus();
  const w = useWallet();

  return (
    <div className="mx-auto max-w-[640px] space-y-5">
      <PageHeader title="Status" subtitle="What's live, what's in test, and what's simulated on this deployment." />
      {error ? (
        <Card>
          <ErrorState message={error.message} onRetry={refetch} />
        </Card>
      ) : !s ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader title="Environment" />
            <Row
              name="App mode"
              state={s.appMode}
              tone={s.appMode === "production" ? "up" : s.appMode === "sandbox" ? "mint" : "warn"}
              detail={s.simulatorsAllowed ? "Simulators enabled (investing, lending, demo payments). Everything simulated is labelled." : "Simulators disabled."}
            />
            <Row
              name="Database"
              state={s.database.ok ? s.database.kind : "error"}
              tone={s.database.ok ? (s.database.persistent ? "up" : "warn") : "down"}
              detail={s.database.ok ? (s.database.persistent ? "Persistent storage." : "In-memory — data resets on restart.") : s.database.error}
            />
          </Card>

          <Card>
            <CardHeader title="Integrations" />
            <div className="divide-y divide-line">
              <Row
                name="Nimiq Pay"
                state={w.host === "nimiq-pay" ? (w.nimiq.status === "connected" ? "Connected" : "Detected") : w.host === "detecting" ? "Detecting" : "Disconnected"}
                tone={w.host === "nimiq-pay" ? "up" : "neutral"}
                detail={w.host === "browser" ? "Not running inside Nimiq Pay." : `Host network: ${w.hostNetwork ?? "unknown"} · AuraPay expects ${s.nimiq.network}`}
              />
              <Row
                name="Reloadly (utilities)"
                state={s.reloadly.state === "disconnected" ? "Disconnected" : s.reloadly.state === "sandbox" ? "Sandbox" : "Production"}
                tone={s.reloadly.state === "production" ? "up" : s.reloadly.state === "sandbox" ? "mint" : "down"}
                detail={s.reloadly.reason ?? (s.reloadly.state === "sandbox" ? "Test transactions only — nothing is delivered." : "Live delivery.")}
              />
              <Row
                name="Exchange rates"
                state={s.rates.state === "live" ? "Live" : "Unavailable"}
                tone={s.rates.state === "live" ? "up" : "down"}
                detail={s.rates.state === "live" ? `CoinGecko · 1 NIM = $${s.rates.nimUsd?.toFixed(6)} · 1 USDT = ${fmtUsd(s.rates.usdtUsd)}` : s.rates.reason}
              />
              <Row
                name="Market data"
                state={s.marketData.state === "live" ? "Live" : s.marketData.state === "demo" ? "Demo data" : "Unavailable"}
                tone={s.marketData.state === "live" ? "up" : s.marketData.state === "demo" ? "warn" : "down"}
                detail={s.marketData.reason ?? `Provider: ${s.marketData.provider}`}
              />
              <Row name="Stock execution" state={s.brokerage.state === "connected" ? "Connected" : "Unavailable"} tone={s.brokerage.state === "connected" ? "up" : "down"} detail={s.brokerage.reason} />
              <Row
                name="Lending"
                state={s.lending.state === "connected" ? "Connected" : s.lending.state === "simulator" ? "Simulator" : "Unavailable"}
                tone={s.lending.state === "connected" ? "up" : s.lending.state === "simulator" ? "warn" : "down"}
                detail={s.lending.reason}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Payment methods for utilities" />
            <div className="divide-y divide-line">
              {(["NIM", "USDT", "DEMO"] as const).map((c) => (
                <Row
                  key={c}
                  name={c === "DEMO" ? "Simulated payment" : c === "NIM" ? "NIM (Nimiq)" : "USDT (Polygon)"}
                  state={s.rails[c].available ? "Available" : "Off"}
                  tone={s.rails[c].available ? (c === "DEMO" ? "warn" : "up") : "neutral"}
                  detail={s.rails[c].reason}
                />
              ))}
            </div>
            <div className="border-t border-line px-4 py-2 sm:px-5">
              <KV k="NIM merchant" v={<span className="font-mono text-xs">{shortAddress(s.merchant.nimAddress, 9, 9)}</span>} />
              <KV k="Polygon merchant" v={<span className="font-mono text-xs">{shortAddress(s.merchant.polygonAddress, 8, 6)}</span>} />
              <KV k="Polygon RPC" v={s.polygon.rpcUrlHost} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
