import { ClipboardText, Empty, Loader } from "@cloudflare/kumo";
import { describeEvent, type YardEvent } from "@forkyard/shared";
import { CaretRight, GitBranch, MagnifyingGlass, Plus, Warning } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AgentBadge, AgentStack } from "../components/AgentChip";
import { CreateTaskDialog, CreateYardDialog } from "../components/CreateDialogs";
import { STATUS, TaskStatusBadge } from "../components/Status";
import { Button, Card, cx, Dot, Kbd, SectionTitle, Stat } from "../components/ui";
import type { YardList, YardStatus } from "../lib/api";
import { useCommands } from "../lib/commands";
import { ago } from "../lib/format";
import { useYardSync, type LiveState } from "../lib/live";
import { usePulse } from "../lib/pulse";
import { baseLogQuery, yardQuery, yardsQuery } from "../lib/queries";

/**
 * Home: every yard (repo + its agents) on the left; the selected one's
 * overview on the right. Picking another yard swaps the overview in place
 * (it is a route, /y/$yard, so it deep-links and the back button works).
 */
export function Overview({ yard }: { yard: string | null }) {
  const yards = useQuery(yardsQuery);
  const navigate = useNavigate();
  const [newYard, setNewYard] = useState(false);
  const list = yards.data ?? [];
  const selected = yard ?? list[0]?.id ?? null;

  // j / k move through yards.
  const step = (d: 1 | -1) => {
    if (!list.length) return;
    const i = list.findIndex((y) => y.id === selected);
    const next = list[(i + d + list.length) % list.length]!;
    void navigate({ to: "/y/$yard", params: { yard: next.id } });
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
    <div className="grid h-full min-h-0 grid-cols-[288px_minmax(0,1fr)] max-md:grid-cols-1">
      <YardRail yards={list} loading={yards.isPending} selected={selected} onNew={() => setNewYard(true)} />
      <div className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {yards.isPending ? (
          <div className="p-10">
            <Loader />
          </div>
        ) : selected ? (
          <YardOverview key={selected} yard={selected} />
        ) : (
          <div className="mx-auto max-w-lg px-6 py-20">
            <Empty title="No yards yet" description="A yard is one repo plus the agents working on it. Create one to fan out your first task." />
            <div className="mt-4 flex justify-center">
              <Button variant="primary" icon={<Plus />} onClick={() => setNewYard(true)}>
                New yard
              </Button>
            </div>
          </div>
        )}
      </div>
      <CreateYardDialog open={newYard} setOpen={setNewYard} />
    </div>
  );
}

// ── left: every yard ───────────────────────────────────────────────────────

function YardRail({ yards, loading, selected, onNew }: { yards: YardList; loading: boolean; selected: string | null; onNew: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? yards.filter((y) => `${y.name} ${y.id} ${y.baseRepo}`.toLowerCase().includes(s)) : yards;
  }, [yards, q]);
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-surface max-md:hidden" aria-label="Yards">
      <div className="flex items-center justify-between px-4 pt-5 pb-3">
        <SectionTitle>
          Yards <span className="font-normal text-muted tabular-nums">{yards.length}</span>
        </SectionTitle>
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={onNew} aria-label="New yard">
          New
        </Button>
      </div>
      <label className="mx-3 mb-2 flex h-8 items-center gap-2 rounded-md bg-surface-2 px-2.5 text-body ring-1 ring-line focus-within:ring-link">
        <MagnifyingGlass size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter yards" className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted" />
      </label>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && <div className="p-3"><Loader size="sm" /></div>}
        {shown.map((y) => {
          const on = y.id === selected;
          return (
            <Link
              key={y.id}
              to="/y/$yard"
              params={{ yard: y.id }}
              aria-current={on ? "page" : undefined}
              className={cx("group relative mb-0.5 flex flex-col gap-1 rounded-md px-3 py-2.5", on ? "bg-selected" : "hover:bg-hover")}
            >
              {on && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-ink" />}
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{y.name}</span>
                {y.summary.activeAgents > 0 && <Dot color="var(--color-busy)" pulse className="ml-auto" />}
              </span>
              <span className="truncate font-mono text-[11px] text-muted">
                {y.baseRepo} · {y.defaultBranch}
              </span>
              <span className="flex items-center gap-2 text-xs text-body">
                <span>{y.summary.openTasks} open</span>
                <span className="text-line-strong">·</span>
                <span>{y.summary.activeAgents} agents working</span>
                {y.summary.lastActivityAt && <span className="ml-auto text-muted">{ago(y.summary.lastActivityAt)}</span>}
              </span>
            </Link>
          );
        })}
        {!loading && yards.length > 0 && shown.length === 0 && <p className="px-3 py-2 text-[13px] text-body">No yard matches “{q}”.</p>}
      </nav>
      <div className="border-t border-line p-4">
        <SectionTitle>Connect an agent</SectionTitle>
        <p className="mt-1.5 text-xs text-body">Add this MCP server to Claude Code, Codex or Cursor. It signs you in and asks what the agent works on.</p>
        <div className="mt-2">
          <ClipboardText text={`${location.origin}/mcp`} />
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> switch yards
        </p>
      </div>
    </aside>
  );
}

