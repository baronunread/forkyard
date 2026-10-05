import { cx, Dot } from "./ui";

/**
 * Status pills in Vercel's deployment vocabulary: a coloured dot inside a
 * hairline pill, always with a text label (never colour alone).
 */
export const STATUS: Record<string, { label: string; color: string; pulse?: boolean }> = {
  forking: { label: "Forking", color: "var(--color-muted)", pulse: true },
  ready: { label: "Ready", color: "var(--color-muted)" },
  working: { label: "Working", color: "var(--color-busy)", pulse: true },
  pushed: { label: "Pushed", color: "var(--color-info)" },
  reviewed: { label: "Reviewed", color: "var(--color-good)" },
  failed: { label: "Failed", color: "var(--color-bad)" },
  retired: { label: "Done", color: "var(--color-muted)" },
  open: { label: "Open", color: "var(--color-info)" },
  decided: { label: "Decided", color: "var(--color-good)" },
  abandoned: { label: "Abandoned", color: "var(--color-muted)" },
};

export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 text-xs font-medium text-fg ring-1 ring-line", className)}>{children}</span>;
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: "var(--color-muted)" };
  return (
    <Pill>
      <Dot color={s.color} pulse={s.pulse} />
      {s.label}
    </Pill>
  );
}

export const AgentStatus = StatusPill;
export const TaskStatusBadge = StatusPill;

/** Score 0–100: a thin ink bar plus the number in mono, readable without colour. */
export function Score({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <span className="text-xs text-body">No review yet</span>;
  return (
    <span className="inline-flex items-center gap-2" title={`Review score ${score}/100`}>
      <span className="relative h-1 w-16 overflow-hidden rounded-full bg-line">
        <span className={cx("absolute inset-y-0 left-0 rounded-full", score < 50 ? "bg-bad" : "bg-ink")} style={{ width: `${score}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-fg">{score}</span>
    </span>
  );
}
