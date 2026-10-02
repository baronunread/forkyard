import { Badge } from "@cloudflare/kumo";

const AGENT: Record<string, { label: string; variant: "neutral" | "blue" | "orange" | "green" | "red" | "purple" | "teal" }> = {
  forking: { label: "forking", variant: "neutral" },
  ready: { label: "ready", variant: "teal" },
  working: { label: "working", variant: "blue" },
  pushed: { label: "pushed", variant: "orange" },
  reviewed: { label: "reviewed", variant: "green" },
  failed: { label: "failed", variant: "red" },
  retired: { label: "done", variant: "neutral" },
};

export function AgentStatus({ status }: { status: string }) {
  const s = AGENT[status] ?? { label: status, variant: "neutral" as const };
  return (
    <Badge variant={s.variant}>
      {(status === "forking" || status === "working") && <span className="fy-pulse mr-1 inline-block size-1.5 rounded-full bg-current" />}
      {s.label}
    </Badge>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const v = status === "open" ? "blue" : status === "decided" ? "green" : "neutral";
  return <Badge variant={v}>{status}</Badge>;
}

/** Score 0–100 with a text value, so it reads without color. */
export function Score({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <span className="text-xs text-kumo-subtle">no review yet</span>;
  const tone = score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="inline-flex items-center gap-2" title={`Review score ${score}/100`}>
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
        <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${score}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-kumo-default">{score}</span>
    </span>
  );
}

export function LiveDot({ state }: { state: "connecting" | "live" | "offline" }) {
  const color = state === "live" ? "bg-emerald-500" : state === "connecting" ? "bg-amber-500 fy-pulse" : "bg-red-500";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle" title={`Live updates: ${state}`}>
      <span className={`inline-block size-2 rounded-full ${color}`} />
      {state}
    </span>
  );
}
