import { Warning } from "@phosphor-icons/react";
import type { TaskDetail } from "../lib/api";
import { AgentBadge } from "./AgentChip";
import { STATUS } from "./Status";
import { cx, Dot } from "./ui";

/** One quiet card per fork: who, what they're doing, how it scored. Details live one click away. */
export function AgentStrip({ detail, selected, onSelect }: { detail: TaskDetail; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="flex gap-3 overflow-x-auto p-0.5" role="tablist" aria-label="Agents">
      {detail.agents.map((a) => {
        const isSel = a.id === selected;
        const s = STATUS[a.status] ?? { label: a.status, color: "var(--color-muted)" };
        const overlaps = detail.overlaps.filter((o) => o.active && o.agents.includes(a.id)).length;
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={isSel}
            onClick={() => onSelect(a.id)}
            className={cx(
              "flex w-[240px] shrink-0 flex-col gap-2 rounded-lg bg-surface px-4 py-3 text-left shadow-card transition-shadow hover:shadow-card-hover",
              isSel && "ring-2 ring-ink",
            )}
          >
            <div className="flex items-center gap-2.5">
              <AgentBadge agent={a} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm leading-5 font-medium">{a.name}</div>
                <div className="flex items-center gap-1.5 text-xs text-body">
                  <Dot color={s.color} pulse={s.pulse} className="size-1.5" />
                  {s.label}
                  {overlaps > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-overlap" title={`${overlaps} overlap(s)`}>
                      · <Warning weight="fill" /> {overlaps}
                    </span>
                  )}
                </div>
              </div>
              <span className={cx("font-mono text-sm tabular-nums", a.review ? "text-fg" : "text-muted")} title="Review score">
                {a.review ? a.review.score : "–"}
              </span>
            </div>
            <div className={cx("line-clamp-1 text-[13px]", a.intent ? "text-fg" : "text-muted")}>{a.intent?.summary ?? "No intent yet"}</div>
          </button>
        );
      })}
    </div>
  );
}
