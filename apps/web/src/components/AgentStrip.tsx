import { ArrowSquareOut, Warning } from "@phosphor-icons/react";
import type { Compare, TaskDetail } from "../lib/api";
import { AgentChip } from "./AgentChip";
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
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Agent forks">
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
            className={`flex w-72 shrink-0 flex-col gap-1.5 rounded-lg border bg-kumo-base p-3 text-left transition ${isSel ? "shadow-sm" : "border-kumo-hairline hover:border-kumo-line"}`}
            style={isSel ? { borderColor: a.color, boxShadow: `0 0 0 1px ${a.color}` } : undefined}
          >
            <div className="flex items-center gap-2">
              <AgentChip agent={a} size={24} />
              <span className="ml-auto flex items-center gap-1.5">
                {i < 9 && <kbd className="fy-kbd">{i + 1}</kbd>}
                <AgentStatus status={a.status} />
              </span>
            </div>
            <div className="text-xs text-kumo-subtle">{a.harness}</div>
            <div className="min-h-[2.5rem]">
              {a.intent ? (
                <>
                  <div className="line-clamp-1 text-sm font-semibold">{a.intent.summary}</div>
                  <div className="line-clamp-2 text-xs text-kumo-subtle">{a.intent.why}</div>
                </>
              ) : (
                <div className="text-xs italic text-kumo-subtle">no intent recorded yet</div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <Score score={a.review?.score} />
              <span className="font-mono tabular-nums text-kumo-subtle">
                {c ? `${c.files.length} files ` : ""}
                {c && (
                  <>
                    <span className="text-emerald-600 dark:text-emerald-400">+{c.additions}</span>{" "}
                    <span className="text-red-600 dark:text-red-400">−{c.deletions}</span>
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-kumo-subtle">
              {overlaps > 0 && (
                <span className="inline-flex items-center gap-1 font-medium" style={{ color: "var(--fy-overlap)" }}>
                  <Warning weight="fill" /> {overlaps} overlap{overlaps > 1 ? "s" : ""}
                </span>
              )}
              {a.headCommit && <span className="font-mono">{a.headCommit.slice(0, 7)}</span>}
              {a.forkMs !== null && <span title="Fork latency">fork {Math.round(a.forkMs)}ms</span>}
              {a.previewUrl && (
                <a
                  className="ml-auto inline-flex items-center gap-0.5 text-kumo-link hover:underline"
                  href={a.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  preview <ArrowSquareOut />
                </a>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
