"use client";

import { createPortal } from "react-dom";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Loader2, X, AlertTriangle, Info, CheckCircle2 } from "lucide-react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("rounded-[var(--radius-card)] border border-line bg-surface", className)}>{children}</As>;
}

export function CardHeader({ title, action, subtitle }: { title: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-[13px] font-medium tracking-wide text-fg-2">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-fg-3">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between px-0.5">
      <h2 className="text-[13px] font-medium text-fg-2">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-fg-2">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px bg-line", className)} />;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

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
    "inline-flex items-center justify-center gap-2 font-medium rounded-[var(--radius-control)] transition-colors select-none disabled:opacity-45 disabled:cursor-not-allowed";
  const sizes = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm", lg: "h-12 px-5 text-[15px] w-full" };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-white hover:bg-accent-strong active:bg-accent",
    secondary: "bg-surface-3 text-fg hover:bg-[#232330] border border-line",
    ghost: "text-fg-2 hover:text-fg hover:bg-surface-2",
    danger: "bg-down-soft text-down hover:bg-[rgb(248_113_113/0.2)]",
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badges (labels for demo / simulated / test data are mandatory, not decorative)
// ---------------------------------------------------------------------------

type Tone = "neutral" | "accent" | "up" | "down" | "warn" | "mint";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-2 border-line",
  accent: "bg-accent-soft text-accent-strong border-[rgb(139_124_246/0.25)]",
  up: "bg-up-soft text-up border-[rgb(52_211_153/0.25)]",
  down: "bg-down-soft text-down border-[rgb(248_113_113/0.25)]",
  warn: "bg-warn-soft text-warn border-[rgb(251_191_36/0.25)]",
  mint: "bg-mint-soft text-mint border-[rgb(79_209_197/0.25)]",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export const DemoBadge = () => <Badge tone="warn">Demo data</Badge>;
export const SimulatedBadge = () => <Badge tone="warn">Simulated</Badge>;
export const TestBadge = () => <Badge tone="mint">Test · Sandbox</Badge>;

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export function Notice({ tone = "info", title, children, action, className }: { tone?: "info" | "warn" | "error" | "success"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const map = {
    info: { cls: "border-line bg-surface-2 text-fg-2", Icon: Info, icon: "text-fg-3" },
    warn: { cls: "border-[rgb(251_191_36/0.2)] bg-warn-soft text-fg-2", Icon: AlertTriangle, icon: "text-warn" },
    error: { cls: "border-[rgb(248_113_113/0.22)] bg-down-soft text-fg-2", Icon: AlertTriangle, icon: "text-down" },
    success: { cls: "border-[rgb(52_211_153/0.22)] bg-up-soft text-fg-2", Icon: CheckCircle2, icon: "text-up" },
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed", map.cls, className)}>
      <map.Icon className={cx("mt-0.5 size-4 shrink-0", map.icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
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
    <div className="flex h-12 items-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-surface-2 px-3.5 focus-within:border-accent">
      {lead ? <span className="shrink-0 text-sm text-fg-3">{lead}</span> : null}
      <input className={cx("h-full w-full min-w-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3", className)} {...rest} />
      {trail ? <span className="shrink-0 text-sm text-fg-3">{trail}</span> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; className?: string }) {
  return (
    <div role="radiogroup" className={cx("inline-flex rounded-[var(--radius-control)] border border-line bg-surface-2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-8 flex-1 rounded-[8px] px-3 text-[13px] font-medium transition-colors disabled:opacity-40",
            value === o.value ? "bg-surface-3 text-fg shadow-[0_0_0_1px_var(--color-line-strong)]" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-surface-3", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-fg-3", className)} aria-label="Loading" />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon ? <div className="mb-3 grid size-11 place-items-center rounded-full bg-surface-3 text-fg-3">{icon}</div> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
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
    <div className={cx("flex items-start justify-between gap-4 py-2 text-[13px]", className)}>
      <span className="text-fg-3">{k}</span>
      <span className={cx("num text-right", strong ? "font-semibold text-fg" : "text-fg-2")}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet: bottom sheet on mobile, centred dialog on desktop
// ---------------------------------------------------------------------------

export function Sheet({ open, onClose, title, children, footer, dismissible = true }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; dismissible?: boolean }) {
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
  // Portal to <body>: ancestors with backdrop-filter/transform (e.g. the sticky header)
  // would otherwise become the containing block for this fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 bg-black/65 backdrop-blur-[2px] animate-fade-in" onClick={() => dismissible && onClose()} tabIndex={-1} />
      <div className="relative flex max-h-[92dvh] w-full flex-col rounded-t-[20px] border border-line-strong bg-surface animate-sheet-in sm:max-w-[440px] sm:rounded-[18px]">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          {dismissible ? (
            <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-surface-3 hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div className="overflow-y-auto px-5 pb-4">{children}</div>
        {footer ? <div className="border-t border-line px-5 pt-3 pb-[calc(12px+var(--safe-bottom))]">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
