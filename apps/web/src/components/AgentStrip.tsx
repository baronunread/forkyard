import { ArrowUpRight, Warning } from "@phosphor-icons/react";
import type { Compare, TaskDetail } from "../lib/api";
import { AgentBadge } from "./AgentChip";
import { AgentStatus, Score } from "./Status";

/** One card per fork: who, status, intent first, score, size, preview. */
export function AgentStrip({
  detail,
  compare,
  selected,
  onSelect,
}: {
  detail: TaskDetail;
  compare: Compare | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto p-px pb-1" role="tablist" aria-label="Agent forks">
      {detail.agents.map((a, i) => {
        const c = compare?.agents.find((x) => x.agent.id === a.id);
        const isSel = a.id === selected;
        const overlaps = detail.overlaps.filter((o) => o.active && o.agents.includes(a.id)).length;
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={isSel}
            onClick={() => onSelect(a.id)}
            className="fy-card fy-card-hover flex w-[300px] shrink-0 flex-col gap-3 p-4 text-left"
            style={isSel ? { boxShadow: "0 0 0 2px var(--fy-ink)" } : undefined}
          >
            <div className="flex items-center gap-2.5">
              <AgentBadge agent={a} size={28} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium leading-5">{a.name}</div>
                <div className="truncate font-mono text-xs text-kumo-subtle">{a.harness}</div>
              </div>
              <span className="ml-auto flex items-center gap-2">
                {i < 9 && <kbd className="fy-kbd">{i + 1}</kbd>}
                <AgentStatus status={a.status} />
              </span>
            </div>
            <div className="min-h-[44px]">
              {a.intent ? (
                <>
                  <div className="line-clamp-1 text-sm font-medium">{a.intent.summary}</div>
                  <div className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] text-kumo-subtle">{a.intent.why}</div>
                </>
              ) : (
                <div className="text-[13px] text-kumo-inactive">No intent recorded yet.</div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--fy-border)", paddingTop: 12 }}>
              <Score score={a.review?.score} />
              {c && (
                <span className="font-mono text-xs tabular-nums text-kumo-subtle">
                  {c.files.length} files <span style={{ color: "#29bc9b" }}>+{c.additions}</span> <span style={{ color: "#ee0000" }}>−{c.deletions}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 font-mono text-xs text-kumo-subtle">
              {overlaps > 0 && (
                <span className="inline-flex items-center gap-1 font-sans font-medium" style={{ color: "var(--fy-overlap)" }}>
                  <Warning weight="fill" /> {overlaps} overlap{overlaps > 1 ? "s" : ""}
                </span>
              )}
              {a.headCommit && <span>{a.headCommit.slice(0, 7)}</span>}
              {a.forkMs !== null && <span title="Fork latency">fork {Math.round(a.forkMs)}ms</span>}
              {a.previewUrl && (
                <a
                  className="ml-auto inline-flex items-center gap-0.5 font-sans text-kumo-link hover:underline"
                  href={a.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Preview <ArrowUpRight />
                </a>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
