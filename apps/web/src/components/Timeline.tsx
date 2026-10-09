import { describeEvent, type YardEvent } from "@forkyard/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { AgentBadge, type AgentLike } from "./AgentChip";
import { cx } from "./ui";

const GROUPS: Record<string, string[]> = {
  pushes: ["push.received", "diff.updated"],
  overlaps: ["overlap.detected", "overlap.cleared", "claim.added", "claim.released"],
  intents: ["intent.recorded"],
  reviews: ["review.started", "review.completed"],
  lifecycle: ["task.created", "agent.forking", "agent.ready", "agent.failed", "agent.status", "decision.made", "task.abandoned", "fork.deleted", "yard.created", "backlog.imported"],
};

function ago(ts: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Live feed of a task's events, filterable by agent and kind. The list is
 * virtualized (TanStack Virtual): a busy task has thousands of events.
 */
export function Timeline({ events, agents, now = Date.now() }: { events: YardEvent[]; agents: AgentLike[]; now?: number }) {
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string>("all");
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? id) : "?");
  const shown = useMemo(() => {
    const types = group === "all" ? null : new Set(GROUPS[group] ?? []);
    return (
      events
        .filter((e) => !e.agentId || !hiddenAgents.has(e.agentId))
        .filter((e) => !types || types.has(e.type))
        .slice()
        .reverse()
    );
  }, [events, hiddenAgents, group]);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => 30, overscan: 12, getItemKey: (i) => shown[i]!.seq });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line p-2">
        {["all", ...Object.keys(GROUPS)].map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={cx("rounded px-1.5 py-0.5 text-xs", group === g ? "bg-hover font-semibold text-fg" : "text-body hover:bg-hover")}>
            {g}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
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
              className={cx("rounded-full p-0.5", off && "opacity-30")}
            >
              <AgentBadge agent={a} size={18} />
            </button>
          );
        })}
      </div>
      <div ref={scroller} className="max-h-[70vh] min-h-0 flex-1 overflow-y-auto p-2 text-sm" aria-live="polite">
        {shown.length === 0 && <p className="p-2 text-body">No events yet.</p>}
        <ol className="relative" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map((v) => {
            const e = shown[v.index]!;
            const a = e.agentId ? byId.get(e.agentId) : undefined;
            const warn = e.type === "overlap.detected";
            const good = e.type === "decision.made" || e.type === "review.completed";
            return (
              <li
                key={v.key}
                data-index={v.index}
                ref={rows.measureElement}
                className="absolute inset-x-0 top-0 py-px"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <div className={cx("flex items-start gap-2 rounded px-1.5 py-1", warn && "bg-overlap/10")}>
                  <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[10px] text-body">{ago(e.ts, now)}</span>
                  {a ? <AgentBadge agent={a} size={18} /> : <span className="inline-block w-[18px] shrink-0 text-center text-xs">{warn ? "⚠" : good ? "✓" : "•"}</span>}
                  <span className={cx("min-w-0 break-words", warn && "font-medium")}>{describeEvent(e, name)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
