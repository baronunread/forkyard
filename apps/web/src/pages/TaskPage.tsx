import { Banner, Button, Empty, Loader, Tabs } from "@cloudflare/kumo";
import type { YardEvent } from "@forkyard/shared";
import { ArrowLeft, GitMerge, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentStrip } from "../components/AgentStrip";
import { AgentView } from "../components/AgentView";
import { CompareView } from "../components/CompareView";
import { DecideView } from "../components/DecideView";
import { FileTreePane } from "../components/FileTreePane";
import { TaskStatusBadge } from "../components/Status";
import { Timeline } from "../components/Timeline";
import { call, taskRoute, yardRoute } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync, useDebounced, usePersistent } from "../lib/data";
import { useYardLive } from "../lib/live";
import { navigate } from "../lib/router";
import { toasts } from "../lib/toast";

type View = "agent" | "compare" | "activity" | "decide";

const RELEVANT = new Set([
  "agent.ready",
  "agent.failed",
  "agent.status",
  "push.received",
  "diff.updated",
  "intent.recorded",
  "review.completed",
  "overlap.detected",
  "overlap.cleared",
  "claim.added",
  "claim.released",
  "decision.made",
  "task.abandoned",
]);

export function TaskPage({ yard, task, agentParam, fileParam }: { yard: string; task: string; agentParam?: string; fileParam?: string }) {
  const detail = useAsync(() => call(taskRoute.$get({ param: { yard, task } })), [yard, task]);
  const compare = useAsync(() => call(taskRoute.compare.$get({ param: { yard, task } })), [yard, task]);
  const [events, setEvents] = useState<YardEvent[]>([]);
  const [view, setView] = useState<View>("agent");
  const [split, setSplit] = usePersistent<boolean>("forkyard.split", true);
  const [wrap, setWrap] = usePersistent<boolean>("forkyard.wrap", false);
  const [now, setNow] = useState(Date.now());
  const diffStyle = split ? "split" : "unified";

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    call(yardRoute.events.$get({ param: { yard }, query: { since: "0", limit: "1000", taskId: task } })).then(
      (r) => alive && setEvents((prev) => mergeEvents(r.events.filter((e) => e.taskId === task || e.taskId === null), prev)),
    );
    return () => {
      alive = false;
    };
  }, [yard, task]);

  const refresh = useDebounced(() => {
    detail.reload();
    compare.reload();
  }, 250);
  const live = useYardLive(yard, (e) => {
    if (e.taskId !== task && e.taskId !== null) return;
    setEvents((prev) => mergeEvents(prev, [e]));
    if (RELEVANT.has(e.type)) refresh();
    if (e.type === "overlap.detected")
      toasts.add({ title: "Overlap", description: `${e.data.overlap.path} — ${e.data.overlap.agents.join(" & ")}`, variant: "warning" });
  });

  const d = detail.data;
  const agents = useMemo(() => d?.agents ?? [], [d]);
  const selectedAgent = agents.find((a) => a.id === agentParam) ?? agents.find((a) => a.headCommit) ?? agents[0] ?? null;
  const files = compare.data?.files ?? [];
  const selectedFile = fileParam && files.some((f) => f.path === fileParam) ? fileParam : null;
  const compareFile = selectedFile ?? files.find((f) => f.overlap)?.path ?? files[0]?.path ?? null;

  const go = useCallback(
    (patch: { agent?: string; file?: string | null }) =>
      navigate({ name: "task", yard, task, agent: patch.agent ?? selectedAgent?.id, file: patch.file === null ? undefined : (patch.file ?? selectedFile ?? undefined) }, true),
    [yard, task, selectedAgent?.id, selectedFile],
  );

  // Keyboard: [ ] agents, 1-9 forks, j/k hunks, a/c/l/d views, s split, w wrap.
  const mainRef = useRef<HTMLDivElement>(null);
  const hunkIdx = useRef(-1);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      const idx = agents.findIndex((a) => a.id === selectedAgent?.id);
      if (ev.key === "]" && agents.length) go({ agent: agents[(idx + 1) % agents.length]!.id });
      else if (ev.key === "[" && agents.length) go({ agent: agents[(idx - 1 + agents.length) % agents.length]!.id });
      else if (/^[1-9]$/.test(ev.key) && agents[Number(ev.key) - 1]) go({ agent: agents[Number(ev.key) - 1]!.id });
      else if (ev.key === "j" || ev.key === "k") {
        const anchors = [...(mainRef.current?.querySelectorAll<HTMLElement>("[data-hunk]") ?? [])];
        if (!anchors.length) return;
        anchors.forEach((a) => a.classList.remove("fy-hunk-focus"));
        hunkIdx.current = Math.max(0, Math.min(anchors.length - 1, hunkIdx.current + (ev.key === "j" ? 1 : -1)));
        const el = anchors[hunkIdx.current]!;
        el.classList.add("fy-hunk-focus");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (ev.key === "a") setView("agent");
      else if (ev.key === "c") setView("compare");
      else if (ev.key === "l") setView("activity");
      else if (ev.key === "d") setView("decide");
      else if (ev.key === "s") setSplit(!split);
      else if (ev.key === "w") setWrap(!wrap);
      else return;
      ev.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [agents, selectedAgent?.id, go, split, wrap, setSplit, setWrap]);
  useEffect(() => {
    hunkIdx.current = -1;
  }, [selectedAgent?.id, view, selectedFile]);

  useCommands(
    "task",
    [
      ...agents.map((a, i) => ({ id: `agent-${a.id}`, group: "Agents", title: `${a.name}'s changes`, hint: i < 9 ? String(i + 1) : undefined, run: () => go({ agent: a.id }) })),
      { id: "view-agent", group: "View", title: "Changes", hint: "a", run: () => setView("agent") },
      { id: "view-compare", group: "View", title: "Compare a file across agents", hint: "c", run: () => setView("compare") },
      { id: "view-activity", group: "View", title: "Activity", hint: "l", run: () => setView("activity") },
      { id: "view-decide", group: "View", title: "Decide", hint: "d", run: () => setView("decide") },
      { id: "toggle-split", group: "View", title: split ? "Unified diffs" : "Split diffs", hint: "s", run: () => setSplit(!split) },
      { id: "toggle-wrap", group: "View", title: wrap ? "Don't wrap lines" : "Wrap long lines", hint: "w", run: () => setWrap(!wrap) },
      ...files.slice(0, 200).map((f) => ({ id: `file-${f.path}`, group: "Files", title: f.path, run: () => go({ file: f.path }) })),
    ],
    [agents, files, split, wrap],
  );

  if (detail.error) return <Banner variant="error" title="Could not load task" description={detail.error.message} />;
  if (!d)
    return (
      <div className="p-10">
        <Loader />
      </div>
    );

  const overlaps = d.overlaps.filter((o) => o.active).length;
  const open = d.task.status === "open";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-5 px-6 pb-5 pt-6">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="fy-h1 truncate">{d.task.title}</h1>
              <TaskStatusBadge status={d.task.status} />
              {overlaps > 0 && (
                <span className="inline-flex items-center gap-1 text-sm" style={{ color: "var(--fy-overlap)" }}>
                  <Warning weight="fill" /> {overlaps} overlap{overlaps > 1 ? "s" : ""}
                </span>
              )}
              {live !== "live" && <span className="text-xs text-kumo-subtle">Reconnecting…</span>}
            </div>
            {d.task.brief && <p className="mt-1 line-clamp-1 max-w-3xl text-kumo-subtle">{d.task.brief}</p>}
          </div>
          {view === "decide" ? (
            <Button icon={<ArrowLeft />} onClick={() => setView("agent")}>
              Back
            </Button>
          ) : (
            <Button variant="primary" className="fy-primary" icon={<GitMerge />} onClick={() => setView("decide")}>
              {open ? "Decide" : "Decision"}
            </Button>
          )}
        </header>
        <AgentStrip
          detail={d}
          compare={compare.data}
          selected={view === "agent" ? (selectedAgent?.id ?? null) : null}
          onSelect={(id) => {
            go({ agent: id });
            setView("agent");
          }}
        />
      </div>

      <div className="grid min-h-0 flex-1 gap-6 px-6 pb-6" style={{ gridTemplateColumns: "240px minmax(0,1fr)" }}>
        <aside className="flex min-h-0 flex-col">
          <div className="fy-eyebrow flex h-9 items-center justify-between">
            <span>Files</span>
            <span>{files.length}</span>
          </div>
          <div className="fy-card min-h-0 flex-1 overflow-hidden">
            {files.length ? (
              <FileTreePane
                files={files}
                agents={agents}
                selected={selectedFile}
                onSelect={(p) => {
                  go({ file: p });
                  if (view !== "agent") setView("compare");
                }}
              />
            ) : (
              <Empty size="sm" title="No changes yet" description="Files appear as agents push." />
            )}
          </div>
        </aside>

        <main ref={mainRef} className="fy-scroll min-h-0 px-px">
          {view !== "decide" && (
            <div className="sticky top-0 z-10 mb-4 flex h-9 items-center justify-between gap-4" style={{ background: "var(--fy-page)" }}>
              <Tabs
                variant="underline"
                size="sm"
                value={view}
                onValueChange={(v) => setView(v as View)}
                tabs={[
                  { value: "agent", label: "Changes" },
                  { value: "compare", label: "Compare" },
                  { value: "activity", label: "Activity" },
                ]}
              />
              {view !== "activity" && (
                <Tabs
                  size="sm"
                  variant="segmented"
                  value={split ? "split" : "unified"}
                  onValueChange={(v) => setSplit(v === "split")}
                  tabs={[
                    { value: "split", label: "Split" },
                    { value: "unified", label: "Unified" },
                  ]}
                />
              )}
            </div>
          )}
          {view === "agent" && selectedAgent && (
            <AgentView yard={yard} task={task} agent={selectedAgent} compare={compare.data} diffStyle={diffStyle} wrap={wrap} focusFile={selectedFile} />
          )}
          {view === "compare" && <CompareView yard={yard} task={task} detail={d} compare={compare.data} path={compareFile} diffStyle={diffStyle} wrap={wrap} />}
          {view === "activity" && (
            <div className="fy-card overflow-hidden">
              <Timeline events={events} agents={agents} now={now} />
            </div>
          )}
          {view === "decide" && (
            <DecideView
              yard={yard}
              task={task}
              detail={d}
              compare={compare.data}
              diffStyle={diffStyle}
              wrap={wrap}
              onDecided={() => {
                detail.reload();
                compare.reload();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function mergeEvents(a: YardEvent[], b: YardEvent[]): YardEvent[] {
  const m = new Map<number, YardEvent>();
  for (const e of a) m.set(e.seq, e);
  for (const e of b) m.set(e.seq, e);
  return [...m.values()].sort((x, y) => x.seq - y.seq);
}
