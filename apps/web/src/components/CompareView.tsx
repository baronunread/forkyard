import { Empty, Loader } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { Compare, FileCompare, TaskDetail } from "../lib/api";
import { fetchFileCompare } from "../lib/data";
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
  const heads = detail.agents.map((a) => a.headCommit ?? "-").join(",");
  const [data, setData] = useState<FileCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setData(null);
    setError(null);
    fetchFileCompare(yard, task, path, heads)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [yard, task, path, heads]);

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
  if (error) return <div className="text-sm text-kumo-danger">{error}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 text-sm text-kumo-subtle">
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
        <span className="text-kumo-subtle">
          changed by {changed.length} of {data.versions.length} agents
        </span>
        {unchanged.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-kumo-subtle">
            unchanged in:
            {unchanged.map((v) => {
              const a = agentById.get(v.agentId);
              return a ? <AgentChip key={a.id} agent={a} size={16} /> : null;
            })}
          </span>
        )}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(changed.length, 3))}, minmax(0, 1fr))` }}>
        {changed.map((v) => {
          const a = agentById.get(v.agentId);
          if (!a) return null;
          return (
            <div key={v.agentId} className="min-w-0">
              <div className="mb-1.5 flex min-w-0 items-center gap-2 rounded-md border-l-4 bg-kumo-base px-2 py-1.5" style={{ borderColor: a.color }}>
                <AgentChip agent={a} size={20} />
                <span className="text-xs text-kumo-subtle">{v.status}</span>
                {a.intent && <span className="truncate text-xs text-kumo-subtle">— {a.intent.summary}</span>}
              </div>
              {v.binary ? (
                <div className="rounded border border-kumo-hairline p-3 text-sm">binary</div>
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
