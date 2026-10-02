import { describeEvent, type YardEvent } from "@forkyard/shared";
import { useMemo, useState } from "react";
import { AgentBadge, type AgentLike } from "./AgentChip";

const GROUPS: Record<string, string[]> = {
  pushes: ["push.received", "diff.updated"],
  overlaps: ["overlap.detected", "overlap.cleared", "claim.added", "claim.released"],
  intents: ["intent.recorded"],
  reviews: ["review.started", "review.completed"],
  lifecycle: ["task.created", "agent.forking", "agent.ready", "agent.failed", "agent.status", "decision.made", "task.abandoned", "fork.deleted", "yard.created"],
};

function ago(ts: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Live feed of yard events, filterable by agent and kind. */
export function Timeline({ events, agents, now = Date.now() }: { events: YardEvent[]; agents: AgentLike[]; now?: number }) {
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string>("all");
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? id) : "?");
  const shown = events
    .filter((e) => !e.agentId || !hiddenAgents.has(e.agentId))
    .filter((e) => group === "all" || GROUPS[group]?.includes(e.type))
    .slice(-300)
    .reverse();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-kumo-hairline p-2">
        {["all", ...Object.keys(GROUPS)].map((g) => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={`rounded px-1.5 py-0.5 text-xs ${group === g ? "bg-kumo-tint font-semibold text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint"}`}
          >
            {g}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-kumo-hairline" />
        {agents.map((a) => {
          const off = hiddenAgents.has(a.id);
          return (
            <button
              key={a.id}
              title={`${off ? "Show" : "Hide"} ${a.name}`}
              aria-pressed={!off}
              onClick={() =>
                setHiddenAgents((s) => {
                  const n = new Set(s);
                  if (n.has(a.id)) n.delete(a.id);
                  else n.add(a.id);
                  return n;
                })
              }
              className={`rounded-full p-0.5 ${off ? "opacity-30" : ""}`}
            >
              <AgentBadge agent={a} size={18} />
            </button>
          );
        })}
      </div>
      <ol className="fy-scroll min-h-0 flex-1 space-y-0.5 p-2 text-sm" aria-live="polite">
        {shown.length === 0 && <li className="p-2 text-kumo-subtle">No events yet.</li>}
        {shown.map((e) => {
          const a = e.agentId ? byId.get(e.agentId) : undefined;
          const warn = e.type === "overlap.detected";
          const good = e.type === "decision.made" || e.type === "review.completed";
          return (
            <li key={e.seq} className={`flex items-start gap-2 rounded px-1.5 py-1 ${warn ? "bg-amber-500/10" : ""}`}>
              <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[10px] text-kumo-subtle">{ago(e.ts, now)}</span>
              {a ? <AgentBadge agent={a} size={18} /> : <span className="inline-block w-[18px] shrink-0 text-center text-xs">{warn ? "⚠" : good ? "✓" : "•"}</span>}
              <span className={`min-w-0 break-words ${warn ? "font-medium" : ""}`}>{describeEvent(e, name)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
