"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DISPLAY_CURRENCIES, useMoney } from "@/lib/client/money";
import { cx, Sheet } from "./ui";

/** Chip that opens a sheet to choose the display currency. */
export function CurrencyPicker({ className }: { className?: string }) {
  const m = useMoney();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Display currency: ${m.currency}`}
        className={cx("inline-flex h-7 items-center gap-1 rounded-full bg-white/80 px-2.5 text-[12px] font-semibold text-fg-2 shadow-[var(--shadow-card)]", className)}
      >
        {m.currency} <ChevronDown className="size-3.5" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Show amounts in">
        <div className="divide-y divide-line pb-2">
          {DISPLAY_CURRENCIES.map((c) => (
            <button
              key={c.code}
              disabled={busy !== null}
              onClick={async () => {
                setBusy(c.code);
                try {
                  await m.setCurrency(c.code);
                  setOpen(false);
                } finally {
                  setBusy(null);
                }
              }}
              className="flex w-full items-center gap-3 py-3 text-left"
            >
              <span className="text-xl" aria-hidden>
                {c.flag}
              </span>
              <span className="flex-1">
                <span className="block text-[15px] font-medium text-fg">{c.code}</span>
                <span className="block text-xs text-fg-3">{c.label}</span>
              </span>
              {m.currency === c.code ? <Check className="size-5 text-accent" /> : busy === c.code ? <span className="text-xs text-fg-3">Saving…</span> : null}
            </button>
          ))}
        </div>
        <p className="pb-2 text-xs text-fg-3">Local amounts use the live rate our bill partner prices at (or CoinGecko). Payments are still made in NIM or USDT.</p>
      </Sheet>
    </>
  );
}
