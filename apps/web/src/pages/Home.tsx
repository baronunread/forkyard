import { Empty, Loader } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AskCard } from "../components/AskCard";
import { CreateYardDialog } from "../components/CreateDialogs";
import { Button, Card, cx, Dot, SectionTitle } from "../components/ui";
import type { YardList } from "../lib/api";
import { useCommands } from "../lib/commands";
import { ago } from "../lib/format";
import { inboxQuery, yardsQuery } from "../lib/queries";

/**
 * Home: what needs you, then your yards. A yard is a project you open, not a conversation in a
 * sidebar, so they're cards you scan, each saying in words what's happening in it.
 */
export function Home() {
  const yards = useQuery(yardsQuery);
  const inbox = useQuery(inboxQuery);
  const [newYard, setNewYard] = useState(false);
  const list = yards.data ?? [];
  const asks = inbox.data?.asks ?? [];
  const agents = list.reduce((n, y) => n + y.summary.activeAgents, 0);
  const open = list.reduce((n, y) => n + y.summary.openTasks, 0);
  useCommands("home", [{ id: "new-yard", group: "Actions", title: "New yard", run: () => setNewYard(true) }], []);

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-6xl px-8 py-10 max-sm:px-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-h1">{asks.length ? `${asks.length} ${asks.length === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}</h1>
            <p className="mt-1.5 text-body">
              {agents ? `${agents} ${agents === 1 ? "agent is" : "agents are"} working on ${open} ${open === 1 ? "task" : "tasks"}.` : "No agents are working right now."}
            </p>
          </div>
          <Button variant="primary" icon={<Plus />} onClick={() => setNewYard(true)}>
            New yard
          </Button>
        </header>

        {asks.length > 0 && (
          <section className="mt-10" aria-label="Needs you">
            <SectionTitle className="mb-3">Needs you</SectionTitle>
            <div className="space-y-3">
              {asks.map((a) => (
                <AskCard key={a.id} ask={a} agent={a.agent} taskTitle={a.taskTitle} yardName={a.yardName} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10" aria-label="Yards">
          <SectionTitle className="mb-3">Yards{list.length ? <span className="ml-1.5 text-muted">{list.length}</span> : null}</SectionTitle>
          {yards.isPending ? (
            <Loader />
          ) : list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {list.map((y) => (
                <YardCard key={y.id} yard={y} />
              ))}
            </div>
          ) : (
            <Card className="px-6 py-10">
              <Empty title="No yards yet" description="A yard is one repo plus the agents working on it. Start one from a name, or from a GitHub repo." />
            </Card>
          )}
        </section>
      </div>
      <CreateYardDialog open={newYard} setOpen={setNewYard} />
    </div>
  );
}

function YardCard({ yard: y }: { yard: YardList[number] }) {
  const s = y.summary;
  const busy = s.activeAgents > 0;
  const line = s.openTasks
    ? `${s.openTasks} ${s.openTasks === 1 ? "task" : "tasks"} in progress · ${s.activeAgents} ${s.activeAgents === 1 ? "agent" : "agents"}`
    : s.decidedTasks
      ? `${s.decidedTasks} ${s.decidedTasks === 1 ? "change" : "changes"} shipped`
      : "No tasks yet";
  return (
    <Link to="/$owner/$yard" params={{ owner: y.owner, yard: y.slug }} className="block">
      <Card interactive className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{y.name}</div>
            <div className="truncate font-mono text-xs text-muted">
              {y.owner}/{y.slug}
            </div>
          </div>
          {s.needsYou > 0 && (
            <span className="shrink-0 rounded-full bg-overlap px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums">{s.needsYou} need you</span>
          )}
        </div>
        <div className={cx("mt-auto flex items-center gap-2 text-[13px]", busy ? "text-fg" : "text-body")}>
          <Dot color={busy ? "var(--color-busy)" : "var(--color-line-strong)"} pulse={busy} />
          <span className="min-w-0 flex-1 truncate">{line}</span>
          {s.lastActivityAt && <span className="shrink-0 text-xs text-muted">{ago(s.lastActivityAt)}</span>}
        </div>
      </Card>
    </Link>
  );
}
