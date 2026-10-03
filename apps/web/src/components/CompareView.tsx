import { Empty, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Compare, TaskDetail } from "../lib/api";
import { fileCompareQuery, headsOf } from "../lib/queries";
import { AgentChip, AgentStack } from "./AgentChip";
import { Button } from "./ui";

const COMPARE_MAX = 6;
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
  const [showAll, setShowAll] = useState(false);
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

  const agentById = new Map(detail.agents.map((a) => [a.id, a]));
  // Best-reviewed first; a hot file in a swarm can have hundreds of versions, so show a few.
  const score = (id: string) => agentById.get(id)?.review?.score ?? -1;
  const allChanged = data.versions.filter((v) => v.status !== "unchanged").sort((a, b) => score(b.agentId) - score(a.agentId));
  const changed = showAll ? allChanged : allChanged.slice(0, COMPARE_MAX);
  const unchanged = data.versions.filter((v) => v.status === "unchanged");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-semibold">{path}</span>
        <span className="text-body">
          changed by {allChanged.length} of {data.versions.length} agents
        </span>
        {unchanged.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-body">
            unchanged in
            <AgentStack agents={unchanged.map((v) => agentById.get(v.agentId)).filter((a): a is NonNullable<typeof a> => !!a)} max={6} size={18} />
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
      {allChanged.length > COMPARE_MAX && (
        <div className="flex justify-center">
          <Button size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? `Show the top ${COMPARE_MAX}` : `Show all ${allChanged.length} versions`}
          </Button>
        </div>
      )}
    </div>
  );
}
