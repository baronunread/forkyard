import { ClipboardText, Empty, Loader } from "@cloudflare/kumo";
import { CaretRight, Plus, Tray } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AskCard } from "../components/AskCard";
import { Backlog } from "../components/Backlog";
import { CreateTaskDialog, CreateYardDialog, DeleteYardDialog } from "../components/CreateDialogs";
import { Button, Card, cx, Dot, SectionTitle } from "../components/ui";
import type { YardList, YardStatus } from "../lib/api";
import { useCommands } from "../lib/commands";
import { ago } from "../lib/format";
import { useYardSync } from "../lib/live";
import { taskPhase, type Tone } from "../lib/phase";
import { inboxQuery, yardQuery, yardsQuery } from "../lib/queries";

/**
 * Home. Agents do the work and autopilot merges it; this page answers two
 * questions at a glance: does anything need me, and is everything moving?
 *
 * Left: "Everything" plus each yard. Right: whatever is selected.
 */
export function Overview({ yard }: { yard: string | null }) {
  const yards = useQuery(yardsQuery);
  const navigate = useNavigate();
  const [newYard, setNewYard] = useState(false);
  const list = yards.data ?? [];

  // j / k move through Everything and the yards.
  const stops = [null, ...list.map((y) => y.id)];
  const step = (d: 1 | -1) => {
    const i = stops.indexOf(yard);
    const next = stops[(i + d + stops.length) % stops.length] ?? null;
    void navigate(next ? { to: "/y/$yard", params: { yard: next } } : { to: "/" });
  };
  useHotkeys([
    { hotkey: "J", callback: () => step(1) },
    { hotkey: "K", callback: () => step(-1) },
  ]);
  useCommands(
    "overview",
    [
      { id: "new-yard", group: "Actions", title: "New yard", run: () => setNewYard(true) },
      ...list.map((y) => ({ id: `yard-${y.id}`, group: "Yards", title: y.name, run: () => void navigate({ to: "/y/$yard", params: { yard: y.id } }) })),
    ],
    [list],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[264px_minmax(0,1fr)] max-md:grid-cols-1">
      <Rail yards={list} loading={yards.isPending} selected={yard} onNew={() => setNewYard(true)} />
      <div className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {yards.isPending ? (
          <div className="p-10">
            <Loader />
          </div>
        ) : !list.length ? (
          <div className="mx-auto max-w-lg px-6 py-20">
            <Empty title="No yards yet" description="A yard is one repo plus the agents working on it." />
            <div className="mt-4 flex justify-center">
              <Button variant="primary" icon={<Plus />} onClick={() => setNewYard(true)}>
                New yard
              </Button>
            </div>
          </div>
        ) : yard ? (
          <YardOverview key={yard} yard={yard} />
        ) : (
          <Everything yards={list} />
        )}
      </div>
      <CreateYardDialog open={newYard} setOpen={setNewYard} />
    </div>
  );
}

// ── left ───────────────────────────────────────────────────────────────────

function Rail({ yards, loading, selected, onNew }: { yards: YardList; loading: boolean; selected: string | null; onNew: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? yards.filter((y) => `${y.name} ${y.id}`.toLowerCase().includes(s)) : yards;
  }, [yards, q]);
  const needsYou = yards.reduce((n, y) => n + y.summary.needsYou, 0);
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-surface max-md:hidden" aria-label="Yards">
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-3">
        <RailItem to={null} on={selected === null} label="Everything" icon={<Tray size={16} />} count={needsYou} />
        <div className="mt-5 mb-1 flex items-center justify-between pr-1 pl-3">
          <SectionTitle className="text-body">Yards</SectionTitle>
          <Button size="icon" variant="ghost" icon={<Plus />} onClick={onNew} aria-label="New yard" />
        </div>
        {yards.length > 8 && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter"
            aria-label="Filter yards"
            className="mx-1 mb-1 h-8 w-[calc(100%-8px)] rounded-md bg-surface-2 px-2.5 text-[13px] text-fg ring-1 ring-line outline-none placeholder:text-muted focus:ring-link"
          />
        )}
        {loading && (
          <div className="p-3">
            <Loader size="sm" />
          </div>
        )}
        {shown.map((y) => (
          <RailItem
            key={y.id}
            to={y.id}
            on={y.id === selected}
            label={y.name}
            count={y.summary.needsYou}
            busy={y.summary.activeAgents > 0}
          />
        ))}
      </nav>
      <div className="border-t border-line p-4">
        <SectionTitle>Connect an agent</SectionTitle>
        <p className="mt-1 mb-2 text-xs text-body">Add this MCP server to Claude Code, Codex or Cursor.</p>
        <ClipboardText text={`${location.origin}/mcp`} />
      </div>
    </aside>
  );
}

