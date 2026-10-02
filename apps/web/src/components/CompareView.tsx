import { Empty, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import type { Compare, TaskDetail } from "../lib/api";
import { fileCompareQuery, headsOf } from "../lib/queries";
import { AgentChip } from "./AgentChip";
import { FileDiff, type DiffStyle } from "./DiffView";

/** Pick a file; see how every agent changed it, side by side against base. */
export function CompareView({
  yard,
  task,
  detail,
  compare,
  path,
  diffStyle,
  wrap,
}: {
  yard: string;
  task: string;
  detail: TaskDetail;
  compare: Compare | null;
  path: string | null;
  diffStyle: DiffStyle;
  wrap: boolean;
}) {
  const { data, error } = useQuery({ ...fileCompareQuery(yard, task, path ?? "", headsOf(detail.agents)), enabled: !!path });

  if (!path) {
    const firstOverlap = compare?.files.find((f) => f.overlap);
    return (
      <Empty
        size="sm"
        title="Pick a file to compare"
        description={firstOverlap ? `Try ${firstOverlap.path} — more than one agent changed it.` : "Select a file in the tree on the left."}
      />
    );
  }
  if (error) return <div className="text-sm text-bad">{error.message}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 text-sm text-body">
        <Loader size="sm" /> loading {path}
      </div>
    );

  const changed = data.versions.filter((v) => v.status !== "unchanged");
  const unchanged = data.versions.filter((v) => v.status === "unchanged");
  const agentById = new Map(detail.agents.map((a) => [a.id, a]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-semibold">{path}</span>
        <span className="text-body">
          changed by {changed.length} of {data.versions.length} agents
        </span>
        {unchanged.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-body">
            unchanged in:
            {unchanged.map((v) => {
              const a = agentById.get(v.agentId);
              return a ? <AgentChip key={a.id} agent={a} size={16} /> : null;
            })}
          </span>
        )}
      </div>
      <div className={["grid gap-3 grid-cols-1", "grid gap-3 grid-cols-1", "grid gap-3 grid-cols-2", "grid gap-3 grid-cols-3"][Math.min(changed.length, 3)]}>
        {changed.map((v) => {
          const a = agentById.get(v.agentId);
          if (!a) return null;
          return (
            <div key={v.agentId} className="min-w-0">
              <div className="mb-1.5 flex min-w-0 items-center gap-2 rounded-md border-l-4 bg-surface px-2 py-1.5" style={{ borderColor: a.color }}>
                <AgentChip agent={a} size={20} />
                <span className="text-xs text-body">{v.status}</span>
                {a.intent && <span className="truncate text-xs text-body">— {a.intent.summary}</span>}
              </div>
              {v.binary ? (
                <div className="rounded border border-line p-3 text-sm">binary</div>
              ) : (
                <FileDiff
                  path={path}
                  base={data.base}
                  next={v.contents}
                  hunks={v.hunks}
                  agent={a}
                  intent={a.intent?.summary}
                  diffStyle={changed.length > 1 ? "unified" : diffStyle}
                  wrap={wrap || changed.length > 1}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
