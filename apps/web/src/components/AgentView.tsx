import { Badge, Empty, Loader } from "@cloudflare/kumo";
import { CheckCircle, GitCommit, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Compare, FileCompare, TaskAgent } from "../lib/api";
import { fetchFileCompare } from "../lib/data";
import { AgentChip } from "./AgentChip";
import { FileDiff, LazyMount, type DiffStyle } from "./DiffView";
import { Score } from "./Status";

/** Everything one agent did: intent first, then review, then every changed file. */
export function AgentView({
  yard,
  task,
  agent,
  compare,
  diffStyle,
  wrap,
  focusFile,
}: {
  yard: string;
  task: string;
  agent: TaskAgent;
  compare: Compare | null;
  diffStyle: DiffStyle;
  wrap: boolean;
  focusFile: string | null;
}) {
  const entry = compare?.agents.find((a) => a.agent.id === agent.id);
  const files = entry?.files ?? [];

  useEffect(() => {
    if (!focusFile) return;
    document.getElementById(fileAnchor(agent.id, focusFile))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusFile, agent.id]);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-kumo-hairline bg-kumo-base p-4" aria-label="Intent">
        <div className="mb-2 flex items-center gap-2">
          <AgentChip agent={agent} size={26} showHarness />
          <span className="ml-auto">
            <Score score={agent.review?.score} />
          </span>
        </div>
        {agent.intent ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">What & why</div>
            <h3 className="mt-0.5 text-base font-semibold">{agent.intent.summary}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-kumo-default">{agent.intent.why}</p>
            {agent.intent.details && <p className="mt-2 whitespace-pre-wrap text-sm text-kumo-subtle">{agent.intent.details}</p>}
            <div className="mt-2 flex items-center gap-2 text-xs text-kumo-subtle">
              <Badge variant="neutral">via {agent.intent.source}</Badge>
              {agent.intent.commit && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitCommit /> {agent.intent.commit.slice(0, 7)}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm italic text-kumo-subtle">{agent.name} has not recorded an intent yet.</p>
        )}
      </section>

      {agent.review && (
        <section className="rounded-lg border border-kumo-hairline bg-kumo-base p-4" aria-label="Review">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Review</span>
            <span className="text-xs text-kumo-subtle">
              {agent.review.reviewer} · {agent.review.commit.slice(0, 7)}
            </span>
          </div>
          <p className="text-sm">{agent.review.summary}</p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {agent.review.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-1.5 text-xs">
                {c.status === "pass" ? (
                  <CheckCircle weight="fill" className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="pass" />
                ) : c.status === "warn" ? (
                  <WarningCircle weight="fill" className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="warning" />
                ) : (
                  <XCircle weight="fill" className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" aria-label="fail" />
                )}
                <span>
                  <span className="font-medium">{c.name}</span> <span className="text-kumo-subtle">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {agent.review.comments.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-kumo-hairline pt-2 text-xs">
              {agent.review.comments.slice(0, 8).map((c, i) => (
                <li key={i}>
                  {c.path && (
                    <span className="font-mono text-kumo-subtle">
                      {c.path}
                      {c.line ? `:${c.line}` : ""}{" "}
                    </span>
                  )}
                  {c.body}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {files.length === 0 ? (
        <Empty
          size="sm"
          title={agent.headCommit ? "No changes against base" : "Nothing pushed yet"}
          description={agent.headCommit ? "This fork matches the task's base commit." : "Diffs appear here live as soon as the agent pushes."}
        />
      ) : (
        files.map((f) => (
          <div key={f.path} id={fileAnchor(agent.id, f.path)} className="scroll-mt-2">
            <LazyMount minHeight={Math.min(600, 80 + (f.additions + f.deletions) * 18)}>
              <AgentFile
                yard={yard}
                task={task}
                agent={agent}
                path={f.path}
                diffStyle={diffStyle}
                wrap={wrap}
                stats={`${f.status} · +${f.additions} −${f.deletions}`}
              />
            </LazyMount>
          </div>
        ))
      )}
    </div>
  );
}

export function fileAnchor(agentId: string, path: string): string {
  return `file-${agentId}-${path.replace(/[^A-Za-z0-9]/g, "_")}`;
}

function AgentFile({
  yard,
  task,
  agent,
  path,
  diffStyle,
  wrap,
  stats,
}: {
  yard: string;
  task: string;
  agent: TaskAgent;
  path: string;
  diffStyle: DiffStyle;
  wrap: boolean;
  stats: string;
}) {
  const [data, setData] = useState<FileCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchFileCompare(yard, task, path, agent.headCommit ?? "none", [agent.id])
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [yard, task, path, agent.id, agent.headCommit]);
  if (error) return <div className="rounded border border-kumo-hairline p-3 text-sm text-kumo-danger">{path}: {error}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 rounded border border-kumo-hairline p-3 text-sm text-kumo-subtle">
        <Loader size="sm" /> {path}
      </div>
    );
  const v = data.versions.find((x) => x.agentId === agent.id);
  if (!v) return null;
  if (v.binary || data.baseBinary) return <div className="rounded border border-kumo-hairline p-3 text-sm">{path}: binary file changed</div>;
  return (
    <FileDiff
      path={path}
      base={data.base}
      next={v.contents}
      hunks={v.hunks}
      agent={agent}
      intent={agent.intent?.summary}
      diffStyle={diffStyle}
      wrap={wrap}
      header={<div className="border-b border-kumo-hairline px-3 py-1 text-right text-xs text-kumo-subtle">{stats}</div>}
    />
  );
}
