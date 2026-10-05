import { CaretDown, CaretUp, MagnifyingGlass, Warning } from "@phosphor-icons/react";
import { createColumnHelper, createSortedRowModel, rowSortingFeature, sortFn_alphanumeric, sortFn_basic, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { Compare, TaskAgent, TaskDetail } from "../lib/api";
import { AgentBadge } from "./AgentChip";
import { STATUS } from "./Status";
import { cx, Dot } from "./ui";

/**
 * The agents on a big task, as a leaderboard instead of a row of cards:
 * sortable by score, changes, overlaps or status; filterable by name or
 * intent; virtualized, so a thousand agents scroll like ten. Status counts
 * on top double as filters.
 */

interface Row {
  agent: TaskAgent;
  rank: number;
  score: number | null;
  files: number;
  additions: number;
  deletions: number;
  overlaps: number;
  status: string;
  name: string;
  intent: string;
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic, alphanumeric: sortFn_alphanumeric },
});
const col = createColumnHelper<typeof features, Row>();
const STATUS_ORDER = ["working", "pushed", "reviewed", "ready", "forking", "failed", "retired"];

const columns = col.columns([
  col.accessor("rank", { header: "#", sortFn: "basic" }),
  col.accessor("name", { header: "Agent", sortFn: "alphanumeric" }),
  col.accessor((r) => STATUS_ORDER.indexOf(r.status), { id: "status", header: "Status", sortFn: "basic" }),
  col.accessor((r) => r.score ?? -1, { id: "score", header: "Score", sortFn: "basic", sortDescFirst: true }),
  col.accessor((r) => r.additions + r.deletions, { id: "changes", header: "Changes", sortFn: "basic", sortDescFirst: true }),
  col.accessor("overlaps", { header: "Overlaps", sortFn: "basic", sortDescFirst: true }),
  col.accessor("intent", { header: "Intent", sortFn: "alphanumeric" }),
]);

const GRID = "grid grid-cols-[48px_220px_130px_110px_130px_96px_minmax(0,1fr)] items-center";

export function AgentBoard({ detail, compare, selected, onSelect }: { detail: TaskDetail; compare: Compare | null; selected: string | null; onSelect: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<string | null>(null);

  const all = useMemo<Row[]>(() => {
    const byAgent = new Map(compare?.agents.map((c) => [c.agent.id, c]) ?? []);
    const overlapCount = new Map<string, number>();
    for (const o of detail.overlaps) if (o.active) for (const a of o.agents) overlapCount.set(a, (overlapCount.get(a) ?? 0) + 1);
    const ranked = [...detail.agents].sort((a, b) => (b.review?.score ?? -1) - (a.review?.score ?? -1));
    const rank = new Map(ranked.map((a, i) => [a.id, i + 1]));
    return detail.agents.map((a) => {
      const c = byAgent.get(a.id);
      return {
        agent: a,
        rank: rank.get(a.id)!,
        score: a.review?.score ?? null,
        files: c?.files.length ?? 0,
        additions: c?.additions ?? 0,
        deletions: c?.deletions ?? 0,
        overlaps: overlapCount.get(a.id) ?? 0,
        status: a.status,
        name: a.name,
        intent: a.intent?.summary ?? "",
      };
    });
  }, [detail, compare]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return STATUS_ORDER.filter((s) => m.has(s)).map((s) => [s, m.get(s)!] as const);
  }, [all]);

  const data = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter((r) => (!only || r.status === only) && (!s || `${r.name} ${r.intent} ${r.agent.harness}`.toLowerCase().includes(s)));
  }, [all, q, only]);

  const table = useTable({ features, columns, data, initialState: { sorting: [{ id: "rank", desc: false }] } });
  const rows = table.getRowModel().rows;
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 40, overscan: 10 });

  return (
    <div className="flex flex-col overflow-hidden rounded-lg bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <label className="flex h-7 w-56 items-center gap-2 rounded-md bg-surface-2 px-2 text-body ring-1 ring-line focus-within:ring-link">
          <MagnifyingGlass size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${all.length} agents`} className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted" />
        </label>
        <div className="flex flex-wrap items-center gap-1">
          {counts.map(([s, n]) => {
            const st = STATUS[s] ?? { label: s, color: "var(--color-muted)" };
            const on = only === s;
            return (
              <button
                key={s}
                onClick={() => setOnly(on ? null : s)}
                aria-pressed={on}
                className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs", on ? "bg-ink text-on-ink" : "text-body ring-1 ring-line hover:bg-hover")}
              >
                <Dot color={st.color} pulse={st.pulse && !on} />
                <span className="tabular-nums">{n}</span> {st.label.toLowerCase()}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {data.length === all.length ? `${all.length} agents` : `${data.length} of ${all.length}`}
        </span>
      </div>

      <div className={cx(GRID, "border-b border-line px-3 text-xs font-medium text-body")} role="row">
        {table.getHeaderGroups()[0]!.headers.map((h) => {
          const sorted = h.column.getIsSorted();
          return (
            <button key={h.id} onClick={h.column.getToggleSortingHandler()} className={cx("flex h-8 items-center gap-1 text-left hover:text-fg", sorted && "text-fg")} role="columnheader">
              <table.FlexRender header={h} />
              {sorted === "asc" ? <CaretUp size={10} /> : sorted === "desc" ? <CaretDown size={10} /> : null}
            </button>
          );
        })}
      </div>

      <div ref={scroller} className="h-[264px] overflow-y-auto" role="rowgroup">
        <div className="relative" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!.original;
            const st = STATUS[r.status] ?? { label: r.status, color: "var(--color-muted)" };
            const sel = r.agent.id === selected;
            return (
              <button
                key={r.agent.id}
                onClick={() => onSelect(r.agent.id)}
                aria-selected={sel}
                className={cx(GRID, "absolute inset-x-0 top-0 h-10 px-3 text-left text-[13px]", sel ? "bg-selected" : "hover:bg-hover")}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <span className="font-mono text-xs text-muted tabular-nums">{r.rank}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <AgentBadge agent={r.agent} size={20} />
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{r.agent.harness}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-body">
                  <Dot color={st.color} pulse={st.pulse} />
                  {st.label}
                </span>
                <span className="flex items-center gap-2">
                  {r.score === null ? (
                    <span className="text-xs text-muted">–</span>
                  ) : (
                    <>
                      <span className="relative h-1 w-12 overflow-hidden rounded-full bg-line">
                        <span className={cx("absolute inset-y-0 left-0 rounded-full", r.score < 50 ? "bg-bad" : "bg-ink")} style={{ width: `${r.score}%` }} />
                      </span>
                      <span className="font-mono text-xs tabular-nums">{r.score}</span>
                    </>
                  )}
                </span>
                <span className="font-mono text-xs text-body tabular-nums">
                  {r.files ? (
                    <>
                      {r.files}f <span className="text-good">+{r.additions}</span> <span className="text-bad">−{r.deletions}</span>
                    </>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </span>
                <span className={cx("inline-flex items-center gap-1 text-xs tabular-nums", r.overlaps ? "text-overlap" : "text-muted")}>
                  {r.overlaps ? (
                    <>
                      <Warning weight="fill" /> {r.overlaps}
                    </>
                  ) : (
                    "–"
                  )}
                </span>
                <span className={cx("truncate", r.intent ? "text-fg" : "text-muted")}>{r.intent || "No intent yet"}</span>
              </button>
            );
          })}
        </div>
        {!rows.length && <p className="p-4 text-[13px] text-body">No agent matches.</p>}
      </div>
    </div>
  );
}
