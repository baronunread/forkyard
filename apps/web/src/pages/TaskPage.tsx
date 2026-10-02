import { Banner, Button, Empty, Loader, Switch, Tabs } from "@cloudflare/kumo";
import type { YardEvent } from "@forkyard/shared";
import { CaretDown, CaretUp, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentStrip } from "../components/AgentStrip";
import { AgentView } from "../components/AgentView";
import { CompareView } from "../components/CompareView";
import { DecideView } from "../components/DecideView";
import { FileTreePane } from "../components/FileTreePane";
import { LiveDot, TaskStatusBadge } from "../components/Status";
import { Timeline } from "../components/Timeline";
import { call, taskRoute, yardRoute } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync, useDebounced, usePersistent } from "../lib/data";
import { useYardLive } from "../lib/live";
import { navigate } from "../lib/router";
import { toasts } from "../lib/toast";

type View = "agent" | "compare" | "decide";

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
  const [view, setView] = usePersistent<View>("forkyard.view", "agent");
  const [split, setSplit] = usePersistent<boolean>("forkyard.split", true);
  const [wrap, setWrap] = usePersistent<boolean>("forkyard.wrap", false);
  const [showTimeline, setShowTimeline] = usePersistent<boolean>("forkyard.timeline", true);
  const [now, setNow] = useState(Date.now());
  const diffStyle = split ? "split" : "unified";

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Initial history for the timeline, then live.
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
      toasts.add({ title: "Overlap detected", description: `${e.data.overlap.path} — ${e.data.overlap.agents.join(" & ")}`, variant: "warning" });
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

  // ── keyboard: [ ] agents, 1-9 forks, j/k hunks, a/c/d views, s split, w wrap ──
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
      else if (ev.key === "d") setView("decide");
      else if (ev.key === "s") setSplit(!split);
      else if (ev.key === "w") setWrap(!wrap);
      else if (ev.key === "t") setShowTimeline(!showTimeline);
      else return;
      ev.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [agents, selectedAgent?.id, go, split, wrap, showTimeline, setView, setSplit, setWrap, setShowTimeline]);
  useEffect(() => {
    hunkIdx.current = -1;
  }, [selectedAgent?.id, view, selectedFile]);

  useCommands(
    "task",
    [
      ...agents.map((a, i) => ({ id: `agent-${a.id}`, group: "Agents", title: `Show ${a.name}'s fork`, hint: i < 9 ? String(i + 1) : undefined, run: () => go({ agent: a.id }) })),
      { id: "view-agent", group: "View", title: "Agent view", hint: "a", run: () => setView("agent") },
      { id: "view-compare", group: "View", title: "Compare a file across agents", hint: "c", run: () => setView("compare") },
      { id: "view-decide", group: "View", title: "Decide / assemble a merge", hint: "d", run: () => setView("decide") },
      { id: "toggle-split", group: "View", title: split ? "Unified diffs" : "Split diffs", hint: "s", run: () => setSplit(!split) },
      { id: "toggle-wrap", group: "View", title: wrap ? "Don't wrap lines" : "Wrap long lines", hint: "w", run: () => setWrap(!wrap) },
      ...files.slice(0, 200).map((f) => ({ id: `file-${f.path}`, group: "Files", title: f.path, run: () => go({ file: f.path }) })),
    ],
    [agents, files, split, wrap],
  );

  if (detail.error) return <Banner variant="error" title="Could not load task" description={detail.error.message} />;
  if (!d)
    return (
      <div className="flex items-center gap-2 p-6 text-kumo-subtle">
        <Loader /> loading task
      </div>
    );

  const activeOverlaps = d.overlaps.filter((o) => o.active);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{d.task.title}</h1>
        <TaskStatusBadge status={d.task.status} />
        <span className="font-mono text-xs text-kumo-subtle" title="Base commit this task forked from">
          base {d.task.baseCommit.slice(0, 7)}
        </span>
        {activeOverlaps.length > 0 && (
          <span className="inline-flex items-center gap-1 text-sm font-medium" style={{ color: "var(--fy-overlap)" }}>
            <Warning weight="fill" /> {activeOverlaps.length} active overlap{activeOverlaps.length > 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <LiveDot state={live} />
          <Switch size="sm" label="Split" checked={split} onCheckedChange={setSplit} />
          <Switch size="sm" label="Wrap" checked={wrap} onCheckedChange={setWrap} />
          <Button size="sm" variant="ghost" onClick={() => setShowTimeline(!showTimeline)} icon={showTimeline ? <CaretUp /> : <CaretDown />}>
            Timeline
          </Button>
        </span>
      </header>
      {d.task.brief && <p className="-mt-1 line-clamp-2 max-w-4xl text-sm text-kumo-subtle">{d.task.brief}</p>}

      <AgentStrip detail={d} compare={compare.data} selected={selectedAgent?.id ?? null} onSelect={(id) => go({ agent: id })} />

      <div className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: showTimeline ? "260px minmax(0,1fr) 320px" : "260px minmax(0,1fr)" }}>
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
          <div className="border-b border-kumo-hairline px-3 py-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Files touched · {files.length}
          </div>
          <div className="min-h-0 flex-1">
            {files.length ? (
              <FileTreePane
                files={files}
                agents={agents}
                selected={selectedFile}
                onSelect={(p) => {
                  go({ file: p });
                  if (view === "decide") setView("compare");
                }}
              />
            ) : (
              <Empty size="sm" title="No changes yet" description="Files appear as agents push." />
            )}
          </div>
        </aside>

        <main ref={mainRef} className="fy-scroll min-h-0 rounded-lg">
          <div className="sticky top-0 z-10 mb-3 bg-kumo-canvas pb-2">
            <Tabs
              variant="underline"
              value={view}
              onValueChange={(v) => setView(v as View)}
              tabs={[
                { value: "agent", label: selectedAgent ? `${selectedAgent.name}'s fork` : "Agent" },
                { value: "compare", label: "Compare file" },
                { value: "decide", label: d.task.status === "open" ? "Decide" : "Decision" },
              ]}
            />
          </div>
          {view === "agent" && selectedAgent && (
            <AgentView yard={yard} task={task} agent={selectedAgent} compare={compare.data} diffStyle={diffStyle} wrap={wrap} focusFile={selectedFile} />
          )}
          {view === "compare" && <CompareView yard={yard} task={task} detail={d} compare={compare.data} path={compareFile} diffStyle={diffStyle} wrap={wrap} />}
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

        {showTimeline && (
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
            <div className="border-b border-kumo-hairline px-3 py-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Timeline</div>
            <div className="min-h-0 flex-1">
              <Timeline events={events} agents={agents} now={now} />
            </div>
          </aside>
        )}
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
