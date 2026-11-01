"use client";

import { useCallback } from "react";
import { fmtMoney } from "@/lib/shared/format";
import { api } from "./api";
import { useApi } from "./hooks";
import { useSession } from "./session";

export const DISPLAY_CURRENCIES = [
  { code: "USD", label: "US dollar", flag: "🇺🇸" },
  { code: "NGN", label: "Nigerian naira", flag: "🇳🇬" },
  { code: "GHS", label: "Ghanaian cedi", flag: "🇬🇭" },
  { code: "KES", label: "Kenyan shilling", flag: "🇰🇪" },
  { code: "UGX", label: "Ugandan shilling", flag: "🇺🇬" },
] as const;

interface RatesResponse {
  nimUsd: number;
  usdtUsd: number;
  fiat: { currency: string; perUsd: number | null; source: string | null } | null;
}

/** Amounts in the user's display currency, from live NIM/USDT and USD→local rates. */
export function useMoney() {
  const session = useSession();
  const currency = session.user?.displayCurrency ?? "USD";
  const q = useApi<RatesResponse>(`/api/rates?fiat=${currency}`, { pollMs: 120_000 });
  const perUsd = currency === "USD" ? 1 : (q.data?.fiat?.perUsd ?? null);

  const usdOf = useCallback(
    (amount: number | null | undefined, unit: "NIM" | "USDT" | "USD"): number | null => {
      if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
      if (unit === "USD") return amount;
      const rate = unit === "NIM" ? q.data?.nimUsd : q.data?.usdtUsd;
      return rate ? amount * rate : null;
    },
    [q.data],
  );

  /** Formats a USD value in the display currency (null if the rate is unavailable). */
  const local = useCallback(
    (usd: number | null | undefined, digits = currency === "USD" ? 2 : 0): string | null => {
      if (usd === null || usd === undefined || perUsd === null) return null;
      return fmtMoney(usd * perUsd, currency, digits);
    },
    [perUsd, currency],
  );

  const setCurrency = useCallback(
    async (c: string) => {
      await api("/api/me/display-currency", { method: "POST", json: { currency: c } });
      await session.refresh();
    },
    [session],
  );

  return { currency, perUsd, rates: q.data ?? null, usdOf, local, setCurrency, rateSource: q.data?.fiat?.source ?? null };
}
