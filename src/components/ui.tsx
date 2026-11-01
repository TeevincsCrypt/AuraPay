"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Loader2, X, AlertTriangle, Info, CheckCircle2, Delete, ArrowRight, ChevronsRight } from "lucide-react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-card)]", className)}>{children}</As>;
}

export function CardHeader({ title, action, subtitle }: { title: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-fg-3">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between px-1">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, action, back }: { title: string; subtitle?: ReactNode; action?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-5 flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {back}
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-fg">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm text-fg-2">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </header>
  );
}

export function IconButton({ children, label, onClick, className }: { children: ReactNode; label: string; onClick?: () => void; className?: string }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cx("grid size-11 shrink-0 place-items-center rounded-full bg-surface text-fg shadow-[var(--shadow-card)] transition-transform active:scale-95", className)}
    >
      {children}
    </button>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px bg-line", className)} />;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dark";

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const base =
    "inline-flex items-center justify-center gap-2 font-medium rounded-full transition-[background,transform] select-none active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100";
  const sizes = { sm: "h-9 px-4 text-[13px]", md: "h-11 px-5 text-sm", lg: "h-14 px-6 text-[16px] w-full" };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-white hover:bg-accent-strong",
    secondary: "bg-surface-2 text-fg hover:bg-surface-3",
    ghost: "text-fg-2 hover:text-fg hover:bg-surface-2",
    danger: "bg-down-soft text-down hover:bg-[#fbdedc]",
    dark: "bg-fg text-white hover:bg-[#2a2a2a]",
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Round white action with a label underneath. */
export function CircleAction({ icon, label, href, onClick }: { icon: ReactNode; label: string; href?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="grid size-[54px] place-items-center rounded-full bg-surface text-fg shadow-[var(--shadow-card)] transition-transform group-active:scale-95">{icon}</span>
      <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
    </>
  );
  const cls = "group flex flex-col items-center gap-2";
  return href ? (
    <a href={href} className={cls}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Avatars (deterministic from an address or name — no external images)
// ---------------------------------------------------------------------------

function hashString(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function Avatar({ seed, label, size = 44, className }: { seed: string; label?: string; size?: number; className?: string }) {
  const h = hashString(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >> 9) % 60)) % 360;
  const text = (label ?? seed).replace(/^NQ\d\d\s?/, "").replace(/\s/g, "").slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-full font-semibold text-white", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(135deg, hsl(${hue1} 72% 62%), hsl(${hue2} 70% 52%))`,
      }}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

