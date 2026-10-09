import { Dialog, Input, Loader } from "@cloudflare/kumo";
import { CaretRight, ChatCircle, GithubLogo, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { call, yardRoute } from "../lib/api";
import { ago } from "../lib/format";
import { toastError, toasts } from "../lib/toast";
import { Markdown } from "./Markdown";
import { Button, Card, cx, SectionTitle } from "./ui";

/**
 * The yard's backlog (issue #15): tasks that haven't started. GitHub issues come in here once;
 * "Start" turns an item into a task with its body and discussion as the brief.
 */
export function Backlog({ yard }: { yard: string }) {
  const items = useQuery({ queryKey: ["yard", yard, "backlog"], queryFn: () => call(yardRoute.backlog.$get({ param: { yard } })) });
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [all, setAll] = useState(false);
  const now = Date.now();
  const waiting = (items.data ?? []).filter((i) => i.status === "open");
  const shown = all ? waiting : waiting.slice(0, 8);

  return (
    <section className="mt-10" aria-label="Backlog">
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionTitle>
          Backlog{waiting.length ? <span className="ml-1.5 text-muted">{waiting.length}</span> : null}
        </SectionTitle>
        <div className="flex items-center gap-3">
          {waiting.length > 8 && (
            <button className="text-[13px] text-body hover:text-fg" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${waiting.length}`}
            </button>
          )}
          <Button size="sm" icon={<GithubLogo />} onClick={() => setImporting(true)}>
            Import issues
          </Button>
        </div>
      </div>
      {waiting.length ? (
        <Card className="divide-y divide-line overflow-hidden">
          {shown.map((i) => (
            <button key={i.id} onClick={() => setOpen(i.id)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-hover">
              <span className="w-8 shrink-0 text-xs tabular-nums text-muted">#{i.id}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{i.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-body">
                  <span>{i.author}</span>
                  {i.labels.slice(0, 3).map((l) => (
                    <span key={l} className="rounded-full px-2 text-xs ring-1 ring-line">
                      {l}
                    </span>
                  ))}
                  {i.comments > 0 && (
                    <span className="inline-flex items-center gap-1 text-muted">
                      <ChatCircle /> {i.comments}
                    </span>
                  )}
                </div>
              </div>
              <span className="w-16 shrink-0 text-right text-xs text-muted">{ago(i.createdAt, now)}</span>
              <CaretRight className="shrink-0 text-muted" />
            </button>
          ))}
        </Card>
      ) : (
        <Card className="px-5 py-4 text-[14px] text-body">{items.isPending ? "Loading…" : "Nothing waiting. Import a repo's GitHub issues to fill it."}</Card>
      )}
      <ItemDialog yard={yard} id={open} close={() => setOpen(null)} />
      <ImportDialog yard={yard} open={importing} setOpen={setImporting} />
    </section>
  );
}

function ItemDialog({ yard, id, close }: { yard: string; id: string | null; close: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [agents, setAgents] = useState(3);
  const item = useQuery({
    queryKey: ["yard", yard, "backlog", id],
    queryFn: () => call(yardRoute.backlog[":item"].$get({ param: { yard, item: id! } })),
    enabled: !!id,
  });
  const start = useMutation({
    mutationFn: () =>
      call(
        yardRoute.backlog[":item"].start.$post({
          param: { yard, item: id! },
          json: { autopilot: true, agents: Array.from({ length: agents }, (_, i) => ({ name: ["Ada", "Bash", "Cyd", "Dex", "Eli"][i] ?? `Agent ${i + 1}`, harness: "pi", role: "agent" as const, runner: "cloud" as const })) },
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      close();
      void navigate({ to: "/y/$yard/t/$task", params: { yard, task: r.task.id } });
    },
    onError: (e) => toastError(e, "Could not start"),
  });
  const d = item.data;

  return (
    <Dialog.Root open={!!id} onOpenChange={(o) => !o && close()}>
      <Dialog className="max-h-[85vh] overflow-y-auto p-6" size="xl">
        {!d ? (
          <Loader />
        ) : (
          <div className="space-y-5">
            <div>
              <Dialog.Title className="text-h2">
                <span className="mr-2 text-muted">#{d.id}</span>
                {d.title}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-body">
                {d.author} · {new Date(d.createdAt).toLocaleDateString()}
                {d.sourceRef && <> · imported from GitHub {d.sourceRef}</>}
              </Dialog.Description>
            </div>
            <Markdown>{d.body || "_No description._"}</Markdown>
            {d.thread.length > 0 && (
              <div className="space-y-3 border-t border-line pt-4">
                {d.thread.map((c, i) => (
                  <Card key={i} className="p-4">
                    <div className="mb-2 text-[13px] text-body">
                      <span className="font-medium text-fg">{c.author}</span> · {new Date(c.createdAt).toLocaleDateString()}
                    </div>
                    <Markdown>{c.body}</Markdown>
                  </Card>
                ))}
              </div>
            )}
            <div className={cx("flex flex-wrap items-end justify-end gap-3 border-t border-line pt-4")}>
              {d.status === "open" ? (
                <>
                  <Input
                    label="Cloud agents"
                    type="number"
                    min={1}
                    max={5}
                    className="w-32"
                    value={String(agents)}
                    onChange={(e) => setAgents(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                  />
                  <Button variant="primary" icon={<Plus />} loading={start.isPending} onClick={() => start.mutate()}>
                    Start with {agents} agent{agents === 1 ? "" : "s"}
                  </Button>
                </>
              ) : (
                d.taskId && (
                  <Button onClick={() => (close(), void navigate({ to: "/y/$yard/t/$task", params: { yard, task: d.taskId! } }))}>
                    {d.status === "done" ? "Done: open the task" : "Open the task"}
                  </Button>
                )
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

function ImportDialog({ yard, open, setOpen }: { yard: string; open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [repo, setRepo] = useState("");
  const run = useMutation({
    mutationFn: () => call(yardRoute.backlog.import.github.$post({ param: { yard }, json: { repo: repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") } })),
    onSuccess: (r) => {
      toasts.add({ title: `Imported ${r.imported} issue${r.imported === 1 ? "" : "s"}`, description: r.skipped ? `${r.skipped} already here` : undefined, variant: "success" });
      void qc.invalidateQueries({ queryKey: ["yard", yard, "backlog"] });
      setOpen(false);
    },
    onError: (e) => toastError(e, "Import failed"),
  });
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="p-6" size="base">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <Dialog.Title className="text-h2">Import GitHub issues</Dialog.Title>
          <Dialog.Description className="text-sm text-body">
            Open issues and their comments become backlog items. A one-time copy: nothing links back to GitHub. Public repos for now.
          </Dialog.Description>
          <Input label="Repository" placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!/^[\w.-]+\/[\w.-]+/.test(repo.replace(/^https:\/\/github\.com\//, ""))}>
              Import
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
