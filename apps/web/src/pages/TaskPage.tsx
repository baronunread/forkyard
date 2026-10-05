import { Banner, Empty, Loader, Tabs } from "@cloudflare/kumo";
import { ArrowLeft, GitMerge, Warning } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentBoard } from "../components/AgentBoard";
import { AgentStrip } from "../components/AgentStrip";
import { AgentView } from "../components/AgentView";
import { CompareView } from "../components/CompareView";
import { DecideView } from "../components/DecideView";
import { FileTreePane } from "../components/FileTreePane";
import { TaskStatusBadge } from "../components/Status";
import { Timeline } from "../components/Timeline";
import { Button, Card, SectionTitle } from "../components/ui";
import { useCommands } from "../lib/commands";
import { useYardSync } from "../lib/live";
import { usePersistent } from "../lib/persistent";
import { compareQuery, taskEventsQuery, taskQuery } from "../lib/queries";
import { TASK_VIEWS, type TaskSearch } from "../lib/search";
import { toasts } from "../lib/toast";

type View = (typeof TASK_VIEWS)[number];

/** Past this many agents, the task shows a leaderboard instead of one card per agent. */
const SWARM_THRESHOLD = 8;

/** Classes put on the focused hunk banner by j / k. */
const HUNK_FOCUS = ["outline-2", "outline-offset-2", "outline-link", "rounded-md"];

