import { Banner, Checkbox, Dialog, Input, Loader, Radio } from "@cloudflare/kumo";
import type { DecideInput, Selection } from "@forkyard/shared";
import { CheckCircle, GitMerge, Trophy, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { call, taskRoute, type Compare, type DecidePreview, type TaskDetail } from "../lib/api";
import { fileCompareQuery, headsOf } from "../lib/queries";
import { toastError, toasts } from "../lib/toast";
import { AgentChip, type AgentLike } from "./AgentChip";
import { FileDiff, LazyMount, type DiffStyle } from "./DiffView";
import { Pill, Score } from "./Status";
import { Button, Card, cx } from "./ui";

type Pick = "whole" | Set<string>;
const RESULT: AgentLike = { id: "result", name: "Combined result", initials: "∑", color: "#71717a" };

/**
 * Decide: pick a winner, or assemble hunks from several forks. Always
 * previews the combined result (and any conflicts) before applying.
 */
export function DecideView({
  yard,
  task,
  detail,
  compare,
  diffStyle,
  wrap,
}: {
  yard: string;
  task: string;
  detail: TaskDetail;
  compare: Compare | null;
  diffStyle: DiffStyle;
  wrap: boolean;
}) {
  const qc = useQueryClient();
  const ranked = useMemo(() => [...detail.agents].filter((a) => a.headCommit).sort((a, b) => (b.review?.score ?? -1) - (a.review?.score ?? -1)), [detail.agents]);
  const [mode, setMode] = useState<"winner" | "assemble">("winner");
  const [winner, setWinner] = useState<string | null>(ranked[0]?.id ?? null);
  const [picks, setPicks] = useState<Map<string, Map<string, Pick>>>(new Map());
  const [message, setMessage] = useState(detail.task.title);
  const [confirm, setConfirm] = useState(false);
  const previewM = useMutation({
    mutationFn: (json: DecideInput) => call(taskRoute.decide.preview.$post({ param: { yard, task }, json })),
    onError: (e) => toastError(e, "Preview failed"),
  });
  const applyM = useMutation({
    mutationFn: (json: DecideInput) => call(taskRoute.decide.$post({ param: { yard, task }, json })),
    onSuccess: (r) => {
      toasts.add({ title: "Decision applied", description: `Base moved to ${r.decision.resultCommit.slice(0, 7)}`, variant: "success" });
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      void qc.invalidateQueries({ queryKey: ["yards"] });
    },
    onError: (e) => toastError(e, "Could not apply"),
  });
  const preview: DecidePreview | null = previewM.data ?? null;

  const input = useMemo<DecideInput | null>(() => {
    if (mode === "winner") return winner ? { mode: "winner", winnerAgentId: winner, message } : null;
    const selections: Selection[] = [];
    for (const [path, byAgent] of picks)
      for (const [agentId, pick] of byAgent) {
        if (pick === "whole") selections.push({ path, agentId });
        else if (pick.size) selections.push({ path, agentId, hunkIds: [...pick] });
      }
    return selections.length ? { mode: "assemble", selections, message } : null;
  }, [mode, winner, picks, message]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => previewM.reset(), [input]);

  if (detail.task.status !== "open") {
    const d = detail.decision;
    return (
      <Banner
        icon={<CheckCircle weight="fill" />}
        title={detail.task.status === "decided" ? "This task is decided" : "This task was abandoned"}
        description={
          d
            ? `${d.mode === "winner" ? `Winner: ${detail.agents.find((a) => a.id === d.winnerAgentId)?.name}` : `Assembled from ${new Set(d.selections.map((s) => s.agentId)).size} forks`} → ${d.resultCommit.slice(0, 7)} by ${d.decidedBy}`
            : "No decision was recorded."
        }
      />
    );
  }

  const runPreview = () => input && previewM.mutate(input);
  const apply = () => input && applyM.mutate(input);

  const setPick = (path: string, agentId: string, pick: Pick | null) =>
    setPicks((prev) => {
      const next = new Map(prev);
      const m = new Map(next.get(path) ?? []);
      if (pick === null || (pick !== "whole" && pick.size === 0)) m.delete(agentId);
      else m.set(agentId, pick);
      if (m.size) next.set(path, m);
      else next.delete(path);
      return next;
    });

  return (
    <div className="space-y-4">
      <Radio.Group legend="How to decide" orientation="horizontal" value={mode} onValueChange={(v) => setMode(v as "winner" | "assemble")}>
        <Radio.Item label="Pick a winner" value="winner" />
        <Radio.Item label="Assemble hunks from several forks" value="assemble" />
      </Radio.Group>

      {mode === "winner" ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {ranked.length === 0 && <p className="text-sm text-body">No fork has pushed yet.</p>}
          {ranked.map((a) => {
            const c = compare?.agents.find((x) => x.agent.id === a.id);
            const sel = winner === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setWinner(a.id)}
                aria-pressed={sel}
                className={cx("rounded-lg bg-surface p-3 text-left shadow-card transition-shadow hover:shadow-card-hover", sel && "ring-2 ring-ink")}
              >
                <div className="flex items-center gap-2">
                  <AgentChip agent={a} />
                  {sel && <Trophy weight="fill" className="ml-auto text-busy" aria-label="selected winner" />}
                </div>
                <div className="mt-1 line-clamp-2 text-sm">{a.intent?.summary ?? <i className="text-body">no intent</i>}</div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <Score score={a.review?.score} />
                  {c && <span className="font-mono text-body">{c.files.length} files +{c.additions} −{c.deletions}</span>}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {(compare?.files ?? []).length === 0 && <p className="text-sm text-body">No changed files yet.</p>}
          {(compare?.files ?? []).map((f) => (
            <LazyMount key={f.path} minHeight={60}>
              <AssembleFile yard={yard} task={task} detail={detail} path={f.path} overlap={f.overlap} picks={picks.get(f.path)} setPick={setPick} />
            </LazyMount>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <div className="min-w-64 flex-1">
          <Input label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
        <Button size="lg" onClick={runPreview} disabled={!input} loading={previewM.isPending}>
          Preview result
        </Button>
        <Button size="lg" variant="primary" icon={<GitMerge />} disabled={!preview || preview.conflicts.length > 0} onClick={() => setConfirm(true)}>
          Apply to base
        </Button>
      </div>

      {preview && (
        <div className="space-y-3">
          {preview.conflicts.length > 0 ? (
            <Banner
              variant="error"
              icon={<Warning weight="fill" />}
              title={`${preview.conflicts.length} conflict(s) — adjust your selection`}
              description={preview.conflicts.map((c) => `${c.path}: ${c.detail}`).join(" · ")}
            />
          ) : (
            <Banner icon={<CheckCircle weight="fill" />} title="Ready to apply" description={`${preview.files.length} file(s) will change on the base branch.`} />
          )}
          {preview.files.map((f) => (
            <PreviewFile key={f.path} yard={yard} task={task} detail={detail} file={f} diffStyle={diffStyle} wrap={wrap} />
          ))}
        </div>
      )}

      <Dialog.Root open={confirm} onOpenChange={setConfirm}>
        <Dialog className="p-6" size="lg">
          <Dialog.Title className="text-h3">Apply this decision?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-body">
            Forkyard will commit {preview?.files.length ?? 0} file(s) to the base branch and close the task. Forks are deleted after the cleanup TTL.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" loading={applyM.isPending} onClick={apply}>
              Apply
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

function AssembleFile({
  yard,
  task,
  detail,
  path,
  overlap,
  picks,
  setPick,
}: {
  yard: string;
  task: string;
  detail: TaskDetail;
  path: string;
  overlap: boolean;
  picks: Map<string, Pick> | undefined;
  setPick: (path: string, agentId: string, pick: Pick | null) => void;
}) {
  const { data } = useQuery(fileCompareQuery(yard, task, path, headsOf(detail.agents)));
  const agents = new Map(detail.agents.map((a) => [a.id, a]));
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-sm font-semibold">{path}</span>
        {overlap && (
          <Pill>
            <Warning weight="fill" className="text-overlap" /> overlap
          </Pill>
        )}
      </div>
      {!data ? (
        <div className="flex items-center gap-2 p-3 text-sm text-body">
          <Loader size="sm" /> loading hunks
        </div>
      ) : (
        <div className="divide-y divide-line">
          {data.versions
            .filter((v) => v.status !== "unchanged")
            .map((v) => {
              const a = agents.get(v.agentId);
              if (!a) return null;
              const pick = picks?.get(a.id);
              const whole = pick === "whole";
              return (
                <div key={a.id} className="p-3">
                  <div className="mb-2 flex items-center gap-3">
                    <AgentChip agent={a} size={18} />
                    <Checkbox label={v.status === "deleted" ? "take deletion" : "take whole file"} checked={whole} onCheckedChange={(c) => setPick(path, a.id, c ? "whole" : null)} />
                  </div>
                  <ul className="space-y-1.5">
                    {v.hunks.map((h, i) => {
                      const on = !whole && pick instanceof Set && pick.has(h.id);
                      return (
                        <li key={h.id} className={cx("rounded border px-2 py-1.5", on ? "border-line-strong bg-hover" : "border-line", whole && "opacity-50")}>
                          <Checkbox
                            disabled={whole}
                            checked={on}
                            label={
                              <span className="text-xs">
                                hunk {i + 1} · base line {h.oldStart} · <span className="text-emerald-600 dark:text-emerald-400">+{h.lines.filter((l) => l.startsWith("+")).length}</span>{" "}
                                <span className="text-red-600 dark:text-red-400">−{h.lines.filter((l) => l.startsWith("-")).length}</span>
                              </span>
                            }
                            onCheckedChange={(c) => {
                              const s = new Set(pick instanceof Set ? pick : []);
                              if (c) s.add(h.id);
                              else s.delete(h.id);
                              setPick(path, a.id, s);
                            }}
                          />
                          <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] leading-4">
                            {h.lines.slice(0, 8).map((l, j) => (
                              <div key={j} className={l.startsWith("+") ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                                {l}
                              </div>
                            ))}
                            {h.lines.length > 8 && <div className="text-body">… {h.lines.length - 8} more lines</div>}
                          </pre>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
        </div>
      )}
    </Card>
  );
}

function PreviewFile({
  yard,
  task,
  detail,
  file,
  diffStyle,
  wrap,
}: {
  yard: string;
  task: string;
  detail: TaskDetail;
  file: DecidePreview["files"][number];
  diffStyle: DiffStyle;
  wrap: boolean;
}) {
  const base = useQuery(fileCompareQuery(yard, task, file.path, headsOf(detail.agents))).data?.base;
  const from = file.fromAgents.map((id) => detail.agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (base === undefined) return null;
  return (
    <FileDiff
      path={file.path}
      base={base}
      next={file.contents}
      hunks={[]}
      agent={RESULT}
      diffStyle={diffStyle}
      wrap={wrap}
      header={
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <span className="text-body">from</span>
          {from.map((a) => (
            <AgentChip key={a.id} agent={a} size={16} />
          ))}
          <span className="ml-auto text-body">{file.status}</span>
        </div>
      }
    />
  );
}
