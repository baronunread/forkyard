import { Loader } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AskCard } from "../components/AskCard";
import { Markdown } from "../components/Markdown";
import { Button, Card, cx, Dot, SectionTitle } from "../components/ui";
import type { YardStatus } from "../lib/api";
import { ago } from "../lib/format";
import { taskPhase, type Tone } from "../lib/phase";
import { codeQuery, yardParams, yardQuery } from "../lib/queries";
import { useYard } from "./YardLayout";

const DONE_SHOWN = 5;

/**
 * A yard's front page answers, in order: does anything need me, what's moving, what shipped
 * lately, and what is this project (its README).
 */
export function YardOverview() {
  const { yard, start } = useYard();
  const status = useQuery(yardQuery(yard));
  const code = useQuery(codeQuery(yard, ""));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const s = status.data;
  if (!s) return <Loader />;

  const open = s.tasks.filter((t) => t.status === "open");
  const done = s.tasks.filter((t) => t.status === "decided").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const working = s.agents.filter((a) => open.some((t) => t.id === a.taskId) && a.status !== "failed" && a.status !== "retired").length;
  const taskTitle = (id: string | null) => s.tasks.find((t) => t.id === id)?.title ?? null;
  const agentOf = (taskId: string | null, id: string | null) => s.agents.find((a) => a.taskId === taskId && a.id === id) ?? null;
  const tree = code.data?.kind === "tree" ? code.data.tree : null;
  const readme = tree?.readme ?? null;
  // The README's first paragraph is the project's one-line description.
  const about = readme?.text
    ?.split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("![") && !p.startsWith("<") && !p.startsWith("[!"));
  const summary = [
    open.length ? `${open.length} ${open.length === 1 ? "task" : "tasks"} in progress` : "Nothing in progress",
    working ? `${working} ${working === 1 ? "agent" : "agents"} working` : null,
    s.pulse.pushesPerMin ? `${s.pulse.pushesPerMin} pushes a minute` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
      {open.length > 0 && <p className="mb-6 text-body">{summary}</p>}

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
            <Button size="sm" onClick={() => start()}>
              New task
            </Button>
          </Card>
        )}
      </Section>

      {done.length > 0 && (
        <Section
          title="Recently shipped"
          aside={
            <Link to="/$owner/$yard/log" params={yardParams(yard)} className="text-[13px] text-body hover:text-fg">
              See the log
            </Link>
          }
        >
          <Card className="divide-y divide-line overflow-hidden">
            {done.slice(0, DONE_SHOWN).map((t) => (
              <TaskRow key={t.id} yard={yard} task={t} status={s} now={now} />
            ))}
          </Card>
        </Section>
      )}

      {readme?.text && (
        <Section title={readme.name}>
          <Card className="overflow-hidden">
            <Markdown className="px-6 py-5" base={`/${yardParams(yard).owner}/${yardParams(yard).yard}/code/`}>
              {readme.text}
            </Markdown>
          </Card>
        </Section>
      )}
      </div>

      <aside className="space-y-6 text-[14px] lg:pt-0" aria-label="About">
        <div>
          <SectionTitle className="mb-2">About</SectionTitle>
          <div className="text-body">{about ? <Markdown className="[&_p]:m-0">{about.length > 280 ? `${about.slice(0, 277)}…` : about}</Markdown> : "No description yet. Add a README and it shows up here."}</div>
        </div>
        <dl className="space-y-2.5 border-t border-line pt-5 text-[13px]">
          <Fact label="Shipped" value={`${done.length} ${done.length === 1 ? "change" : "changes"}`} to="/$owner/$yard/log" yard={yard} />
          <Fact label="In progress" value={`${open.length} ${open.length === 1 ? "task" : "tasks"}`} />
          {tree?.head && <Fact label="Last change" value={ago(tree.head.at, now)} />}
          <Fact label="Created" value={new Date(s.yard.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} />
        </dl>
      </aside>
    </div>
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
    <Link to="/$owner/$yard/t/$task" params={{ ...yardParams(yard), task: task.id }} className="flex items-center gap-5 px-5 py-4 hover:bg-hover">
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

function Fact({ label, value, to, yard }: { label: string; value: string; to?: "/$owner/$yard/log"; yard?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-body">{label}</dt>
      <dd className="font-medium">
        {to && yard ? (
          <Link to={to} params={yardParams(yard)} className="hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10 first:mt-0" aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        {aside}
      </div>
      {children}
    </section>
  );
}
