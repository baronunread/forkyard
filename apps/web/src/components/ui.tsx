import { Loader } from "@cloudflare/kumo";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

/** Join class names, skipping falsy ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const VARIANTS = {
  primary: "bg-ink text-on-ink hover:bg-ink-hover",
  secondary: "bg-surface text-fg shadow-[0_0_0_1px_var(--color-line)] hover:bg-hover",
  ghost: "text-body hover:bg-hover hover:text-fg",
  danger: "bg-bad text-white hover:opacity-90",
} as const;
const SIZES = {
  sm: "h-7 gap-1.5 px-2 text-[13px]",
  md: "h-8 gap-2 px-3",
  lg: "h-10 gap-2 px-3",
  icon: "size-8 justify-center",
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  icon?: ReactNode;
  loading?: boolean;
};

/** The in-app button: flat ink primary, hairline secondary, 6px radius (DESIGN.md). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-link focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader size="sm" /> : icon}
      {children}
    </button>
  );
});

/** Card: white surface held by an inset hairline and a soft stacked shadow. */
export function Card({ className, interactive, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return <div className={cx("rounded-lg bg-surface shadow-card", interactive && "transition-shadow hover:shadow-card-hover", className)} {...rest} />;
}

/** Section heading: sentence case, sans, 14/500. Never uppercase, never mono. */
export function SectionTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cx("text-sm font-medium text-fg", className)} {...rest} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("rounded bg-surface px-1.5 font-mono text-[11px] leading-4 text-body shadow-[0_0_0_1px_var(--color-line)]", className)}>{children}</kbd>;
}

/** Status dot, never alone: always next to a label. */
export function Dot({ color, pulse, className }: { color: string; pulse?: boolean; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", pulse && "animate-blink", className)} style={{ background: color }} />;
}

/** One number on the overview: label, figure, caption. */
export function Stat({ label, value, caption, tone }: { label: string; value: ReactNode; caption?: ReactNode; tone?: "warn" }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[13px] text-body">{label}</div>
      <div className={cx("mt-1 text-stat tabular-nums", tone === "warn" ? "text-overlap" : "text-fg")}>{value}</div>
      {caption && <div className="mt-0.5 truncate text-xs text-body">{caption}</div>}
    </Card>
  );
}