function RailItem({ to, on, label, icon, count, busy }: { to: string | null; on: boolean; label: string; icon?: React.ReactNode; count: number; busy?: boolean }) {
  const cls = cx("flex h-9 items-center gap-2.5 rounded-md px-3 text-[14px]", on ? "bg-selected font-medium text-fg" : "text-body hover:bg-hover hover:text-fg");
  const body = (
    <>
      {icon ?? <span title={busy ? "Agents working" : "Idle"}><Dot color={busy ? "var(--color-busy)" : "var(--color-line-strong)"} pulse={busy} /></span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <NeedsBadge n={count} />}
    </>
  );
  return to ? (
    <Link to="/y/$yard" params={{ yard: to }} aria-current={on ? "page" : undefined} className={cls}>
      {body}
    </Link>
  ) : (
    <Link to="/" aria-current={on ? "page" : undefined} className={cls}>
      {body}
    </Link>
  );
}

function NeedsBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-overlap px-1.5 text-[11px] font-semibold text-white tabular-nums" title={`${n} waiting on you`}>
      {n}
    </span>
  );
}

// ── right: everything ──────────────────────────────────────────────────────

function Everything({ yards }: { yards: YardList }) {
  const inbox = useQuery(inboxQuery);
  const asks = inbox.data?.asks ?? [];
  const agents = yards.reduce((n, y) => n + y.summary.activeAgents, 0);
  const open = yards.reduce((n, y) => n + y.summary.openTasks, 0);
  return (
    <Page>
      <h1 className="text-h1">{asks.length ? `${asks.length} ${asks.length === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}</h1>
      <p className="mt-1.5 text-body">{agents ? `${agents} agents are working on ${open} ${open === 1 ? "task" : "tasks"} across ${yards.length} ${yards.length === 1 ? "yard" : "yards"}.` : "No agents are working right now."}</p>

      {asks.length > 0 && (
        <Section title="Needs you">
          <div className="space-y-3">
            {asks.map((a) => (
              <AskCard key={a.id} ask={a} agent={a.agent} taskTitle={a.taskTitle} yardName={a.yardName} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Yards">
        <Card className="divide-y divide-line overflow-hidden">
          {yards.map((y) => (
            <Link key={y.id} to="/y/$yard" params={{ yard: y.id }} className="flex items-center gap-4 px-5 py-4 hover:bg-hover">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{y.name}</div>
                <div className="mt-0.5 text-[13px] text-body">
                  {y.summary.openTasks
                    ? `${y.summary.openTasks} ${y.summary.openTasks === 1 ? "task" : "tasks"} in progress · ${y.summary.activeAgents} ${y.summary.activeAgents === 1 ? "agent" : "agents"}`
                    : y.summary.decidedTasks
                      ? `${y.summary.decidedTasks} shipped`
                      : "No tasks yet"}
                </div>
              </div>
              {y.summary.needsYou > 0 && <span className="text-[13px] font-medium text-overlap">{y.summary.needsYou} need you</span>}
              <CaretRight className="text-muted" />
            </Link>
          ))}
        </Card>
      </Section>
    </Page>
  );
}

// ── right: one yard ────────────────────────────────────────────────────────

const DONE_SHOWN = 5;

function YardOverview({ yard }: { yard: string }) {
  const status = useQuery(yardQuery(yard));
  const live = useYardSync(yard);
  const navigate = useNavigate();
  const [newTask, setNewTask] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useHotkeys([{ hotkey: "N", callback: () => setNewTask(true) }]);
  useCommands(
    "yard",
    [
      { id: "new-task", group: "Actions", title: "New task", hint: "n", run: () => setNewTask(true) },
      { id: "delete-yard", group: "Actions", title: "Delete yard…", run: () => setDeleting(true) },
      ...(status.data?.tasks ?? []).map((t) => ({
        id: `task-${t.id}`,
        group: "Tasks",
        title: t.title,
        run: () => void navigate({ to: "/y/$yard/t/$task", params: { yard, task: t.id } }),
      })),
    ],
    [status.data],
  );

  if (status.error)
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <Empty title="Can't load this yard" description={status.error.message} />
      </div>
    );
  const s = status.data;
  if (!s)
    return (
      <div className="p-10">
        <Loader />
      </div>
    );

  const open = s.tasks.filter((t) => t.status === "open");
  const done = s.tasks.filter((t) => t.status !== "open").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const working = s.agents.filter((a) => open.some((t) => t.id === a.taskId) && a.status !== "failed" && a.status !== "retired").length;
  const taskTitle = (id: string | null) => s.tasks.find((t) => t.id === id)?.title ?? null;
  const agentOf = (taskId: string | null, id: string | null) => s.agents.find((a) => a.taskId === taskId && a.id === id) ?? null;

  const summary = [
    open.length ? `${open.length} ${open.length === 1 ? "task" : "tasks"} in progress` : "Nothing in progress",
    working ? `${working} agents working` : null,
    s.pulse.pushesPerMin ? `${s.pulse.pushesPerMin} pushes a minute` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page>
      <header className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-h1">{s.yard.name}</h1>
            <span title={live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline"}>
              <Dot color={live === "live" ? "var(--color-good)" : live === "connecting" ? "var(--color-busy)" : "var(--color-bad)"} pulse={live !== "live"} />
            </span>
          </div>
          <p className="mt-1.5 text-body">{summary}</p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => setNewTask(true)}>
          New task
        </Button>
      </header>

      {s.asks.length > 0 && (
        <Section title="Needs you">
          <div className="space-y-3">
            {s.asks.map((a) => (
              <AskCard key={a.id} ask={a} agent={agentOf(a.taskId, a.agentId)} taskTitle={taskTitle(a.taskId)} />
            ))}
          </div>
        </Section>
      )}

      <Section title="In progress">
        {open.length ? (
          <Card className="divide-y divide-line overflow-hidden">
            {open.map((t) => (
              <TaskRow key={t.id} yard={yard} task={t} status={s} now={now} />
            ))}
          </Card>
        ) : (
          <Card className="flex items-center justify-between gap-4 px-5 py-4">
            <p className="text-[14px] text-body">Start a task and agents pick it up. You'll only hear from them if they're stuck.</p>
            <Button size="sm" onClick={() => setNewTask(true)}>
              New task
            </Button>
          </Card>
        )}
      </Section>

      <Backlog yard={yard} />

      {done.length > 0 && (
        <Section
          title="Done"
          aside={
            done.length > DONE_SHOWN && (
              <button className="text-[13px] text-body hover:text-fg" onClick={() => setAllDone(!allDone)}>
                {allDone ? "Show fewer" : `Show all ${done.length}`}
              </button>
            )
          }
        >
          <Card className="divide-y divide-line overflow-hidden">
            {(allDone ? done : done.slice(0, DONE_SHOWN)).map((t) => (
              <TaskRow key={t.id} yard={yard} task={t} status={s} now={now} />
            ))}
          </Card>
        </Section>
      )}
      <Section title="Delete this yard">
        <Card className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="text-[14px] text-body">Removes the repo, every agent's fork, its tasks and backlog. There's no undo.</p>
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
            Delete yard
          </Button>
        </Card>
      </Section>
      <CreateTaskDialog yard={yard} open={newTask} setOpen={setNewTask} />
      <DeleteYardDialog yard={yard} name={s.yard.name} open={deleting} setOpen={setDeleting} />
    </Page>
  );
}

const TONE: Record<Tone, string> = {
  calm: "var(--color-muted)",
  busy: "var(--color-busy)",
  attention: "var(--color-overlap)",
  done: "var(--color-good)",
};

function TaskRow({ yard, task, status, now }: { yard: string; task: YardStatus["tasks"][number]; status: YardStatus; now: number }) {
  const agents = status.agents.filter((a) => a.taskId === task.id);
  const needs = status.asks.filter((a) => a.taskId === task.id).length;
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const phase = taskPhase(task, agents, status.autopilot[task.id], needs, status.decisions[task.id], name);
  const open = task.status === "open";
  return (
    <Link to="/y/$yard/t/$task" params={{ yard, task: task.id }} className="flex items-center gap-5 px-5 py-4 hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className={cx("truncate font-medium", !open && "text-body")}>{task.title}</div>
        <div className={cx("mt-1 flex items-center gap-2 text-[13px]", phase.tone === "attention" ? "font-medium text-overlap" : "text-body")}>
          <Dot color={TONE[phase.tone]} pulse={phase.tone === "busy"} />
          {phase.label}
        </div>
      </div>
      {open && phase.progress !== null && (
        <span className="h-1 w-32 shrink-0 overflow-hidden rounded-full bg-line max-sm:hidden" title={`${Math.round(phase.progress * 100)}% reviewed`}>
          <span className="block h-full rounded-full bg-ink transition-[width] duration-500" style={{ width: `${Math.max(2, phase.progress * 100)}%` }} />
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-xs text-muted">{ago(task.decidedAt ?? task.createdAt, now)}</span>
      <CaretRight className="shrink-0 text-muted" />
    </Link>
  );
}

// ── layout ─────────────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-8 py-10 max-sm:px-4">{children}</div>;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10" aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        {aside}
      </div>
      {children}
    </section>
  );
}