// ── right: the selected yard ───────────────────────────────────────────────

function YardOverview({ yard }: { yard: string }) {
  const status = useQuery(yardQuery(yard));
  const base = useQuery(baseLogQuery(yard));
  const live = useYardSync(yard);
  const navigate = useNavigate();
  const [newTask, setNewTask] = useState(false);
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
  const decided = s.tasks.filter((t) => t.status === "decided");
  const openIds = new Set(open.map((t) => t.id));
  const working = s.agents.filter((a) => openIds.has(a.taskId) && ["forking", "ready", "working", "pushed", "reviewed"].includes(a.status));
  const head = base.data?.commits[0];
  const tasks = [...s.tasks].sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="mx-auto max-w-6xl px-8 py-8 max-sm:px-4">
      <header className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-h1">{s.yard.name}</h1>
            <LiveBadge state={live} connected={s.connected} />
          </div>
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-xs text-body">
            <GitBranch size={13} className="shrink-0" />
            <span className="truncate">
              {s.yard.baseRepo} · {s.yard.defaultBranch}
              {head && (
                <>
                  {" · "}
                  <span className="text-fg">{head.hash.slice(0, 7)}</span> {head.message.split("\n")[0]}
                </>
              )}
            </span>
          </p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => setNewTask(true)}>
          New task
        </Button>
      </header>

      <section className="mt-6 grid grid-cols-4 gap-3 max-lg:grid-cols-2" aria-label="At a glance">
        <Stat label="Open tasks" value={open.length} caption={`${s.tasks.length} total`} />
        <Stat label="Agents working" value={working.length} caption={`${s.connected.agents} connected now`} />
        <Stat
          label="Overlaps"
          value={s.overlaps.length}
          tone={s.overlaps.length ? "warn" : undefined}
          caption={s.overlaps.length ? `on ${new Set(s.overlaps.map((o) => o.path)).size} file(s)` : "no collisions"}
        />
        <Stat label="Decided" value={decided.length} caption={decided[0]?.decidedAt ? `last ${ago(decided[0].decidedAt, now)}` : "nothing shipped yet"} />
      </section>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6 max-lg:grid-cols-1">
        <section aria-label="Tasks">
          <div className="mb-2 flex h-8 items-center justify-between">
            <SectionTitle>Tasks</SectionTitle>
            <span className="text-xs text-muted">{open.length} open</span>
          </div>
          {tasks.length === 0 ? (
            <Card className="py-10">
              <Empty title="No tasks yet" description="A task fans out to several agents, each in its own fork." />
            </Card>
          ) : (
            <Card className="divide-y divide-line overflow-hidden">
              {tasks.map((t) => (
                <TaskRow key={t.id} yard={yard} task={t} status={s} now={now} />
              ))}
            </Card>
          )}
          {s.overlaps.length > 0 && <HotFiles status={s} />}
          {working.length > 0 && (
            <>
              <div className="mt-6 mb-2 flex h-8 items-center justify-between">
                <SectionTitle>Agents on open tasks</SectionTitle>
                <span className="text-xs text-muted">{working.length} working</span>
              </div>
              <Card className="overflow-hidden">
                {working.length > AGENT_LIST_MAX && <StatusBar agents={working} />}
                <div className="divide-y divide-line">
                  {mostInteresting(working, s.overlaps)
                    .slice(0, AGENT_LIST_MAX)
                    .map((a) => (
                      <AgentRow key={`${a.taskId}/${a.id}`} yard={yard} agent={a} task={s.tasks.find((t) => t.id === a.taskId)} overlaps={s.overlaps} />
                    ))}
                </div>
                {working.length > AGENT_LIST_MAX && (
                  <p className="border-t border-line px-5 py-2.5 text-xs text-body">
                    Showing the {AGENT_LIST_MAX} agents in the most overlaps, of {working.length}. Open a task for its full leaderboard.
                  </p>
                )}
              </Card>
            </>
          )}
        </section>

        <aside className="space-y-6">
          <SwarmPulse yard={yard} reviews={s.reviews} pulse={s.pulse} />
          <section aria-label="Recent activity">
            <div className="mb-2 flex h-8 items-center">
              <SectionTitle>Activity</SectionTitle>
            </div>
            <Card className="p-1.5">
              <ActivityFeed events={s.recent} status={s} now={now} />
            </Card>
          </section>
          <section aria-label="Base branch">
            <div className="mb-2 flex h-8 items-center">
              <SectionTitle>
                Latest on <span className="font-mono text-[13px] font-normal">{s.yard.defaultBranch}</span>
              </SectionTitle>
            </div>
            <Card className="divide-y divide-line">
              {base.isPending && (
                <div className="p-3">
                  <Loader size="sm" />
                </div>
              )}
              {base.data?.commits.slice(0, 6).map((c) => (
                <div key={c.hash} className="flex items-baseline gap-2 px-3 py-2 text-[13px]">
                  <span className="font-mono text-xs text-muted">{c.hash.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.message.split("\n")[0]}</span>
                </div>
              ))}
              {base.error && <p className="p-3 text-[13px] text-body">Base log unavailable.</p>}
            </Card>
          </section>
        </aside>
      </div>
      <CreateTaskDialog yard={yard} open={newTask} setOpen={setNewTask} />
    </div>
  );
}

