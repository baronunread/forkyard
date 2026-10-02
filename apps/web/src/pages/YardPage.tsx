import { Banner, Button, Empty, LayerCard, Loader } from "@cloudflare/kumo";
import type { YardEvent } from "@forkyard/shared";
import { GitCommit, Plus, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { AgentChip } from "../components/AgentChip";
import { CreateTaskDialog } from "../components/CreateDialogs";
import { LiveDot, TaskStatusBadge } from "../components/Status";
import { Timeline } from "../components/Timeline";
import { call, yardRoute } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync, useDebounced } from "../lib/data";
import { useYardLive } from "../lib/live";
import { navigate } from "../lib/router";

export function YardPage({ yard }: { yard: string }) {
  const status = useAsync(() => call(yardRoute.$get({ param: { yard } })), [yard]);
  const base = useAsync(() => call(yardRoute.base.$get({ param: { yard } })), [yard]);
  const [events, setEvents] = useState<YardEvent[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = useDebounced(() => {
    status.reload();
    base.reload();
  }, 300);
  useEffect(() => {
    call(yardRoute.events.$get({ param: { yard }, query: { since: "0", limit: "1000" } })).then((r) => setEvents(r.events));
  }, [yard]);
  const live = useYardLive(yard, (e) => {
    setEvents((p) => [...p.filter((x) => x.seq !== e.seq), e]);
    refresh();
  });
  useCommands(
    "yard",
    [
      { id: "new-task", group: "Actions", title: "Create a task in this yard", run: () => setOpen(true) },
      ...(status.data?.tasks ?? []).map((t) => ({ id: `task-${t.id}`, group: "Tasks", title: `Open task: ${t.title}`, run: () => navigate({ name: "task", yard, task: t.id }) })),
    ],
    [status.data],
  );

  if (status.error) return <Banner variant="error" title="Could not load yard" description={status.error.message} />;
  const s = status.data;
  if (!s)
    return (
      <div className="p-6">
        <Loader />
      </div>
    );
  return (
    <div className="grid h-full min-h-0 gap-4 p-4" style={{ gridTemplateColumns: "minmax(0,1fr) 360px" }}>
      <div className="fy-scroll min-h-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{s.yard.name}</h1>
          <span className="font-mono text-xs text-kumo-subtle">
            {s.yard.baseRepo}@{s.yard.defaultBranch}
          </span>
          <LiveDot state={live} />
          <span className="text-xs text-kumo-subtle">
            {s.connected.agents} agent socket(s) · {s.connected.ui} viewer(s)
          </span>
          <Button className="ml-auto" variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
            New task
          </Button>
        </div>

        {s.tasks.length === 0 ? (
          <Empty title="No tasks yet" description="A task fans out to several agents, each in its own fork." />
        ) : (
          <div className="space-y-2">
            {s.tasks.map((t) => {
              const agents = s.agents.filter((a) => a.taskId === t.id);
              const overlaps = s.overlaps.filter((o) => o.taskId === t.id).length;
              return (
                <button key={t.id} className="block w-full text-left" onClick={() => navigate({ name: "task", yard, task: t.id })}>
                  <LayerCard className="p-4 transition hover:ring-kumo-line">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{t.title}</span>
                      <TaskStatusBadge status={t.status} />
                      {overlaps > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: "var(--fy-overlap)" }}>
                          <Warning weight="fill" /> {overlaps}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-kumo-subtle">{new Date(t.createdAt).toLocaleString()}</span>
                    </div>
                    {t.brief && <p className="mt-1 line-clamp-1 text-sm text-kumo-subtle">{t.brief}</p>}
                    <div className="mt-2 flex flex-wrap gap-3">
                      {agents.map((a) => (
                        <span key={a.id} className="inline-flex items-center gap-1 text-xs">
                          <AgentChip agent={a} size={18} /> <span className="text-kumo-subtle">{a.status}</span>
                        </span>
                      ))}
                    </div>
                  </LayerCard>
                </button>
              );
            })}
          </div>
        )}

        {base.data && (
          <LayerCard className="p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Base branch history</div>
            <ol className="space-y-1 text-sm">
              {base.data.commits.map((c) => (
                <li key={c.hash} className="flex items-center gap-2">
                  <GitCommit className="text-kumo-subtle" />
                  <span className="font-mono text-xs text-kumo-subtle">{c.hash.slice(0, 7)}</span>
                  <span className="truncate">{c.message.split("\n")[0]}</span>
                  <span className="ml-auto text-xs text-kumo-subtle">{c.author.name}</span>
                </li>
              ))}
            </ol>
          </LayerCard>
        )}
      </div>
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
        <div className="border-b border-kumo-hairline px-3 py-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Yard timeline</div>
        <div className="min-h-0 flex-1">
          <Timeline events={events} agents={s.agents} />
        </div>
      </aside>
      <CreateTaskDialog yard={yard} open={open} setOpen={setOpen} onCreated={status.reload} />
    </div>
  );
}
