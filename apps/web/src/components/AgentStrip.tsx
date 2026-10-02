import { Warning } from "@phosphor-icons/react";
import type { Compare, TaskDetail } from "../lib/api";
import { AgentBadge } from "./AgentChip";

const STATUS: Record<string, { label: string; color: string; pulse?: boolean }> = {
  forking: { label: "Forking", color: "#a1a1a1", pulse: true },
  ready: { label: "Ready", color: "#a1a1a1" },
  working: { label: "Working", color: "#f5a623", pulse: true },
  pushed: { label: "Pushed", color: "#0070f3" },
  reviewed: { label: "Reviewed", color: "#29bc9b" },
  failed: { label: "Failed", color: "#ee0000" },
  retired: { label: "Done", color: "#707070" },
};

/** One quiet card per fork: who, what they're doing, how it scored. Details live one click away. */
export function AgentStrip({
  detail,
  selected,
  onSelect,
}: {
  detail: TaskDetail;
  compare: Compare | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto p-0.5" role="tablist" aria-label="Agents">
      {detail.agents.map((a) => {
        const isSel = a.id === selected;
        const s = STATUS[a.status] ?? { label: a.status, color: "#a1a1a1" };
        const overlaps = detail.overlaps.filter((o) => o.active && o.agents.includes(a.id)).length;
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={isSel}
            onClick={() => onSelect(a.id)}
            className="fy-card fy-card-hover flex w-[240px] shrink-0 flex-col gap-2 px-4 py-3 text-left"
            style={isSel ? { boxShadow: "0 0 0 2px var(--fy-ink)" } : undefined}
          >
            <div className="flex items-center gap-2.5">
              <AgentBadge agent={a} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-5">{a.name}</div>
                <div className="flex items-center gap-1.5 text-xs text-kumo-subtle">
                  <span className={`inline-block size-1.5 rounded-full ${s.pulse ? "fy-pulse" : ""}`} style={{ background: s.color }} aria-hidden />
                  {s.label}
                  {overlaps > 0 && (
                    <span className="inline-flex items-center gap-0.5" style={{ color: "var(--fy-overlap)" }} title={`${overlaps} overlap(s)`}>
                      · <Warning weight="fill" /> {overlaps}
                    </span>
                  )}
                </div>
              </div>
              <span className="font-mono text-sm tabular-nums" title="Review score" style={{ color: a.review ? "var(--fy-fg)" : "var(--fy-muted)" }}>
                {a.review ? a.review.score : "–"}
              </span>
            </div>
            <div className={`line-clamp-1 text-[13px] ${a.intent ? "text-kumo-default" : "text-kumo-inactive"}`}>{a.intent?.summary ?? "No intent yet"}</div>
          </button>
        );
      })}
    </div>
  );
}