function TaskRow({ yard, task, status, now }: { yard: string; task: YardStatus["tasks"][number]; status: YardStatus; now: number }) {
  const agents = status.agents.filter((a) => a.taskId === task.id);
  const overlaps = status.overlaps.filter((o) => o.taskId === task.id).length;
  return (
    <Link to="/y/$yard/t/$task" params={{ yard, task: task.id }} className="flex items-center gap-4 px-5 py-3.5 hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cx("truncate font-medium", task.status !== "open" && "text-body")}>{task.title}</span>
          {overlaps > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-overlap" title={`${overlaps} overlap(s)`}>
              <Warning weight="fill" /> {overlaps}
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <AgentStack agents={agents} max={10} />
          {agents.length > 10 && <span className="text-xs text-muted">{agents.length} agents</span>}
        </div>
      </div>
      <TaskStatusBadge status={task.status} />
      <span className="w-16 text-right text-xs text-body">{ago(task.decidedAt ?? task.createdAt, now)}</span>
      <CaretRight className="text-muted" />
    </Link>
  );
}

const AGENT_LIST_MAX = 12;

/** Agents worth a look first: the ones in the most overlaps, then the newest. */
function mostInteresting(agents: YardStatus["agents"], overlaps: YardStatus["overlaps"]) {
  const n = new Map<string, number>();
  for (const o of overlaps) for (const a of o.agents) n.set(`${o.taskId}/${a}`, (n.get(`${o.taskId}/${a}`) ?? 0) + 1);
  return [...agents].sort((a, b) => (n.get(`${b.taskId}/${b.id}`) ?? 0) - (n.get(`${a.taskId}/${a.id}`) ?? 0) || b.createdAt.localeCompare(a.createdAt));
}

/** How a crowd of agents splits across statuses, as one bar with a legend. */
function StatusBar({ agents }: { agents: YardStatus["agents"] }) {
  const order = ["forking", "ready", "working", "pushed", "reviewed", "failed"];
  const counts = order.map((st) => [st, agents.filter((a) => a.status === st).length] as const).filter(([, n]) => n > 0);
  return (
    <div className="border-b border-line px-5 py-3">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-line">
        {counts.map(([st, n]) => (
          <span key={st} style={{ width: `${(n / agents.length) * 100}%`, background: (STATUS[st] ?? STATUS.ready!).color }} title={`${n} ${st}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-body">
        {counts.map(([st, n]) => (
          <span key={st} className="inline-flex items-center gap-1.5">
            <Dot color={(STATUS[st] ?? STATUS.ready!).color} />
            <span className="tabular-nums text-fg">{n}</span> {(STATUS[st]?.label ?? st).toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Files the most agents collide on, across the yard's open tasks. */
function HotFiles({ status }: { status: YardStatus }) {
  const byPath = new Map<string, { agents: Set<string>; tasks: Set<string> }>();
  for (const o of status.overlaps) {
    let e = byPath.get(o.path);
    if (!e) byPath.set(o.path, (e = { agents: new Set(), tasks: new Set() }));
    for (const a of o.agents) e.agents.add(`${o.taskId}/${a}`);
    e.tasks.add(o.taskId);
  }
  const hot = [...byPath.entries()].sort((a, b) => b[1].agents.size - a[1].agents.size).slice(0, 8);
  const max = hot[0]?.[1].agents.size ?? 1;
  return (
    <>
      <div className="mt-6 mb-2 flex h-8 items-center justify-between">
        <SectionTitle>Hot files</SectionTitle>
        <span className="text-xs text-muted">{byPath.size} files in overlaps</span>
      </div>
      <Card className="divide-y divide-line">
        {hot.map(([path, e]) => (
          <div key={path} className="grid grid-cols-[minmax(0,1fr)_160px_80px] items-center gap-4 px-5 py-2.5 text-[13px]">
            <span className="truncate font-mono text-xs">{path}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-line">
              <span className="block h-full rounded-full bg-overlap" style={{ width: `${Math.max(4, (e.agents.size / max) * 100)}%` }} />
            </span>
            <span className="text-right text-xs text-body tabular-nums">
              {e.agents.size} agents{e.tasks.size > 1 ? ` · ${e.tasks.size} tasks` : ""}
            </span>
          </div>
        ))}
      </Card>
    </>
  );
}

/** The yard's heartbeat from the live stream: pushes, reviews, and the review queue. */
function SwarmPulse({ yard, reviews, pulse }: { yard: string; reviews: YardStatus["reviews"]; pulse: YardStatus["pulse"] }) {
  // Rates and buckets come from the server's event log (right on first load); the
  // live events/second is counted here from the socket.
  const live = usePulse(yard);
  const p = { ...pulse, eventsPerSec: live.eventsPerSec };
  const peak = Math.max(1, ...p.buckets);
  const idle = p.pushesPerMin === 0 && reviews.running === 0 && reviews.queued === 0;
  return (
    <section aria-label="Live pulse">
      <div className="mb-2 flex h-8 items-center justify-between">
        <SectionTitle>Pulse</SectionTitle>
        <span className="text-xs text-muted">Last 2 minutes</span>
      </div>
      <Card className="p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-stat tabular-nums">{p.pushesPerMin}</span>
          <span className="text-xs text-body">pushes / min</span>
          <span className="ml-auto font-mono text-xs text-muted tabular-nums">{p.eventsPerSec} ev/s</span>
        </div>
        <svg viewBox={`0 0 ${p.buckets.length * 6} 32`} className="mt-3 h-8 w-full" preserveAspectRatio="none" aria-hidden>
          {p.buckets.map((n, i) => (
            <rect key={i} x={i * 6} y={32 - (n / peak) * 30} width={4} height={Math.max(1, (n / peak) * 30)} rx={1} className={n ? "fill-ink" : "fill-line"} />
          ))}
        </svg>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
          <span>
            <span className="block font-mono text-fg tabular-nums">{p.reviewsPerMin}</span>
            <span className="text-body">reviews / min</span>
          </span>
          <span>
            <span className="block font-mono text-fg tabular-nums">{reviews.running}</span>
            <span className="text-body">reviewing</span>
          </span>
          <span>
            <span className="block font-mono text-fg tabular-nums">{reviews.queued}</span>
            <span className="text-body">queued</span>
          </span>
        </div>
        {idle && <p className="mt-3 text-xs text-muted">Quiet. This fills in live as agents push.</p>}
      </Card>
    </section>
  );
}

function AgentRow({ yard, agent, task, overlaps }: { yard: string; agent: YardStatus["agents"][number]; task?: YardStatus["tasks"][number]; overlaps: YardStatus["overlaps"] }) {
  const s = STATUS[agent.status] ?? { label: agent.status, color: "var(--color-muted)" };
  const mine = overlaps.filter((o) => o.taskId === agent.taskId && o.agents.includes(agent.id)).length;
  return (
    <Link
      to="/y/$yard/t/$task"
      params={{ yard, task: agent.taskId }}
      search={{ agent: agent.id }}
      className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)] items-center gap-4 px-5 py-3 hover:bg-hover max-sm:grid-cols-[minmax(0,1fr)_100px]"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <AgentBadge agent={agent} size={24} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{agent.name}</span>
          <span className="block truncate font-mono text-[11px] text-muted">{agent.harness}</span>
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-body">
        <Dot color={s.color} pulse={s.pulse} />
        {s.label}
        {mine > 0 && (
          <span className="inline-flex items-center gap-0.5 text-overlap" title={`${mine} overlap(s)`}>
            · <Warning weight="fill" /> {mine}
          </span>
        )}
      </span>
      <span className="truncate text-[13px] text-body max-sm:hidden">{task?.title}</span>
    </Link>
  );
}

function ActivityFeed({ events, status, now }: { events: YardEvent[]; status: YardStatus; now: number }) {
  const byId = new Map(status.agents.map((a) => [`${a.taskId}/${a.id}`, a]));
  const name = (e: YardEvent) => (id: string | null) => (id ? (byId.get(`${e.taskId}/${id}`)?.name ?? id) : "?");
  const shown = events.slice(-12).reverse();
  if (!shown.length) return <p className="p-2.5 text-[13px] text-body">Nothing yet. Events stream in live.</p>;
  return (
    <ol className="space-y-px" aria-live="polite">
      {shown.map((e) => {
        const a = e.agentId && e.taskId ? byId.get(`${e.taskId}/${e.agentId}`) : undefined;
        const warn = e.type === "overlap.detected";
        return (
          <li key={e.seq} className={cx("flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px]", warn && "bg-overlap/10")}>
            {a ? <AgentBadge agent={a} size={18} /> : <span className="inline-block w-[18px] shrink-0 text-center text-xs text-muted">{warn ? "⚠" : "•"}</span>}
            <span className={cx("min-w-0 flex-1 break-words", warn && "font-medium")}>{describeEvent(e, name(e))}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{ago(e.ts, now).replace(" ago", "")}</span>
          </li>
        );
      })}
    </ol>
  );
}

function LiveBadge({ state, connected }: { state: LiveState; connected: YardStatus["connected"] }) {
  const color = state === "live" ? "var(--color-good)" : state === "connecting" ? "var(--color-busy)" : "var(--color-bad)";
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 text-xs font-medium ring-1 ring-line" title={`Live updates: ${state}`}>
      <Dot color={color} pulse={state !== "live"} />
      {state === "live" ? `Live · ${connected.agents} agent${connected.agents === 1 ? "" : "s"} connected` : state === "connecting" ? "Connecting…" : "Offline"}
    </span>
  );
}
