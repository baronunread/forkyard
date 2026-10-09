import { Banner, Checkbox, Dialog, Input, Loader, Radio } from "@cloudflare/kumo";
import type { DecideInput, Selection } from "@forkyard/shared";
import { CheckCircle, GitMerge, Trophy, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { call, taskRoute, type Compare, type DecidePreview, type TaskDetail } from "../lib/api";
import { fileCompareQuery, headsOf, yardParams } from "../lib/queries";
import { toastError, toasts } from "../lib/toast";
import { AgentChip, type AgentLike } from "./AgentChip";
import { FileDiff, LazyMount, type DiffStyle } from "./DiffView";
import { Pill, Score } from "./Status";
import { Button, Card, cx } from "./ui";

type Pick = "whole" | Set<string>;
/** Forks shown as winner candidates before "Show all" (best-reviewed first). */
const WINNER_MAX = 12;
const RESULT: AgentLike = { id: "result", name: "Combined result", initials: "∑", color: "#71717a" };

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * Decide: take one fork, or combine parts of several. Always
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
  // The person's pick, else the best-reviewed fork (forks that push after this mounts count too).
  const [chosen, setWinner] = useState<string | null>(null);
  const winner = chosen && ranked.some((a) => a.id === chosen) ? chosen : (ranked[0]?.id ?? null);
  const [picks, setPicks] = useState<Map<string, Map<string, Pick>>>(new Map());
  const [message, setMessage] = useState(detail.task.title);
  const [confirm, setConfirm] = useState(false);
  const [showAllForks, setShowAllForks] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const previewM = useMutation({
    mutationFn: (json: DecideInput) => call(taskRoute.decide.preview.$post({ param: { yard, task }, json })),
    onSuccess: () => requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })),
    onError: (e) => toastError(e, "Preview failed"),
  });
  const applyM = useMutation({
    mutationFn: (json: DecideInput) => call(taskRoute.decide.$post({ param: { yard, task }, json })),
    onSuccess: (r) => {
      toasts.add({ title: "Shipped", description: `${files(preview?.files.length ?? 0)} changed on main.`, variant: "success" });
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

  // Combining: start from the best fork's whole work, so the person removes rather than rebuilds.
  const best = ranked[0]?.id;
  const bestFiles = compare?.agents.find((x) => x.agent.id === best)?.files;
  useEffect(() => {
    if (mode !== "assemble" || picks.size || !best || !bestFiles) return;
    setPicks(new Map(bestFiles.map((f) => [f.path, new Map<string, Pick>([[best, "whole"]])])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, best, bestFiles]);

  // ponytail: "left out" is by file, not by import; an agent's file that nobody's version is taken
  // for may be one its taken files need. Upgrade: parse imports if this misses real breaks.
  const leftOut = useMemo(() => {
    if (mode !== "assemble") return [];
    const out: { agent: string; path: string }[] = [];
    for (const agentId of new Set([...picks.values()].flatMap((m) => [...m.keys()])))
      for (const f of compare?.agents.find((x) => x.agent.id === agentId)?.files ?? [])
        if (!picks.has(f.path)) out.push({ agent: detail.agents.find((a) => a.id === agentId)?.name ?? agentId, path: f.path });
    return out;
  }, [mode, picks, compare, detail.agents]);

  if (detail.task.status !== "open") {
    const d = detail.decision;
    return (
      <Banner
        icon={<CheckCircle weight="fill" />}
        title={detail.task.status === "decided" ? "Shipped" : "This task was dropped"}
        description={
          d ? (
            <>
              {d.mode === "winner" ? `${detail.agents.find((a) => a.id === d.winnerAgentId)?.name}'s work` : `Parts from ${new Set(d.selections.map((s) => s.agentId)).size} agents`}, chosen by {d.decidedBy}.{" "}
              <Link to="/$owner/$yard/log" params={yardParams(yard)} className="underline">
                See it in the log
              </Link>{" "}
              ·{" "}
              <Link to="/$owner/$yard/code/$" params={{ ...yardParams(yard), _splat: "" }} className="underline">
                Open the code
              </Link>
            </>
          ) : (
            "Nothing was shipped."
          )
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
      <Radio.Group legend="What ships" orientation="horizontal" value={mode} onValueChange={(v) => setMode(v as "winner" | "assemble")}>
        <Radio.Item label="One agent's work" value="winner" />
        <Radio.Item label="Combine parts" value="assemble" />
      </Radio.Group>

      {mode === "winner" ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {ranked.length === 0 && <p className="text-sm text-body">No fork has pushed yet.</p>}
          {(showAllForks ? ranked : ranked.slice(0, WINNER_MAX)).map((a) => {
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
                  {sel && <Trophy weight="fill" className="ml-auto text-busy" aria-label="chosen" />}
                </div>
                <div className="mt-1 line-clamp-2 text-sm">{a.intent?.summary ?? <i className="text-body">no summary</i>}</div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <Score score={a.review?.score} />
                  {c && <span className="font-mono text-body">{files(c.files.length)} +{c.additions} −{c.deletions}</span>}
                </div>
              </button>
            );
          })}
          {ranked.length > WINNER_MAX && (
            <button
              onClick={() => setShowAllForks(!showAllForks)}
              className="rounded-lg p-3 text-sm text-body ring-1 ring-line ring-dashed hover:bg-hover"
            >
              {showAllForks ? `Show the top ${WINNER_MAX}` : `Show all ${ranked.length} forks`}
            </button>
          )}
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

      {leftOut.length > 0 && (
        <Banner
          variant="alert"
          icon={<Warning weight="fill" />}
          title={`${files(leftOut.length)} left out`}
          description={`The parts you chose may need them: ${leftOut.map((l) => `${l.path} (${l.agent})`).join(", ")}.`}
        />
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <div className="min-w-64 flex-1">
          <Input label="Message" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
        <Button size="lg" onClick={runPreview} disabled={!input} loading={previewM.isPending}>
          Preview
        </Button>
        <Button size="lg" variant="primary" icon={<GitMerge />} disabled={!preview || preview.conflicts.length > 0} onClick={() => setConfirm(true)}>
          Ship
        </Button>
      </div>

      {preview && (
        <div ref={resultRef} className="scroll-mt-4 space-y-3">
          {preview.conflicts.length > 0 ? (
            <Banner
              variant="error"
              icon={<Warning weight="fill" />}
              title={`${preview.conflicts.length === 1 ? "1 clash" : `${preview.conflicts.length} clashes`}: change what you picked`}
              description={preview.conflicts.map((c) => `${c.path}: ${c.detail}`).join(" · ")}
            />
          ) : (
            <Banner icon={<CheckCircle weight="fill" />} title="Ready to ship" description={`${files(preview.files.length)} will change on main.`} />
          )}
          {preview.files.map((f) => (
            <PreviewFile key={f.path} yard={yard} task={task} detail={detail} file={f} diffStyle={diffStyle} wrap={wrap} />
          ))}
        </div>
      )}

      <Dialog.Root open={confirm} onOpenChange={setConfirm}>
        <Dialog className="p-6" size="lg">
          <Dialog.Title className="text-h3">Ship it?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-body">
            {files(preview?.files.length ?? 0)} change on main and the task closes. The agents' forks are cleaned up later.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" loading={applyM.isPending} onClick={apply}>
              Ship
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
          <Loader size="sm" /> loading
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
                    <Checkbox label={v.status === "deleted" ? "delete the file" : "the whole file"} checked={whole} onCheckedChange={(c) => setPick(path, a.id, c ? "whole" : null)} />
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
                                part {i + 1} · line {h.oldStart} · <span className="text-emerald-600 dark:text-emerald-400">+{h.lines.filter((l) => l.startsWith("+")).length}</span>{" "}
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