export function TaskPage({ yard, task, search }: { yard: string; task: string; search: TaskSearch }) {
  const detail = useQuery(taskQuery(yard, task));
  const compare = useQuery(compareQuery(yard, task));
  const events = useQuery(taskEventsQuery(yard, task));
  const navigate = useNavigate();
  const [split, setSplit] = usePersistent<boolean>("forkyard.split", true);
  const [wrap, setWrap] = usePersistent<boolean>("forkyard.wrap", false);
  const [now, setNow] = useState(Date.now());
  const diffStyle = split ? "split" : "unified";
  const view: View = search.view ?? "changes";

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const live = useYardSync(yard, (e) => {
    // On a swarm-sized task overlaps are constant; the leaderboard and hot files carry them instead.
    if (e.type === "overlap.detected" && e.taskId === task && (detail.data?.agents.length ?? 0) <= SWARM_THRESHOLD)
      toasts.add({ title: "Overlap", description: `${e.data.overlap.path} — ${e.data.overlap.agents.join(" & ")}`, variant: "warning" });
  });

  const d = detail.data;
  const agents = useMemo(() => d?.agents ?? [], [d]);
  const selectedAgent = agents.find((a) => a.id === search.agent) ?? agents.find((a) => a.headCommit) ?? agents[0] ?? null;
  const files = compare.data?.files ?? [];
  const selectedFile = search.file && files.some((f) => f.path === search.file) ? search.file : null;
  const compareFile = selectedFile ?? files.find((f) => f.overlap)?.path ?? files[0]?.path ?? null;

  /** Everything about where you are on this page lives in the URL (?agent=&file=&view=). */
  const go = (patch: Partial<TaskSearch>) =>
    void navigate({ to: "/y/$yard/t/$task", params: { yard, task }, search: (s: TaskSearch) => ({ ...s, ...patch }), replace: true });
  const setView = (v: View) => go({ view: v === "changes" ? undefined : v });

  // Keyboard: [ ] agents, 1-9 forks, j/k hunks, a/c/l/d views, s split, w wrap.
  const mainRef = useRef<HTMLDivElement>(null);
  const hunkIdx = useRef(-1);
  useEffect(() => {
    hunkIdx.current = -1;
  }, [selectedAgent?.id, view, selectedFile]);
  const moveHunk = (delta: 1 | -1) => {
    const anchors = [...(mainRef.current?.querySelectorAll<HTMLElement>("[data-hunk]") ?? [])];
    if (!anchors.length) return;
    anchors.forEach((a) => a.classList.remove(...HUNK_FOCUS));
    hunkIdx.current = Math.max(0, Math.min(anchors.length - 1, hunkIdx.current + delta));
    const el = anchors[hunkIdx.current]!;
    el.classList.add(...HUNK_FOCUS);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const idx = agents.findIndex((a) => a.id === selectedAgent?.id);
  const keys: UseHotkeyDefinition[] = [
    { hotkey: "]", callback: () => agents.length && go({ agent: agents[(idx + 1) % agents.length]!.id }) },
    { hotkey: "[", callback: () => agents.length && go({ agent: agents[(idx - 1 + agents.length) % agents.length]!.id }) },
    { hotkey: "J", callback: () => moveHunk(1) },
    { hotkey: "K", callback: () => moveHunk(-1) },
    { hotkey: "A", callback: () => setView("changes") },
    { hotkey: "C", callback: () => setView("compare") },
    { hotkey: "L", callback: () => setView("activity") },
    { hotkey: "D", callback: () => setView("decide") },
    { hotkey: "S", callback: () => setSplit(!split) },
    { hotkey: "W", callback: () => setWrap(!wrap) },
    ...(["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).map((k, i) => ({ hotkey: k, callback: () => agents[i] && go({ agent: agents[i].id, view: undefined }) })),
  ];
  useHotkeys(keys, { preventDefault: true });

  useCommands(
    "task",
    [
      ...agents.map((a, i) => ({ id: `agent-${a.id}`, group: "Agents", title: `${a.name}'s changes`, hint: i < 9 ? String(i + 1) : undefined, run: () => go({ agent: a.id, view: undefined }) })),
      { id: "view-agent", group: "View", title: "Changes", hint: "a", run: () => setView("changes") },
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
      <div className="flex flex-col gap-5 px-6 pt-6 pb-5">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-h1">{d.task.title}</h1>
              <TaskStatusBadge status={d.task.status} />
              {overlaps > 0 && (
                <span className="inline-flex items-center gap-1 text-sm text-overlap">
                  <Warning weight="fill" /> {overlaps} overlap{overlaps > 1 ? "s" : ""}
                </span>
              )}
              {live !== "live" && <span className="text-xs text-body">Reconnecting…</span>}
            </div>
            {d.task.brief && <p className="mt-1 line-clamp-1 max-w-3xl text-body">{d.task.brief}</p>}
          </div>
          {view === "decide" ? (
            <Button icon={<ArrowLeft />} onClick={() => setView("changes")}>
              Back
            </Button>
          ) : (
            <Button variant="primary" icon={<GitMerge />} onClick={() => setView("decide")}>
              {open ? "Decide" : "Decision"}
            </Button>
          )}
        </header>
        {agents.length > SWARM_THRESHOLD ? (
          <AgentBoard detail={d} compare={compare.data ?? null} selected={selectedAgent?.id ?? null} onSelect={(id) => go({ agent: id, view: undefined })} />
        ) : (
          <AgentStrip detail={d} selected={view === "changes" ? (selectedAgent?.id ?? null) : null} onSelect={(id) => go({ agent: id, view: undefined })} />
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-6 px-6 pb-6">
        <aside className="flex min-h-0 flex-col">
          <div className="flex h-9 items-center justify-between">
            <SectionTitle>Files</SectionTitle>
            <span className="text-xs text-muted tabular-nums">{files.length}</span>
          </div>
          <Card className="min-h-0 flex-1 overflow-hidden">
            {files.length ? (
              <FileTreePane files={files} agents={agents} selected={selectedFile} onSelect={(p) => go({ file: p, view: view === "changes" ? undefined : "compare" })} />
            ) : (
              <Empty size="sm" title="No changes yet" description="Files appear as agents push." />
            )}
          </Card>
        </aside>

        <div ref={mainRef} className="min-h-0 overflow-auto px-px [scrollbar-gutter:stable]">
          {view !== "decide" && (
            <div className="sticky top-0 z-10 mb-4 flex h-9 items-center justify-between gap-4 bg-page">
              <Tabs
                variant="underline"
                size="sm"
                value={view}
                onValueChange={(v) => setView(v as View)}
                tabs={[
                  { value: "changes", label: "Changes" },
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
          {view === "changes" && selectedAgent && (
            <AgentView yard={yard} task={task} agent={selectedAgent} compare={compare.data ?? null} diffStyle={diffStyle} wrap={wrap} focusFile={selectedFile} />
          )}
          {view === "compare" && <CompareView yard={yard} task={task} detail={d} compare={compare.data ?? null} path={compareFile} diffStyle={diffStyle} wrap={wrap} />}
          {view === "activity" && (
            <Card className="overflow-hidden">
              <Timeline events={events.data ?? []} agents={agents} now={now} />
            </Card>
          )}
          {view === "decide" && <DecideView yard={yard} task={task} detail={d} compare={compare.data ?? null} diffStyle={diffStyle} wrap={wrap} />}
        </div>
      </div>
    </div>
  );
}
