import { Empty, Loader } from "@cloudflare/kumo";
import { ArrowUpRight, CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
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

  const review = agent.review;
  const failed = review?.checks.filter((c) => c.status === "fail") ?? [];
  const warned = review?.checks.filter((c) => c.status === "warn") ?? [];
  const passed = review?.checks.filter((c) => c.status === "pass") ?? [];
  return (
    <div className="space-y-4">
      <section className="fy-card p-5" aria-label={`${agent.name}'s intent and review`}>
        <div className="flex items-center gap-2.5">
          <AgentChip agent={agent} size={24} />
          <span className="font-mono text-xs text-kumo-subtle">{agent.harness}</span>
          {agent.previewUrl && (
            <a className="ml-auto inline-flex items-center gap-1 text-sm text-kumo-link hover:underline" href={agent.previewUrl} target="_blank" rel="noreferrer">
              Preview <ArrowUpRight />
            </a>
          )}
        </div>
        {agent.intent ? (
          <>
            <h3 className="fy-h3 mt-3">{agent.intent.summary}</h3>
            <p className="mt-1 whitespace-pre-wrap text-kumo-subtle">{agent.intent.why}</p>
            {agent.intent.details && <p className="mt-2 whitespace-pre-wrap text-kumo-subtle">{agent.intent.details}</p>}
          </>
        ) : (
          <p className="mt-3 text-kumo-inactive">No intent recorded yet.</p>
        )}
        {review && (
          <details className="mt-4 pt-4" style={{ borderTop: "1px solid var(--fy-border)" }}>
            <summary className="flex cursor-pointer list-none items-center gap-3 text-sm">
              <Score score={review.score} />
              <span className="text-kumo-subtle">
                {passed.length} passed
                {warned.length > 0 && ` · ${warned.length} warning${warned.length > 1 ? "s" : ""}`}
                {failed.length > 0 && ` · ${failed.length} failed`}
              </span>
              <span className="ml-auto text-xs text-kumo-subtle">Details</span>
            </summary>
            <p className="mt-3 text-sm">{review.summary}</p>
            <ul className="mt-3 space-y-1.5">
              {[...failed, ...warned, ...passed].map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  {c.status === "pass" ? (
                    <CheckCircle weight="fill" className="mt-0.5 shrink-0" style={{ color: "#29bc9b" }} aria-label="pass" />
                  ) : c.status === "warn" ? (
                    <WarningCircle weight="fill" className="mt-0.5 shrink-0" style={{ color: "#f5a623" }} aria-label="warning" />
                  ) : (
                    <XCircle weight="fill" className="mt-0.5 shrink-0" style={{ color: "#ee0000" }} aria-label="fail" />
                  )}
                  <span>
                    <span className="font-medium">{c.name}</span> <span className="text-kumo-subtle">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {review.comments.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {review.comments.slice(0, 8).map((c, i) => (
                  <li key={i}>
                    {c.path && (
                      <span className="font-mono text-xs text-kumo-subtle">
                        {c.path}
                        {c.line ? `:${c.line}` : ""}{" "}
                      </span>
                    )}
                    {c.body}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </section>

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
    />
  );
}
