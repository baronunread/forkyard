import { Checkbox, Dialog, Empty, Input, InputArea, Loader } from "@cloudflare/kumo";
import { ArrowLeft, CaretRight, ChatCircle, GithubLogo, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { call, yardRoute } from "../lib/api";
import { ago } from "../lib/format";
import { toastError, toasts } from "../lib/toast";
import { Markdown } from "./Markdown";
import { Button, Card, cx, SectionTitle } from "./ui";
import { chatgptQuery, yardParams } from "../lib/queries";

/**
 * The yard's backlog (issue #15): tasks that haven't started. GitHub issues come in here once;
 * "Start" turns an item into a task with its body and discussion as the brief.
 */
export function Backlog({ yard, full = false }: { yard: string; full?: boolean }) {
  const items = useQuery({
    queryKey: ["yard", yard, "backlog"],
    queryFn: () => call(yardRoute.backlog.$get({ param: { yard } })),
    // The live socket refreshes it when the import ends; polling is the fallback.
    refetchInterval: (q) => (q.state.data?.importing ? 5_000 : false),
  });
  const [importing, setImporting] = useState(false);
  const [filing, setFiling] = useState(false);
  const [all, setAll] = useState(false);
  const now = Date.now();
  const pulling = items.data?.importing ?? null;
  // Issues that arrive while you watch the import fade in.
  const wasPulling = useRef(false);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (wasPulling.current && !pulling) setArrived(true);
    wasPulling.current = !!pulling;
  }, [pulling]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"open" | "started" | "done" | "all">("open");
  const [label, setLabel] = useState<string | null>(null);
  const everything = items.data?.items ?? [];
  const waiting = everything.filter((i) => i.status === "open");
  // ponytail: filtered in the browser; fine for a few thousand items, move to SQL (FTS5) past that.
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = everything.filter(
    (i) =>
      (status === "all" || i.status === status) &&
      (!label || i.labels.includes(label)) &&
      words.every((w) => `#${i.id} ${i.title} ${i.body} ${i.author} ${i.labels.join(" ")}`.toLowerCase().includes(w)),
  );
  const counts = { open: waiting.length, started: everything.filter((i) => i.status === "started").length, done: everything.filter((i) => i.status === "done").length, all: everything.length };
  const shown = full ? matching : all ? waiting : waiting.slice(0, 8);

  return (
    <section className={full ? "max-w-4xl" : "mt-10"} aria-label="Backlog">
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionTitle>
          Backlog{waiting.length ? <span className="ml-1.5 text-muted">{waiting.length}</span> : null}
          {pulling && waiting.length > 0 && <Loader size="sm" className="ml-2 inline-block align-middle" />}
        </SectionTitle>
        <div className="flex items-center gap-3">
          {waiting.length > 8 && !full && (
            <button className="text-[13px] text-body hover:text-fg" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${waiting.length}`}
            </button>
          )}
          <Button size="sm" icon={<GithubLogo />} onClick={() => setImporting(true)}>
            Import issues
          </Button>
          <Button size="sm" icon={<Plus />} onClick={() => setFiling(true)}>
            New item
          </Button>
        </div>
      </div>
      {full && everything.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, text, author, label or #number"
            aria-label="Search the backlog"
            className="h-9 min-w-60 flex-1 rounded-md bg-surface px-3 text-[14px] text-fg ring-1 ring-line outline-none placeholder:text-muted focus:ring-link"
          />
          <div className="flex rounded-md ring-1 ring-line" role="group" aria-label="Status">
            {(["open", "started", "done", "all"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setStatus(v)}
                aria-pressed={status === v}
                className={cx("h-9 px-3 text-[13px] capitalize", status === v ? "bg-selected font-medium text-fg" : "text-body hover:text-fg")}
              >
                {v} <span className="text-muted tabular-nums">{counts[v]}</span>
              </button>
            ))}
          </div>
          {label && (
            <button onClick={() => setLabel(null)} className="h-7 rounded-full px-2.5 text-xs ring-1 ring-line hover:bg-hover">
              {label} ✕
            </button>
          )}
        </div>
      )}
      {full && everything.length > 0 && !shown.length ? (
        <Card className="px-5 py-4 text-[14px] text-body">Nothing matches.</Card>
      ) : shown.length ? (
        <Card className="divide-y divide-line overflow-hidden">
          {shown.map((i, n) => (
            <Link
              key={i.id}
              to="/$owner/$yard/backlog/$item"
              params={{ ...yardParams(yard), item: i.id }}
              className={cx("flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-hover", arrived && "animate-fade-in")}
              style={arrived ? { animationDelay: `${n * 40}ms` } : undefined}
            >
              <span className="w-8 shrink-0 text-xs tabular-nums text-muted">#{i.id}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{i.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-body">
                  <span>{i.author}</span>
                  {i.labels.slice(0, 3).map((l) => (
                    <button
                      key={l}
                      onClick={(e) => {
                        e.preventDefault();
                        setLabel(l);
                      }}
                      className={cx("rounded-full px-2 text-xs ring-1 ring-line hover:bg-hover", label === l && "bg-selected")}
                    >
                      {l}
                    </button>
                  ))}
                  {i.status !== "open" && <span className="text-xs text-muted">{i.status}</span>}
                  {i.comments > 0 && (
                    <span className="inline-flex items-center gap-1 text-muted">
                      <ChatCircle /> {i.comments}
                    </span>
                  )}
                </div>
              </div>
              <span className="w-16 shrink-0 text-right text-xs text-muted">{ago(i.createdAt, now)}</span>
              <CaretRight className="shrink-0 text-muted" />
            </Link>
          ))}
        </Card>
      ) : (
        <Card className="flex items-center gap-3 px-5 py-4 text-[14px] text-body">
          {pulling ? (
            <>
              <Loader size="sm" /> Importing issues from {pulling}…
            </>
          ) : items.isPending ? (
            "Loading…"
          ) : (
            "Nothing waiting. Import a repo's GitHub issues to fill it."
          )}
        </Card>
      )}
      <ImportDialog yard={yard} open={importing} setOpen={setImporting} />
      <NewItemDialog yard={yard} open={filing} setOpen={setFiling} />
    </section>
  );
}

/** One backlog item as a page with its own link: the description and discussion, and a box to start it. */
export function BacklogItemPage({ yard, id }: { yard: string; id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [agents, setAgents] = useState(3);
  const [review, setReview] = useState(false);
  const cloudReady = useQuery(chatgptQuery).data?.cloudReady ?? false;
  const params = yardParams(yard);
  const item = useQuery({
    queryKey: ["yard", yard, "backlog", id],
    queryFn: () => call(yardRoute.backlog[":item"].$get({ param: { yard, item: id } })),
  });
  const start = useMutation({
    mutationFn: () =>
      call(
        yardRoute.backlog[":item"].start.$post({
          param: { yard, item: id },
          json: {
            autopilot: true,
            review,
            // Without ChatGPT, the task starts with one seat for your own agent (handed over from the task page).
            agents: cloudReady
              ? Array.from({ length: agents }, (_, i) => ({ name: ["Ada", "Bash", "Cyd", "Dex", "Eli"][i] ?? `Agent ${i + 1}`, harness: "pi", role: "agent" as const, runner: "cloud" as const }))
              : [{ name: "Claude", harness: "agent", role: "agent" as const, runner: "mcp" as const }],
          },
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      void navigate({ to: "/$owner/$yard/t/$task", params: { ...params, task: r.task.id } });
    },
    onError: (e) => toastError(e, "Could not start"),
  });
  if (item.error) return <Empty title="Not in the backlog" description={item.error.message} />;
  const d = item.data;
  if (!d) return <Loader />;
  const base = `/${params.owner}/${params.yard}/code/`;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px]">
      <article className="min-w-0">
        <Link to="/$owner/$yard/backlog" params={params} className="inline-flex items-center gap-1 text-[13px] text-body hover:text-fg">
          <ArrowLeft /> Backlog
        </Link>
        <h2 className="mt-3 text-h2">
          {d.title} <span className="font-normal text-muted">#{d.id}</span>
        </h2>
        <p className="mt-1 text-[13px] text-body">
          {d.author} · {new Date(d.createdAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}
          {d.sourceRef && <> · imported from GitHub {d.sourceRef}</>}
        </p>
        <Card className="mt-6 px-6 py-5">
          <Markdown base={base}>{d.body || "_No description._"}</Markdown>
        </Card>
        {d.thread.length > 0 && (
          <section className="mt-8 space-y-3" aria-label="Discussion">
            <SectionTitle>Discussion</SectionTitle>
            {d.thread.map((c, i) => (
              <Card key={i} className="px-6 py-4">
                <div className="mb-2 text-[13px] text-body">
                  <span className="font-medium text-fg">{c.author}</span> · {new Date(c.createdAt).toLocaleDateString("en")}
                </div>
                <Markdown base={base}>{c.body}</Markdown>
              </Card>
            ))}
          </section>
        )}
      </article>
      <aside className="lg:pt-9">
        <Card className="space-y-4 p-5">
          {d.status === "open" ? (
            <>
              <div>
                <SectionTitle>Start it</SectionTitle>
                <p className="mt-1 text-[13px] text-body">Cloud agents work on it in parallel, each in its own fork. Autopilot ships the best result.</p>
              </div>
              {cloudReady && <Input label="Cloud agents" type="number" min={1} max={5} value={String(agents)} onChange={(e) => setAgents(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />}
              {agents === 1 || !cloudReady ? (
                <Checkbox label="Have it reviewed" checked={review} onCheckedChange={(c) => setReview(!!c)} />
              ) : (
                <p className="text-[13px] text-body">A reviewer checks every solution.</p>
              )}
              {!cloudReady && (
                <p className="text-[13px] text-body">
                  Your own agent takes it from the task page. For cloud agents, connect ChatGPT in{" "}
                  <Link to="/settings" className="underline">
                    Settings
                  </Link>
                  .
                </p>
              )}
              <Button variant="primary" className="w-full" icon={<Plus />} loading={start.isPending} onClick={() => start.mutate()}>
                {cloudReady ? `Start with ${agents} agent${agents === 1 ? "" : "s"}` : "Start for your agent"}
              </Button>
            </>
          ) : (
            <>
              <SectionTitle>{d.status === "done" ? "Shipped" : "In progress"}</SectionTitle>
              {d.taskId && (
                <Link to="/$owner/$yard/t/$task" params={{ ...params, task: d.taskId }} className="block text-[14px] text-link hover:underline">
                  Open the task
                </Link>
              )}
            </>
          )}
        </Card>
      </aside>
    </div>
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

function NewItemDialog({ yard, open, setOpen }: { yard: string; open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const run = useMutation({
    mutationFn: () => call(yardRoute.backlog.$post({ param: { yard }, json: { title, body } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["yard", yard, "backlog"] });
      setTitle("");
      setBody("");
      setOpen(false);
    },
    onError: (e) => toastError(e, "Could not add it"),
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
          <Dialog.Title className="text-h2">New backlog item</Dialog.Title>
          <Dialog.Description className="text-sm text-body">Something to do later. Start it when you want agents on it.</Dialog.Description>
          <Input label="What should change" placeholder="Reject duplicate todo titles" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <InputArea label="Details (optional)" placeholder="Why, constraints, what done looks like…" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!title.trim()}>
              Add
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