type Tone = "neutral" | "accent" | "up" | "down" | "warn" | "mint";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2",
  accent: "bg-accent-soft text-accent-strong",
  up: "bg-up-soft text-up",
  down: "bg-down-soft text-down",
  warn: "bg-warn-soft text-warn",
  mint: "bg-mint-soft text-mint",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cx("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

/** Provider test-mode transactions are test transactions and must be labelled. */
export const TestBadge = () => <Badge tone="mint">Test · Sandbox</Badge>;

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export function Notice({ tone = "info", title, children, action, className }: { tone?: "info" | "warn" | "error" | "success"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const map = {
    info: { cls: "bg-surface-2 text-fg-2", Icon: Info, icon: "text-fg-3" },
    warn: { cls: "bg-warn-soft text-fg-2", Icon: AlertTriangle, icon: "text-warn" },
    error: { cls: "bg-down-soft text-fg-2", Icon: AlertTriangle, icon: "text-down" },
    success: { cls: "bg-up-soft text-fg-2", Icon: CheckCircle2, icon: "text-up" },
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-3 rounded-[18px] px-4 py-3.5 text-[13px] leading-relaxed", map.cls, className)}>
      <map.Icon className={cx("mt-0.5 size-4 shrink-0", map.icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-fg">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
        {action ? <div className="mt-2.5">{action}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg-2">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-down">{error}</p> : hint ? <p className="text-xs text-fg-3">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, lead, trail, ...rest }: InputHTMLAttributes<HTMLInputElement> & { lead?: ReactNode; trail?: ReactNode }) {
  return (
    <div className="flex h-14 items-center gap-2 rounded-[var(--radius-control)] bg-surface-2 px-4 ring-1 ring-transparent transition focus-within:bg-surface focus-within:ring-accent">
      {lead ? <span className="shrink-0 text-[15px] text-fg-3">{lead}</span> : null}
      <input className={cx("h-full w-full min-w-0 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-3", className)} {...rest} />
      {trail ? <span className="shrink-0 text-sm text-fg-3">{trail}</span> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; className?: string }) {
  return (
    <div role="radiogroup" className={cx("inline-flex gap-1 rounded-full bg-surface-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-9 flex-1 rounded-full px-4 text-[13px] font-semibold transition-colors disabled:opacity-40",
            value === o.value ? "bg-peach text-fg" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Horizontal pill chips for filters. */
export function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:px-0">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-9 shrink-0 rounded-full px-4 text-[13px] font-medium transition-colors",
            value === o.value ? "bg-fg text-white" : "bg-surface text-fg-2 shadow-[var(--shadow-card)] hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keypad + slide-to-confirm
// ---------------------------------------------------------------------------

export function Keypad({ value, onChange, maxDecimals = 2, maxLength = 10 }: { value: string; onChange: (v: string) => void; maxDecimals?: number; maxLength?: number }) {
  const press = (k: string) => {
    if (k === "del") return onChange(value.slice(0, -1));
    if (k === ".") {
      if (maxDecimals === 0 || value.includes(".")) return;
      return onChange(value === "" ? "0." : value + ".");
    }
    const [, dec] = value.split(".");
    if (dec !== undefined && dec.length >= maxDecimals) return;
    if (value.replace(".", "").length >= maxLength) return;
    onChange(value === "0" ? k : value + k);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];
  return (
    <div className="grid grid-cols-3 gap-2" aria-label="Amount keypad">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => press(k)}
          aria-label={k === "del" ? "Delete" : `Key ${k}`}
          className="grid h-[52px] place-items-center rounded-2xl bg-surface-2 text-[21px] font-medium text-fg transition-colors active:bg-surface-3"
        >
          {k === "del" ? <Delete className="size-5" /> : k}
        </button>
      ))}
    </div>
  );
}

/** Drag the knob to the end to confirm. Keyboard users can press Enter/Space on the knob. */
export function SlideToConfirm({ label, onConfirm, disabled, loading }: { label: string; onConfirm: () => void; disabled?: boolean; loading?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);
  const KNOB = 48;
  const max = () => (track.current ? track.current.clientWidth - KNOB - 8 : 0);
  const shownX = loading || dragging ? x : 0;

  const end = () => {
    setDragging(false);
    if (x >= max() * 0.9) {
      setX(max());
      onConfirm();
    } else setX(0);
  };

  return (
    <div
      ref={track}
      className={cx("relative h-14 w-full select-none overflow-hidden rounded-full bg-accent", (disabled || loading) && "opacity-60")}
      onPointerMove={(e) => dragging && setX(Math.max(0, Math.min(max(), e.clientX - start.current)))}
      onPointerUp={end}
      onPointerCancel={() => {
        setDragging(false);
        setX(0);
      }}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent-strong" style={{ width: shownX + KNOB + 8 }} />
      <span className="pointer-events-none absolute inset-0 grid place-items-center text-[16px] font-medium text-white">
        <span className="flex items-center gap-2">
          {label}
          {!loading ? <ChevronsRight className="size-4 opacity-70" /> : null}
        </span>
      </span>
      <button
        type="button"
        disabled={disabled || loading}
        aria-label={label}
        className="absolute top-1 left-1 grid size-12 touch-none place-items-center rounded-full bg-white text-accent shadow-sm disabled:cursor-not-allowed"
        style={{ transform: `translateX(${shownX}px)`, transition: dragging ? "none" : "transform 220ms ease" }}
        onPointerDown={(e) => {
          if (disabled || loading) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          start.current = e.clientX - x;
          setDragging(true);
        }}
        onKeyDown={(e) => {
          if (!disabled && !loading && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onConfirm();
          }
        }}
      >
        {loading ? <Loader2 className="size-5 animate-spin" /> : <ArrowRight className="size-5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-xl bg-surface-3", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-fg-3", className)} aria-label="Loading" />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon ? <div className="mb-3 grid size-12 place-items-center rounded-full bg-peach text-accent">{icon}</div> : null}
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      {children ? <p className="mt-1 max-w-xs text-[13px] text-fg-3">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <AlertTriangle className="mb-2 size-5 text-down" aria-hidden />
      <p className="max-w-sm text-[13px] text-fg-2">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Change({ value, percent, className }: { value?: number | null; percent?: number | null; className?: string }) {
  const v = percent ?? value;
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className={cx("text-fg-3", className)}>—</span>;
  const up = v > 0;
  const flat = v === 0;
  return (
    <span className={cx("num font-medium", flat ? "text-fg-3" : up ? "text-up" : "text-down", className)}>
      {up ? "+" : ""}
      {percent !== undefined && percent !== null ? `${percent.toFixed(2)}%` : value!.toFixed(2)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function KV({ k, v, strong, className }: { k: ReactNode; v: ReactNode; strong?: boolean; className?: string }) {
  return (
    <div className={cx("flex items-start justify-between gap-4 py-2.5 text-[14px]", className)}>
      <span className="text-fg-3">{k}</span>
      <span className={cx("num text-right", strong ? "font-semibold text-fg" : "text-fg")}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet: bottom sheet on mobile, centred dialog on desktop (portalled to <body>)
// ---------------------------------------------------------------------------

export function Sheet({ open, onClose, title, children, footer, dismissible = true, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; dismissible?: boolean; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismissible && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, dismissible]);

  if (!open || typeof document === "undefined") return null;
  // Portal to <body>: ancestors with backdrop-filter/transform would otherwise contain this fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 animate-fade-in bg-[rgb(17_17_17/0.35)] backdrop-blur-[3px]" onClick={() => dismissible && onClose()} tabIndex={-1} />
      <div className={cx("relative flex max-h-[92dvh] w-full animate-sheet-in flex-col rounded-t-[28px] bg-surface shadow-[var(--shadow-float)] sm:rounded-[28px]", wide ? "sm:max-w-[520px]" : "sm:max-w-[440px]")}>
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-surface-3 sm:hidden" />
        <div className="flex items-center justify-between px-5 pt-3 pb-2">
          <h3 className="text-[17px] font-semibold text-fg">{title}</h3>
          {dismissible ? (
            <button onClick={onClose} className="grid size-9 place-items-center rounded-full bg-surface-2 text-fg-2 hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div className="overflow-y-auto px-5 pb-4">{children}</div>
        {footer ? <div className="px-5 pt-2 pb-[calc(16px+var(--safe-bottom))]">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
