"use client";

import { useState } from "react";
import { encodeFunctionData, erc20Abi, parseUnits, type Abi } from "viem";
import { ExternalLink, Landmark, Wallet } from "lucide-react";
import { HealthMeter } from "@/components/charts";
import { StockLogo } from "@/components/invest/stock-row";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, KV, Notice, PageHeader, SectionTitle, Sheet, Skeleton } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { AAVE_CHAIN_HEX, AAVE_MAG7_SPOKE, SPOKE_ABI } from "@/lib/shared/aave";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/shared/format";
import type { BorrowOverviewDTO, LendingReserveDTO } from "@/lib/shared/types";

type Action = "supply" | "withdraw" | "borrow" | "repay";

const spokeAbi = SPOKE_ABI as unknown as Abi;

function healthLabel(hf: number | null): { label: string; tone: "up" | "warn" | "down" | "neutral" } {
  if (hf === null) return { label: "No debt", tone: "neutral" };
  if (hf >= 1.5) return { label: "Healthy", tone: "up" };
  if (hf >= 1.1) return { label: "Watch", tone: "warn" };
  return { label: "At risk", tone: "down" };
}

export default function BorrowPage() {
  const q = useApi<BorrowOverviewDTO>("/api/borrow");
  const session = useSession();
  const w = useWallet();
  const [sheet, setSheet] = useState<{ action: Action; reserve: LendingReserveDTO } | null>(null);
  const [linking, setLinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  const collateral = d?.reserves.filter((r) => r.ticker && r.collateralFactor > 0) ?? [];
  const usdc = d?.reserves.find((r) => r.borrowable && !r.ticker) ?? null;
  const a = d?.account ?? null;
  const h = healthLabel(a?.healthFactor ?? null);
  const verified = session.user?.evmAddresses.length ?? 0;

  return (
    <div className="space-y-7">
      <PageHeader title="Borrow" subtitle="USDC against your stock tokens — without selling them." />

      {q.error ? (
        <Card>
          <ErrorState message={q.error.message} onRetry={q.refetch} />
        </Card>
      ) : !d ? (
        <Skeleton className="h-48 w-full rounded-[32px]" />
      ) : !d.available ? (
        <Notice tone="error" title="Lending unavailable">{d.reason}</Notice>
      ) : (
        <>
          <section className="hero-surface -mx-4 rounded-[32px] px-5 pt-5 pb-6 sm:mx-0">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[15px] text-fg-2">You can borrow</p>
                <p className="num mt-1 text-[36px] font-semibold tracking-[-0.03em] text-fg">{fmtUsd(a?.borrowCapacityUsd ?? 0)}</p>
              </div>
              <Badge tone={h.tone}>{h.label}</Badge>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[
                ["Collateral", fmtUsd(a?.collateralUsd ?? 0)],
                ["Borrowed", fmtUsd(a?.debtUsd ?? 0)],
                ["Health", a?.healthFactor !== null && a?.healthFactor !== undefined ? a.healthFactor.toFixed(2) : "—"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-[18px] bg-white/75 px-3 py-2.5">
                  <p className="text-[11.5px] text-fg-3">{k}</p>
                  <p className="num text-[15px] font-semibold text-fg">{v}</p>
                </div>
              ))}
            </div>
            <div className="mt-5">
              <HealthMeter healthFactor={a?.healthFactor ?? null} />
            </div>
          </section>

          {!w.evm.available ? (
            <Notice tone="warn" title="Open AuraPay in Nimiq Pay">Borrowing is done from your Nimiq Pay EVM wallet on Base.</Notice>
          ) : !verified ? (
            <Notice
              tone="info"
              title="Verify your EVM wallet"
              action={
                <Button
                  size="sm"
                  variant="dark"
                  loading={linking}
                  onClick={async () => {
                    setErr(null);
                    setLinking(true);
                    try {
                      await w.linkEvm();
                      await session.refresh();
                      await q.refetch();
                    } catch (e) {
                      if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr((e as Error).message);
                    } finally {
                      setLinking(false);
                    }
                  }}
                >
                  <Wallet className="size-4" /> Verify wallet
                </Button>
              }
            >
              Sign once so AuraPay can read your Aave position and record your loans.
            </Notice>
          ) : null}
          {err ? <Notice tone="error">{err}</Notice> : null}

          {usdc ? (
            <section>
              <SectionTitle>Your loan</SectionTitle>
              <Card className="p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-full bg-[#2775ca] text-[11px] font-bold text-white">USDC</span>
                  <div className="flex-1">
                    <p className="text-[15px] font-semibold text-fg">USDC on Base</p>
                    <p className="text-[13px] text-fg-3">
                      Variable rate {usdc.borrowApr !== null ? fmtPct(usdc.borrowApr * 100) : "—"} APR
                      {a?.riskPremiumBps ? ` + your risk premium ${fmtPct(a.riskPremiumBps / 100)}` : ""}
                    </p>
                  </div>
                </div>
                <KV k="Outstanding debt" v={`${fmtNum(usdc.debt, 2, 2)} USDC`} strong className="mt-2" />
                <KV k="USDC in wallet" v={`${fmtNum(usdc.walletBalance, 2, 2)} USDC`} />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button disabled={!verified || usdc.paused || usdc.frozen || !(a && a.borrowCapacityUsd > 0)} onClick={() => setSheet({ action: "borrow", reserve: usdc })}>
                    Borrow
                  </Button>
                  <Button variant="secondary" disabled={!verified || usdc.debt <= 0} onClick={() => setSheet({ action: "repay", reserve: usdc })}>
                    Repay
                  </Button>
                </div>
              </Card>
            </section>
          ) : null}

          <section>
            <SectionTitle>Use your stocks as collateral</SectionTitle>
            <Card className="overflow-hidden">
              {collateral.length === 0 ? (
                <EmptyState icon={<Landmark className="size-5" />} title="No collateral assets">Aave hasn&apos;t listed any stock collateral on this market.</EmptyState>
              ) : (
                <ul className="divide-y divide-line py-1">
                  {collateral.map((r) => (
                    <li key={r.reserveId} className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <StockLogo q={{ symbol: r.ticker!, logoUrl: null }} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-semibold text-fg">
                            {r.symbol} {r.usingAsCollateral && r.supplied > 0 ? <Badge tone="up" className="ml-1">Collateral</Badge> : null}
                          </p>
                          <p className="text-[13px] text-fg-3">
                            Borrow up to {fmtPct(r.collateralFactor * 100, { digits: 0 })} of its value · {r.priceUsd !== null ? fmtUsd(r.priceUsd) : "—"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-6">
                        <KV k="In wallet" v={fmtNum(r.walletBalance, 4)} />
                        <KV k="Supplied" v={fmtNum(r.supplied, 4)} />
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Button size="sm" variant="dark" disabled={!verified || r.walletBalance <= 0 || r.paused || r.frozen} onClick={() => setSheet({ action: "supply", reserve: r })}>
                          Add collateral
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!verified || r.supplied <= 0 || r.paused} onClick={() => setSheet({ action: "withdraw", reserve: r })}>
                          Withdraw
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <div className="space-y-2 px-1 text-xs leading-relaxed text-fg-3">
            <p>
              <span className="font-medium text-fg-2">How it works.</span> Your Coinbase stock tokens on Base are supplied to Aave V4&apos;s MAG7 market as collateral; you borrow USDC against them. Everything happens in your own wallet — AuraPay never holds your assets.
            </p>
            <p>
              <span className="font-medium text-fg-2">Liquidation risk.</span> If your health factor falls below 1.0 (for example because stock prices drop), part of your collateral can be sold by liquidators to repay the loan. Keep it comfortably above 1.5.
            </p>
            <p>
              <span className="font-medium text-fg-2">Interest.</span> The variable rate changes with market demand; Aave may add a risk premium based on your collateral. You need a little ETH on Base for network fees.
            </p>
            <a className="inline-flex items-center gap-1 text-accent" href={`https://basescan.org/address/${AAVE_MAG7_SPOKE}`} target="_blank" rel="noreferrer">
              Aave V4 MAG7 contract <ExternalLink className="size-3" />
            </a>
          </div>
        </>
      )}

      {sheet && d?.owner ? (
        <ActionSheet
          action={sheet.action}
          reserve={sheet.reserve}
          owner={d.owner}
          account={d.account}
          usdc={usdc}
          onClose={() => setSheet(null)}
          onDone={() => void q.refetch()}
        />
      ) : null}
    </div>
  );
}

const TITLES: Record<Action, string> = { supply: "Add collateral", withdraw: "Withdraw collateral", borrow: "Borrow USDC", repay: "Repay USDC" };

function ActionSheet({
  action,
  reserve,
  owner,
  account,
  usdc,
  onClose,
  onDone,
}: {
  action: Action;
  reserve: LendingReserveDTO;
  owner: string;
  account: BorrowOverviewDTO["account"];
  usdc: LendingReserveDTO | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const w = useWallet();
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const v = Number(amount);

  const max =
    action === "supply" ? reserve.walletBalance : action === "withdraw" ? reserve.supplied : action === "repay" ? Math.min(reserve.debt, reserve.walletBalance) : account?.borrowCapacityUsd ?? 0;

  // Projected health factor for borrow/withdraw (approximation from account totals).
  let projected: number | null = null;
  if (account && (action === "borrow" || action === "withdraw") && v > 0) {
    const cf = account.avgCollateralFactor ?? reserve.collateralFactor;
    const coll = action === "withdraw" ? account.collateralUsd - v * (reserve.priceUsd ?? 0) : account.collateralUsd;
    const debt = action === "borrow" ? account.debtUsd + v * (usdc?.priceUsd ?? 1) : account.debtUsd;
    projected = debt > 0 ? (coll * cf) / debt : null;
  }
  const risky = projected !== null && projected < 1.25;

  const record = async (a: "approve" | Action | "set_collateral", hash: string, amountAtomic: string | null) => {
    await api("/api/borrow/actions", { method: "POST", json: { action: a, reserveId: reserve.reserveId, owner, txHash: hash, amountAtomic } }).catch(() => {});
  };

  const run = async () => {
    setErr(null);
    try {
      const units = parseUnits(amount, reserve.decimals);
      const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: spokeAbi, functionName: fn, args });
      if (action === "supply" || action === "repay") {
        setStep("Approve token in your wallet…");
        const ap = await w.sendEvmTx({ chainIdHex: AAVE_CHAIN_HEX, to: reserve.underlying, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE_MAG7_SPOKE, units] }) });
        await record("approve", ap.hash, units.toString());
      }
      setStep(`Confirm ${TITLES[action].toLowerCase()} in your wallet…`);
      const tx = await w.sendEvmTx({ chainIdHex: AAVE_CHAIN_HEX, to: AAVE_MAG7_SPOKE, data: call(action, [BigInt(reserve.reserveId), units, owner]) });
      await record(action, tx.hash, units.toString());
      if (action === "supply" && !reserve.usingAsCollateral) {
        setStep("Enable as collateral in your wallet…");
        const c = await w.sendEvmTx({ chainIdHex: AAVE_CHAIN_HEX, to: AAVE_MAG7_SPOKE, data: call("setUsingAsCollateral", [BigInt(reserve.reserveId), true, owner]) });
        await record("set_collateral", c.hash, null);
      }
      setStep(null);
      setDone(true);
      setTimeout(onDone, 4000);
    } catch (e) {
      setStep(null);
      if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr((e as Error).message);
    }
  };

  const unit = action === "borrow" || action === "repay" ? "USDC" : reserve.symbol;
  return (
    <Sheet
      open
      onClose={onClose}
      title={TITLES[action]}
      footer={
        done ? (
          <Button size="lg" onClick={onClose}>Done</Button>
        ) : (
          <Button size="lg" loading={Boolean(step)} disabled={!(v > 0) || v > max + 1e-9 || risky} onClick={run}>
            {step ?? TITLES[action]}
          </Button>
        )
      }
    >
      {done ? (
        <Notice tone="success" title="Submitted">
          Your transaction was sent to Base. We verify it on-chain and it will show in Activity once confirmed.
        </Notice>
      ) : (
        <div className="space-y-4">
          <Field label={`Amount (${unit})`} hint={`Available: ${fmtNum(max, 4)} ${unit}`}>
            <Input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} trail={unit} />
          </Field>
          <div className="flex gap-2">
            {[0.25, 0.5, action === "borrow" ? 0.7 : 1].map((f) => (
              <button key={f} onClick={() => setAmount((Math.floor(max * f * 10 ** Math.min(6, reserve.decimals)) / 10 ** Math.min(6, reserve.decimals)).toString())} className="h-9 flex-1 rounded-full bg-surface-2 text-[13px] font-medium text-fg-2">
                {f === 1 ? "Max" : `${f * 100}%`}
              </button>
            ))}
          </div>
          {projected !== null ? (
            <div className="rounded-[18px] bg-surface-2 px-4 py-1">
              <KV k="Health factor after" v={<span className={risky ? "text-down" : "text-fg"}>{projected.toFixed(2)}</span>} strong />
            </div>
          ) : null}
          {risky ? <Notice tone="error">This would put your position too close to liquidation (health factor below 1.25). Choose a smaller amount.</Notice> : null}
          {action === "supply" ? <p className="text-xs text-fg-3">Three wallet confirmations: approve the token, supply it, then enable it as collateral.</p> : null}
          {action === "repay" ? <p className="text-xs text-fg-3">Two confirmations: approve USDC, then repay. Interest keeps accruing until repaid.</p> : null}
          {err ? <Notice tone="error">{err}</Notice> : null}
        </div>
      )}
    </Sheet>
  );
}
