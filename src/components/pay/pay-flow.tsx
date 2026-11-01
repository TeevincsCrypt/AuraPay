"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, Lightbulb, Phone, Smartphone, Wifi, Zap, Star, Trash2 } from "lucide-react";
import { api, ApiError, newRequestId } from "@/lib/client/api";
import { useApi, useStatus } from "@/lib/client/hooks";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { countryByCode, TARGET_COUNTRIES, type TargetCountry } from "@/lib/shared/countries";
import { fmtCrypto, fmtMoney, fmtNum, fmtUsd } from "@/lib/shared/format";
import type { BillerDTO, CountryServices, OperatorDTO, PayCurrency, UtilityOrderDTO, UtilityService } from "@/lib/shared/types";
import { ORDER_STATUS_LABEL, TERMINAL_ORDER_STATUSES } from "../status-pill";
import { Button, Card, cx, EmptyState, ErrorState, Field, Input, Keypad, KV, Notice, PageHeader, Skeleton, SlideToConfirm, Spinner, TestBadge } from "../ui";
import { OrderReceipt } from "./receipt";

type Step = "country" | "service" | "details" | "review" | "processing" | "result";

interface CountriesResponse {
  environment: "sandbox" | "production";
  countries: (TargetCountry & { services: CountryServices | null; error: string | null })[];
}

interface Beneficiary {
  id: string;
  kind: "phone" | "meter";
  countryCode: string;
  label: string;
  value: string;
  operatorId: number | null;
  operatorName: string | null;
}

const SERVICE_META: Record<UtilityService, { label: string; icon: typeof Phone; blurb: string }> = {
  airtime: { label: "Airtime", icon: Smartphone, blurb: "Top up any prepaid line" },
  data: { label: "Mobile data", icon: Wifi, blurb: "Data bundles from local operators" },
  electricity: { label: "Electricity", icon: Lightbulb, blurb: "Prepaid tokens & bill payments" },
};

const PENDING_KEY = "aurapay.pendingPayment";

