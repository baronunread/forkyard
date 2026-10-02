/**
 * Status pills in Vercel's deployment vocabulary: a coloured dot inside a
 * hairline pill, always with a text label (never colour alone).
 */

const DOT: Record<string, { label: string; color: string; pulse?: boolean }> = {
  forking: { label: "Forking", color: "#a1a1a1", pulse: true },
  ready: { label: "Ready", color: "#a1a1a1" },
  working: { label: "Working", color: "#f5a623", pulse: true },
  pushed: { label: "Pushed", color: "#0070f3" },
  reviewed: { label: "Reviewed", color: "#29bc9b" },
  failed: { label: "Failed", color: "#ee0000" },
  retired: { label: "Done", color: "#707070" },
  open: { label: "Open", color: "#0070f3" },
  decided: { label: "Decided", color: "#29bc9b" },
  abandoned: { label: "Abandoned", color: "#707070" },
};

export function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-kumo-default ${className}`}
      style={{ background: "var(--fy-surface)", boxShadow: "0 0 0 1px var(--fy-border)" }}
    >
      {children}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = DOT[status] ?? { label: status, color: "#a1a1a1" };
  return (
    <Pill>
      <span className={`inline-block size-2 rounded-full ${s.pulse ? "fy-pulse" : ""}`} style={{ background: s.color }} aria-hidden />
      {s.label}
    </Pill>
  );
}

export const AgentStatus = StatusPill;
export const TaskStatusBadge = StatusPill;

/** Score 0–100: a thin ink bar plus the number in mono, readable without colour. */
export function Score({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <span className="text-xs text-kumo-subtle">No review yet</span>;
  return (
    <span className="inline-flex items-center gap-2" title={`Review score ${score}/100`}>
      <span className="relative h-1 w-16 overflow-hidden rounded-full" style={{ background: "var(--fy-border)" }}>
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${score}%`, background: score < 50 ? "#ee0000" : "var(--fy-ink)" }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-kumo-default">{score}</span>
    </span>
  );
}

export function LiveDot({ state }: { state: "connecting" | "live" | "offline" }) {
  const color = state === "live" ? "#29bc9b" : state === "connecting" ? "#f5a623" : "#ee0000";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-kumo-subtle" title={`Live updates: ${state}`}>
      <span className={`inline-block size-2 rounded-full ${state === "connecting" ? "fy-pulse" : ""}`} style={{ background: color }} />
      {state}
    </span>
  );
}
