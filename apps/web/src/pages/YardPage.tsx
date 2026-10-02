import { Banner, Button, Empty, Loader } from "@cloudflare/kumo";
import { CaretRight, Plus, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { AgentBadge } from "../components/AgentChip";
import { CreateTaskDialog } from "../components/CreateDialogs";
import { TaskStatusBadge } from "../components/Status";
import { call, yardRoute } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync, useDebounced } from "../lib/data";
import { ago } from "../lib/format";
import { useYardLive } from "../lib/live";
import { navigate } from "../lib/router";

export function YardPage({ yard }: { yard: string }) {
  const status = useAsync(() => call(yardRoute.$get({ param: { yard } })), [yard]);
  const base = useAsync(() => call(yardRoute.base.$get({ param: { yard } })), [yard]);
  const [open, setOpen] = useState(false);
  const refresh = useDebounced(() => {
    status.reload();
    base.reload();
  }, 400);
  useYardLive(yard, refresh);
  useCommands(
    "yard",
    [
      { id: "new-task", group: "Actions", title: "New task", run: () => setOpen(true) },
      ...(status.data?.tasks ?? []).map((t) => ({ id: `task-${t.id}`, group: "Tasks", title: t.title, run: () => navigate({ name: "task", yard, task: t.id }) })),
    ],
    [status.data],
  );

  if (status.error) return <Banner variant="error" title="Could not load yard" description={status.error.message} />;
  const s = status.data;
  if (!s)
    return (
      <div className="p-10">
        <Loader />
      </div>
    );
  const head = base.data?.commits[0];
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="fy-h1 truncate">{s.yard.name}</h1>
          {head && (
            <p className="mt-1 truncate font-mono text-xs text-kumo-subtle">
              {s.yard.defaultBranch} · {head.hash.slice(0, 7)} · {head.message.split("\n")[0]}
            </p>
          )}
        </div>
        <Button variant="primary" className="fy-primary shrink-0" icon={<Plus />} onClick={() => setOpen(true)}>
          New task
        </Button>
      </div>

      <div className="mt-6">
        {s.tasks.length === 0 ? (
          <div className="fy-card py-10">
            <Empty title="No tasks yet" description="A task fans out to several agents, each in its own fork." />
          </div>
        ) : (
          <ul className="fy-card divide-y" style={{ borderColor: "var(--fy-border)" }}>
            {s.tasks.map((t) => {
              const agents = s.agents.filter((a) => a.taskId === t.id);
              const overlaps = s.overlaps.filter((o) => o.taskId === t.id).length;
              return (
                <li key={t.id} style={{ borderColor: "var(--fy-border)" }}>
                  <button className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-kumo-tint" onClick={() => navigate({ name: "task", yard, task: t.id })}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{t.title}</span>
                        {overlaps > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--fy-overlap)" }} title={`${overlaps} overlap(s)`}>
                            <Warning weight="fill" /> {overlaps}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex -space-x-1">
                        {agents.map((a) => (
                          <span key={a.id} className="rounded-full" style={{ boxShadow: "0 0 0 2px var(--fy-surface)" }} title={`${a.name} · ${a.status}`}>
                            <AgentBadge agent={a} size={22} />
                          </span>
                        ))}
                      </div>
                    </div>
                    <TaskStatusBadge status={t.status} />
                    <span className="w-16 text-right text-xs text-kumo-subtle">{ago(t.createdAt)}</span>
                    <CaretRight className="text-kumo-inactive" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CreateTaskDialog yard={yard} open={open} setOpen={setOpen} onCreated={status.reload} />
    </div>
  );
}