function savePending(v: { orderId: string; txHash?: string } | null) {
  try {
    if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}
function loadPending(): { orderId: string; txHash?: string } | null {
  try {
    const v = localStorage.getItem(PENDING_KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

export function PayFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: status } = useStatus();
  const countriesQ = useApi<CountriesResponse>("/api/utilities/countries");
  const beneficiariesQ = useApi<{ beneficiaries: Beneficiary[] }>("/api/beneficiaries");

  const [step, setStep] = useState<Step>("country");
  const [country, setCountry] = useState<string | null>(null);
  // Deep links from Home quick actions: /pay?service=airtime
  const [service, setService] = useState<UtilityService | null>(() => {
    const s = params.get("service");
    return s === "airtime" || s === "data" || s === "electricity" ? s : null;
  });
  const [prefill, setPrefill] = useState<Beneficiary | null>(null);
  const [order, setOrder] = useState<UtilityOrderDTO | null>(null);

  // Quick Pay deep link from Home: /pay?beneficiary=<id>
  useEffect(() => {
    const id = params.get("beneficiary");
    if (!id) return;
    let alive = true;
    api<{ beneficiaries: Beneficiary[] }>("/api/beneficiaries")
      .then((r) => {
        const b = r.beneficiaries.find((x) => x.id === id);
        if (!alive || !b) return;
        setCountry(b.countryCode);
        setService(b.kind === "meter" ? "electricity" : "airtime");
        setPrefill(b);
        setStep("details");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [params]);

  // Resume a payment that was submitted to the wallet but not yet registered/confirmed.
  useEffect(() => {
    const pending = loadPending();
    if (!pending) return;
    (async () => {
      try {
        const r = pending.txHash
          ? await api<{ order: UtilityOrderDTO }>(`/api/orders/${pending.orderId}/payment`, { method: "POST", json: { txHash: pending.txHash } })
          : await api<{ order: UtilityOrderDTO }>(`/api/orders/${pending.orderId}`);
        if (r.order.status === "quoted" || r.order.status === "expired") {
          savePending(null);
          return;
        }
        setOrder(r.order);
        setStep(TERMINAL_ORDER_STATUSES.includes(r.order.status) ? "result" : "processing");
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.code === "TX_ALREADY_USED")) savePending(null);
      }
    })();
  }, []);

  const countryInfo = countriesQ.data?.countries.find((c) => c.code === country);
  const environment = countriesQ.data?.environment ?? (status?.reloadly.state === "production" ? "production" : "sandbox");

  const reset = () => {
    setStep("country");
    setCountry(null);
    setService(null);
    setOrder(null);
    setPrefill(null);
    savePending(null);
    router.replace("/pay");
  };

  const back = () => {
    if (step === "service") setStep("country");
    else if (step === "details") setStep(countryInfo ? "service" : "country");
    else if (step === "review") setStep("details");
  };

  const disconnected = status?.reloadly.state === "disconnected" || countriesQ.error?.code === "PROVIDER_DISCONNECTED";

  return (
    <div className="mx-auto max-w-[560px]">
      <PageHeader
        title="Pay"
        subtitle="Airtime, data and electricity across Africa — paid with NIM or USDT."
        action={environment === "sandbox" && !disconnected ? <TestBadge /> : undefined}
      />

      {step !== "country" && step !== "processing" && step !== "result" ? (
        <button onClick={back} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg-2">
          <ArrowLeft className="size-4" /> Back
        </button>
      ) : null}

      {disconnected ? (
        <Card className="p-2">
          <EmptyState icon={<Zap className="size-5" />} title="Utility payments are offline">
            The utility provider (Reloadly) isn&apos;t connected on this deployment, so no services can be offered. Add RELOADLY_CLIENT_ID and RELOADLY_CLIENT_SECRET to enable it.
          </EmptyState>
        </Card>
      ) : step === "country" ? (
        <CountryStep
          q={countriesQ}
          beneficiaries={beneficiariesQ.data?.beneficiaries ?? []}
          onRemoveBeneficiary={async (id) => {
            await api(`/api/beneficiaries/${id}`, { method: "DELETE" }).catch(() => {});
            void beneficiariesQ.refetch();
          }}
          onPickBeneficiary={(b) => {
            setCountry(b.countryCode);
            setService(b.kind === "meter" ? "electricity" : "airtime");
            setPrefill(b);
            setStep(b.kind === "meter" ? "details" : "service");
          }}
          onPick={(code) => {
            setCountry(code);
            const info = countriesQ.data?.countries.find((c) => c.code === code);
            if (service && info?.services?.[service]) setStep("details");
            else setStep("service");
          }}
        />
      ) : step === "service" && countryInfo ? (
        <ServiceStep
          country={countryInfo}
          onPick={(s) => {
            setService(s);
            setStep("details");
          }}
        />
      ) : step === "details" && country && service ? (
        <DetailsStep
          key={`${country}-${service}`}
          country={country}
          service={service}
          prefill={prefill}
          onQuoted={(o) => {
            setOrder(o);
            setStep("review");
          }}
        />
      ) : step === "review" && order ? (
        <ReviewStep
          order={order}
          onExpired={() => setStep("details")}
          onSubmitted={(o) => {
            setOrder(o);
            setStep(TERMINAL_ORDER_STATUSES.includes(o.status) ? "result" : "processing");
          }}
        />
      ) : step === "processing" && order ? (
        <ProcessingStep
          order={order}
          onDone={(o) => {
            setOrder(o);
            setStep("result");
            savePending(null);
            void beneficiariesQ.refetch();
          }}
        />
      ) : step === "result" && order ? (
        <Card className="p-5">
          <OrderReceipt order={order} />
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => router.push("/activity")}>
              View activity
            </Button>
            <Button onClick={reset}>New payment</Button>
          </div>
        </Card>
      ) : (
        <Card className="p-6">
          <Spinner />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: country
// ---------------------------------------------------------------------------

function ServiceChips({ s }: { s: CountryServices }) {
  const items = (["airtime", "data", "electricity"] as UtilityService[]).filter((k) => s[k]);
  if (!items.length) return <span className="text-xs text-fg-3">No services available</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((k) => (
        <span key={k} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-fg-2">
          {SERVICE_META[k].label}
        </span>
      ))}
    </div>
  );
}

function CountryStep({
  q,
  beneficiaries,
  onPick,
  onPickBeneficiary,
  onRemoveBeneficiary,
}: {
  q: ReturnType<typeof useApi<CountriesResponse>>;
  beneficiaries: Beneficiary[];
  onPick: (code: string) => void;
  onPickBeneficiary: (b: Beneficiary) => void;
  onRemoveBeneficiary: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      {beneficiaries.length ? (
        <section>
          <h2 className="mb-2.5 text-[13px] font-medium text-fg-2">Saved recipients</h2>
          <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {beneficiaries.map((b) => (
              <div key={b.id} className="group relative w-40 shrink-0">
                <button
                  onClick={() => onPickBeneficiary(b)}
                  className="w-full rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong"
                >
                  <div className="flex items-center gap-1.5 text-xs text-fg-3">
                    <span>{countryByCode(b.countryCode)?.flag}</span>
                    {b.kind === "meter" ? "Meter" : "Phone"}
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-fg">{b.label}</p>
                  <p className="truncate font-mono text-[11px] text-fg-3">{b.value}</p>
                </button>
                <button
                  aria-label={`Remove ${b.label}`}
                  onClick={() => onRemoveBeneficiary(b.id)}
                  className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-3 focus:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2.5 text-[13px] font-medium text-fg-2">Where are you sending to?</h2>
        {q.error ? (
          <Card>
            <ErrorState message={q.error.message} onRetry={q.refetch} />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(q.data?.countries ?? TARGET_COUNTRIES.map((c) => ({ ...c, services: null, error: null }))).map((c) => {
              const any = c.services && (c.services.airtime || c.services.data || c.services.electricity);
              return (
                <button
                  key={c.code}
                  disabled={!q.data || !any}
                  onClick={() => onPick(c.code)}
                  className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left transition-colors enabled:hover:border-line-strong enabled:hover:bg-surface-2 disabled:opacity-60"
                >
                  <span className="text-[26px] leading-none" aria-hidden>
                    {c.flag}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-fg">{c.name}</span>
                    <span className="mt-1 block">
                      {!q.data ? (
                        <Skeleton className="h-4 w-28" />
                      ) : c.services ? (
                        <ServiceChips s={c.services} />
                      ) : (
                        <span className="text-xs text-down">{c.error ?? "Unavailable"}</span>
                      )}
                    </span>
                  </span>
                  {any ? <ChevronRight className="size-4 text-fg-3" /> : null}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-fg-3">Services are loaded live from our provider. Only what&apos;s currently available is shown.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: service
// ---------------------------------------------------------------------------

function ServiceStep({ country, onPick }: { country: CountriesResponse["countries"][number]; onPick: (s: UtilityService) => void }) {
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-medium text-fg">
        <span className="text-xl">{country.flag}</span> {country.name}
      </h2>
      <div className="space-y-2">
        {(["airtime", "data", "electricity"] as UtilityService[]).map((s) => {
          const M = SERVICE_META[s];
          const available = Boolean(country.services?.[s]);
          return (
            <button
              key={s}
              disabled={!available}
              onClick={() => onPick(s)}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors enabled:hover:border-line-strong enabled:hover:bg-surface-2 disabled:opacity-50"
            >
              <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent-strong">
                <M.icon className="size-[18px]" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium text-fg">{M.label}</span>
                <span className="block text-xs text-fg-3">{available ? M.blurb : "Not available in this country yet"}</span>
              </span>
              {available ? <ChevronRight className="size-4 text-fg-3" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: details (recipient, operator/biller, amount, payment currency)
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function PayCurrencyPicker({ value, onChange }: { value: PayCurrency | null; onChange: (c: PayCurrency) => void }) {
  const { data: status } = useStatus();
  const w = useWallet();
  const rails = status?.rails;
  const options: { c: PayCurrency; title: string; sub: string; disabled: boolean; reason?: string }[] = [
    {
      c: "NIM",
      title: "Pay with NIM",
      sub: w.nimiq.balanceLuna !== null ? `Balance ${fmtCrypto(w.nimiq.balanceLuna / 1e5, "NIM")}` : "Nimiq",
      disabled: !rails?.NIM.available,
      reason: rails?.NIM.reason,
    },
    {
      c: "USDT",
      title: "Pay with USDT",
      sub: w.evm.usdtBalance !== null ? `Balance ${fmtCrypto(w.evm.usdtBalance, "USDT")}` : "Polygon",
      disabled: !rails?.USDT.available,
      reason: rails?.USDT.reason,
    },
  ];
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Payment currency">
      {options.map((o) => (
        <button
          key={o.c}
          role="radio"
          aria-checked={value === o.c}
          disabled={o.disabled}
          onClick={() => onChange(o.c)}
          className={cx(
            "flex w-full items-center gap-3 rounded-[20px] p-4 text-left ring-1 transition-colors disabled:cursor-not-allowed",
            value === o.c ? "bg-accent-soft ring-accent" : "bg-surface ring-line enabled:hover:ring-line-strong",
          )}
        >
          <span className={cx("grid size-9 shrink-0 place-items-center rounded-full text-[11px] font-bold", o.c === "NIM" ? "bg-[#e9b213]/15 text-[#b8890c]" : "bg-[#26a17b]/15 text-[#1d8463]")}>
            {o.c}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cx("block text-sm font-medium", o.disabled ? "text-fg-3" : "text-fg")}>{o.title}</span>
            <span className="block text-xs text-fg-3">{o.disabled ? o.reason ?? "Unavailable" : o.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function DetailsStep({
  country,
  service,
  prefill,
  onQuoted,
}: {
  country: string;
  service: UtilityService;
  prefill: Beneficiary | null;
  onQuoted: (o: UtilityOrderDTO) => void;
}) {
  const info = countryByCode(country)!;
  const w = useWallet();
  const session = useSession();
  const isPhone = service !== "electricity";

  const [recipient, setRecipient] = useState(prefill?.value ? (isPhone ? prefill.value.replace(new RegExp(`^${info.dialCode}`), "") : prefill.value) : "");
  const [chosenOperatorId, setOperatorId] = useState<number | null>(prefill?.operatorId ?? null);
  const [productAmount, setProductAmount] = useState<number | null>(null);
  const [amountText, setAmountText] = useState("");
  const [payCurrency, setPayCurrency] = useState<PayCurrency | null>(null);
  const [save, setSave] = useState(false);
  const [label, setLabel] = useState(prefill?.label ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());

  const opsQ = useApi<{ operators: OperatorDTO[] }>(isPhone ? `/api/utilities/operators?country=${country}&service=${service}` : null);
  const billersQ = useApi<{ billers: BillerDTO[] }>(!isPhone ? `/api/utilities/billers?country=${country}` : null);

  const debounced = useDebounced(recipient, 500);
  const detectQ = useApi<{ valid: boolean; e164: string | null; national?: string; operator: OperatorDTO | null }>(
    isPhone && debounced.replace(/\D/g, "").length >= 7 ? `/api/utilities/detect?country=${country}&phone=${encodeURIComponent(debounced)}` : null,
  );

  const operators = useMemo(() => opsQ.data?.operators ?? [], [opsQ.data]);

  // Until the user picks one, default to the detected operator (or its data counterpart, same brand).
  const detectedPickId = useMemo(() => {
    const d = detectQ.data?.operator;
    if (!d) return null;
    const exact = operators.find((o) => o.id === d.id);
    const brand = d.name.split(" ")[0]?.toLowerCase();
    const sibling = brand ? operators.find((o) => o.name.toLowerCase().startsWith(brand)) : undefined;
    return (exact ?? sibling)?.id ?? null;
  }, [detectQ.data, operators]);
  const operatorId = chosenOperatorId ?? detectedPickId;

  const operator = operators.find((o) => o.id === operatorId) ?? null;
  const biller = billersQ.data?.billers.find((b) => b.id === operatorId) ?? null;

  const useLocal = isPhone ? Boolean(operator?.denominationType === "RANGE" && operator.supportsLocalAmounts && operator.fxRate) : true;
  const typedAmount = Number(amountText.replace(/,/g, ""));

  const amount = isPhone && operator?.denominationType === "FIXED" ? productAmount : Number.isFinite(typedAmount) && typedAmount > 0 ? typedAmount : null;
  const currencyLabel = isPhone ? (useLocal ? operator?.localCurrency : operator?.senderCurrency) : biller?.localCurrency;

  // Live USD estimate for display only (the server re-prices authoritatively).
  const estUsd = useMemo(() => {
    if (!amount) return null;
    if (isPhone) {
      if (!operator) return null;
      if (operator.denominationType === "FIXED") return amount;
      return useLocal && operator.fxRate ? amount / operator.fxRate : amount;
    }
    if (!biller?.fxRate) return null;
    return (amount + (biller.localFee ?? 0)) / biller.fxRate;
  }, [amount, isPhone, operator, biller, useLocal]);

  const phoneValid = !isPhone || detectQ.data?.valid;
  const canContinue = Boolean(recipient && operatorId && amount && payCurrency && (isPhone ? phoneValid : recipient.replace(/\s/g, "").length >= 6));

  const presets = useMemo(() => {
    if (!operator || operator.denominationType !== "RANGE") return [];
    if (useLocal) {
      const min = operator.localMinAmount ?? 0;
      const base = [100, 200, 500, 1000, 2000, 5000].map((x) => (min > 500 ? x * 10 : x));
      return base.filter((x) => x >= min && (operator.localMaxAmount === null || x <= operator.localMaxAmount)).slice(0, 4);
    }
    const s = operator.suggestedAmounts.length ? operator.suggestedAmounts : [2, 5, 10, 20];
    return s.filter((x) => (operator.minAmount === null || x >= operator.minAmount) && (operator.maxAmount === null || x <= operator.maxAmount)).slice(0, 4);
  }, [operator, useLocal]);

  const submit = async () => {
    if (!operatorId || !amount || !payCurrency) return;
    setError(null);
    setSubmitting(true);
    try {
      let payerAddress: string | undefined;
      if (payCurrency === "USDT") {
        payerAddress = session.user?.evmAddresses[0] ?? (await w.linkEvm().then(async (a) => (await session.refresh(), a)));
      }
      if (payCurrency === "NIM" && w.nimiq.status !== "connected") await w.connectNimiq();
      const r = await api<{ order: UtilityOrderDTO }>("/api/orders", {
        method: "POST",
        json: {
          clientRequestId: requestId.current,
          service,
          countryCode: country,
          operatorId,
          recipient: isPhone ? (detectQ.data?.e164 ?? recipient) : recipient,
          recipientLabel: label || undefined,
          amount,
          amountCurrency: isPhone ? (operator?.denominationType === "FIXED" || !useLocal ? "sender" : "local") : "local",
          payCurrency,
          payerAddress,
          saveBeneficiary: save,
        },
      });
      onQuoted(r.order);
      requestId.current = newRequestId();
    } catch (e) {
      setError(e instanceof WalletActionError && e.kind === "rejected" ? null : (e as Error).message);
      // A failed quote must not reuse the same idempotency key with different inputs.
      requestId.current = newRequestId();
    } finally {
      setSubmitting(false);
    }
  };

  const listQ = isPhone ? opsQ : billersQ;

  return (
    <div className="space-y-5">
      <h2 className="flex items-center gap-2 text-[15px] font-medium text-fg">
        <span className="text-xl">{info.flag}</span> {SERVICE_META[service].label} · {info.name}
      </h2>

      {isPhone ? (
        <Field
          label="Recipient phone number"
          htmlFor="phone"
          error={detectQ.data && !detectQ.data.valid && recipient.length > 6 ? `That doesn't look like a valid ${info.name} number.` : null}
          hint={detectQ.data?.valid ? `✓ ${detectQ.data.national}${detectQ.data.operator ? ` · ${detectQ.data.operator.name}` : ""}` : "We'll detect the operator automatically."}
        >
          <Input id="phone" inputMode="tel" autoComplete="tel" placeholder="801 234 5678" lead={`+${info.dialCode}`} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        </Field>
      ) : null}

      <Field label={isPhone ? "Operator" : "Electricity provider"}>
        {listQ.loading && !listQ.data ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : listQ.error ? (
          <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={listQ.refetch}>Retry</Button>}>
            {listQ.error.message}
          </Notice>
        ) : (isPhone ? operators : billersQ.data?.billers ?? []).length === 0 ? (
          <Notice>No {isPhone ? "operators" : "providers"} are available here right now.</Notice>
        ) : (
          <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2">
            {(isPhone ? operators : billersQ.data!.billers).map((o) => {
              const sel = o.id === operatorId;
              const logo = "logoUrl" in o ? o.logoUrl : null;
              return (
                <button
                  key={o.id}
                  onClick={() => {
                    setOperatorId(o.id);
                    setProductAmount(null);
                    setAmountText("");
                  }}
                  className={cx("flex items-center gap-2.5 rounded-xl border p-3 text-left transition-colors", sel ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}
                >
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="" className="size-8 rounded-md bg-white object-contain p-0.5" />
                  ) : (
                    <span className="grid size-8 place-items-center rounded-md bg-surface-3 text-xs font-semibold text-fg-2">{o.name.slice(0, 2)}</span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-fg">{o.name}</span>
                    {"serviceType" in o ? <span className="text-[11px] text-fg-3">{o.serviceType === "POSTPAID" ? "Postpaid" : "Prepaid"}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Field>

      {!isPhone ? (
        <Field label="Meter or account number" htmlFor="meter" hint="Double-check this number — payments to the wrong meter can't be reversed by the provider.">
          <Input id="meter" inputMode="numeric" placeholder="e.g. 04223568280" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        </Field>
      ) : null}

      {/* Amount */}
      {(isPhone && operator) || (!isPhone && biller) ? (
        isPhone && operator!.denominationType === "FIXED" ? (
          <Field label={service === "data" ? "Choose a bundle" : "Choose an amount"}>
            {operator!.products.length === 0 ? (
              <Notice>This operator has no products available.</Notice>
            ) : (
              <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {operator!.products.map((p) => (
                  <button
                    key={p.senderAmount}
                    onClick={() => setProductAmount(p.senderAmount)}
                    className={cx("rounded-xl border p-3 text-left transition-colors", productAmount === p.senderAmount ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}
                  >
                    <span className="block text-[13px] font-medium text-fg">{p.description ?? (p.localAmount ? fmtMoney(p.localAmount, operator!.localCurrency) : fmtUsd(p.senderAmount))}</span>
                    <span className="num mt-0.5 block text-xs text-fg-3">
                      {fmtUsd(p.senderAmount)}
                      {p.localAmount && p.description ? ` · ${fmtMoney(p.localAmount, operator!.localCurrency)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Field>
        ) : (
          <Field
            label={`Amount (${currencyLabel})`}
            htmlFor="amount"
            hint={
              isPhone
                ? useLocal
                  ? `Between ${fmtNum(operator!.localMinAmount)} and ${fmtNum(operator!.localMaxAmount)} ${operator!.localCurrency}`
                  : `Between ${fmtUsd(operator!.minAmount)} and ${fmtUsd(operator!.maxAmount)}`
                : `Between ${fmtNum(biller!.minLocalAmount)} and ${fmtNum(biller!.maxLocalAmount)} ${biller!.localCurrency}${biller!.localFee ? ` · provider fee ${fmtNum(biller!.localFee)} ${biller!.localCurrency}` : ""}`
            }
          >
            <div className="hero-surface rounded-[24px] px-4 py-6 text-center">
              <input
                id="amount"
                inputMode="decimal"
                placeholder="0"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
                className="num w-full bg-transparent text-center text-[38px] font-semibold tracking-[-0.03em] text-fg outline-none placeholder:text-fg-3"
                aria-label={`Amount in ${currencyLabel}`}
              />
              <p className="text-[13px] text-fg-2">{currencyLabel}</p>
            </div>
            <div className="mt-3 sm:hidden">
              <Keypad value={amountText} onChange={setAmountText} maxDecimals={useLocal ? 0 : 2} />
            </div>
            {presets.length ? (
              <div className="mt-3 flex gap-2">
                {presets.map((p) => (
                  <button key={p} onClick={() => setAmountText(String(p))} className="h-9 flex-1 rounded-full bg-surface text-[13px] font-medium text-fg-2 shadow-[var(--shadow-card)]">
                    {useLocal ? fmtNum(p) : `$${p}`}
                  </button>
                ))}
              </div>
            ) : null}
          </Field>
        )
      ) : null}

      {estUsd ? (
        <p className="num -mt-2 text-xs text-fg-3">
          ≈ {fmtUsd(estUsd)} before AuraPay fee. Final price is confirmed on the next screen.
        </p>
      ) : null}

      <Field label="Pay with">
        <PayCurrencyPicker value={payCurrency} onChange={setPayCurrency} />
      </Field>

      <div className="rounded-xl border border-line bg-surface p-3.5">
        <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          <Star className="size-4 text-fg-3" /> Save this recipient
        </label>
        {save ? (
          <div className="mt-2.5">
            <Input placeholder="Name, e.g. Mum" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </div>
        ) : null}
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <Button size="lg" disabled={!canContinue} loading={submitting} onClick={submit}>
        Review payment
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: review & confirm
// ---------------------------------------------------------------------------

function useCountdown(iso: string) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(iso).getTime() - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, new Date(iso).getTime() - Date.now())), 1000);
    return () => clearInterval(t);
  }, [iso]);
  return left;
}

function ReviewStep({ order, onSubmitted, onExpired }: { order: UtilityOrderDTO; onSubmitted: (o: UtilityOrderDTO) => void; onExpired: () => void }) {
  const w = useWallet();
  const { data: status } = useStatus();
  const left = useCountdown(order.quote.expiresAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; unknown?: boolean } | null>(null);
  const country = countryByCode(order.countryCode);
  const q = order.quote;
  const expired = left <= 0;
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  const networkMismatch = q.payCurrency === "NIM" && w.hostNetwork && status && w.hostNetwork !== status.nimiq.network;

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let txHash: string | undefined;
      if (q.payCurrency === "NIM") {
        if (networkMismatch) throw new WalletActionError("failed", `Switch Nimiq Pay to ${status!.nimiq.network} to pay.`);
        txHash = await w.payNim({ recipient: order.payToAddress!, luna: q.payAmountAtomic, memo: order.memo! });
      } else if (q.payCurrency === "USDT") {
        const r = await w.payUsdt({ to: order.payToAddress!, units: q.payAmountAtomic });
        if (order.payerAddress && r.from !== order.payerAddress) {
          throw new WalletActionError("failed", "The paying wallet changed since the quote. Please start again.");
        }
        txHash = r.hash;
      }
      // Remember the tx before telling the server, so a dropped connection can be resumed.
      savePending({ orderId: order.id, txHash });
      const r = await api<{ order: UtilityOrderDTO }>(`/api/orders/${order.id}/payment`, { method: "POST", json: { txHash } });
      onSubmitted(r.order);
    } catch (e) {
      if (e instanceof WalletActionError) {
        if (e.kind !== "rejected") setError({ msg: e.message, unknown: e.kind === "unknown_outcome" });
        else setError({ msg: "Payment cancelled. Nothing was charged." });
      } else if (e instanceof ApiError && e.code === "QUOTE_EXPIRED") {
        setError({ msg: e.message });
      } else {
        setError({ msg: (e as Error).message });
      }
    } finally {
      setBusy(false);
    }
  }, [q, order, w, onSubmitted, networkMismatch, status]);


  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-fg-3">You&apos;re paying</p>
            <p className="num mt-1 text-[30px] font-semibold tracking-[-0.02em] text-fg">
              {fmtCrypto(q.payAmount, q.payCurrency)}
            </p>
            <p className="num text-[13px] text-fg-3">≈ {fmtUsd(q.totalUsd)}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {order.environment === "sandbox" ? <TestBadge /> : null}
          </div>
        </div>

        <div className="mt-4 border-t border-line pt-2">
          <KV k="To" v={`${country?.flag ?? ""} ${order.service === "electricity" ? order.recipient : `+${order.recipient}`}`} />
          <KV k="Provider" v={order.operatorName} />
          {order.productDescription ? <KV k="Product" v={order.productDescription} /> : null}
          {order.amountLocal !== null && order.localCurrency ? <KV k="They receive" v={fmtMoney(order.amountLocal, order.localCurrency)} /> : null}
          <KV k="Provider price" v={fmtUsd(q.providerCostUsd)} />
          <KV k="AuraPay fee" v={fmtUsd(q.serviceFeeUsd)} />
          <KV k="Total" v={fmtUsd(q.totalUsd)} strong />
            <KV k="Exchange rate" v={`1 ${q.payCurrency} = $${q.exchangeRate < 0.01 ? q.exchangeRate.toFixed(6) : q.exchangeRate.toFixed(4)}`} />
          
        </div>
      </Card>

      <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-xs leading-relaxed text-fg-3">
        <p>
          <span className="text-fg-2">Exchange rate.</span> Crypto prices come from CoinGecko and are locked for this quote.
          {q.payCurrency === "NIM" ? " NIM quotes include a small buffer for price movement." : ""}
          {q.payCurrency === "USDT" ? " The last few decimals identify your order so we can match your payment." : ""}
        </p>
        <p>
          <span className="text-fg-2">Fees.</span> The provider price is what our utility partner charges; the AuraPay fee covers conversion and processing.
          {q.payCurrency === "USDT" ? " Your wallet also charges a small Polygon network fee in POL." : ""}
        </p>
        <p>
          <span className="text-fg-2">What happens next.</span> You approve the payment in your wallet. We confirm it on-chain before sending the {order.service === "electricity" ? "payment to your provider" : "top-up"}. If delivery fails, we refund you.
        </p>
      </div>

      {networkMismatch ? (
        <Notice tone="warn">
          Nimiq Pay is on {w.hostNetwork}; this order must be paid on {status!.nimiq.network}.
        </Notice>
      ) : null}
      {q.payCurrency === "NIM" && w.host !== "nimiq-pay" ? <Notice tone="warn">Open AuraPay inside Nimiq Pay to pay with NIM.</Notice> : null}
      {error ? (
        <Notice tone={error.unknown ? "warn" : "error"} title={error.unknown ? "Payment status unknown" : undefined}>
          {error.msg}
        </Notice>
      ) : null}

      {expired ? (
        <Button size="lg" variant="secondary" onClick={onExpired}>
          Quote expired — get a new price
        </Button>
      ) : (
        <>
          <SlideToConfirm label={busy ? "Waiting for your wallet…" : `Slide to pay ${fmtCrypto(q.payAmount, q.payCurrency)}`} loading={busy} disabled={Boolean(error?.unknown) || Boolean(networkMismatch)} onConfirm={() => void confirm()} />
          <p className="num text-center text-xs text-fg-3">
            Price held for {mm}:{String(ss).padStart(2, "0")} · Ref {order.ref}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: processing (server verifies payment, then fulfils)
// ---------------------------------------------------------------------------

function ProcessingStep({ order: initial, onDone }: { order: UtilityOrderDTO; onDone: (o: UtilityOrderDTO) => void }) {
  const [order, setOrder] = useState(initial);
  const [slow, setSlow] = useState(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const onDone = (o: UtilityOrderDTO) => onDoneRef.current(o);
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await api<{ order: UtilityOrderDTO }>(`/api/orders/${initial.id}`);
        if (stopped) return;
        setOrder(r.order);
        if (TERMINAL_ORDER_STATUSES.includes(r.order.status)) {
          onDone(r.order);
          return;
        }
      } catch {
        /* transient; keep polling */
      }
      if (Date.now() - started > 45_000) setSlow(true);
      if (!stopped) setTimeout(tick, Date.now() - started > 120_000 ? 10_000 : 3_000);
    };
    if (TERMINAL_ORDER_STATUSES.includes(initial.status)) onDone(initial);
    else void tick();
    return () => {
      stopped = true;
    };
  }, [initial]);

  const steps: { key: string; label: string; done: boolean; active: boolean }[] = [
    { key: "pay", label: "Payment confirmed on-chain", done: !["quoted", "payment_pending"].includes(order.status), active: order.status === "payment_pending" },
    { key: "send", label: "Sent to provider", done: ["provider_pending", "successful"].includes(order.status), active: ["paid", "fulfilling"].includes(order.status) },
    { key: "deliver", label: order.service === "electricity" ? "Provider confirmation" : "Delivered", done: order.status === "successful", active: order.status === "provider_pending" },
  ];

  return (
    <Card className="p-6">
      <div className="flex flex-col items-center text-center">
        <Spinner className="size-7 text-accent-strong" />
        <p className="mt-3 text-base font-medium text-fg">{ORDER_STATUS_LABEL[order.status]}</p>
        <p className="mt-1 text-[13px] text-fg-3">{order.statusReason ?? "This usually takes a few seconds."}</p>
      </div>
      <ol className="mt-6 space-y-3">
        {steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3 text-sm">
            <span className={cx("grid size-5 place-items-center rounded-full text-[10px]", s.done ? "bg-up text-bg" : s.active ? "border-2 border-accent" : "border border-line-strong")}>
              {s.done ? "✓" : ""}
            </span>
            <span className={s.done ? "text-fg" : s.active ? "text-fg-2" : "text-fg-3"}>{s.label}</span>
          </li>
        ))}
      </ol>
      {slow ? (
        <p className="mt-5 text-center text-xs text-fg-3">
          Taking longer than usual. You can leave this screen — we&apos;ll keep processing and the result will appear in Activity. Ref {order.ref}
        </p>
      ) : null}
    </Card>
  );
}
