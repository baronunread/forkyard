import { ClipboardText, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { yardSlug } from "@forkyard/shared";
import { z } from "zod";
import { call, client, yardRoute, type CreatedTask } from "../lib/api";
import { yardParams } from "../lib/queries";
import { toastError, toasts } from "../lib/toast";
import { Button, cx } from "./ui";

/** First validation message of a TanStack Form field, if any. */
function firstError(errors: unknown[]): string | undefined {
  const e = errors[0];
  if (!e) return undefined;
  return typeof e === "string" ? e : ((e as { message?: string }).message ?? String(e));
}

/** The value, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * A yard needs a name, nothing else: its address follows from the name, and it starts from a
 * README. Under Advanced, a person signed in with GitHub can start it from one of their repos.
 */
export function CreateYardDialog({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const slug = yardSlug(name);
  const settledName = useSettled(name.trim());
  const settled = yardSlug(settledName);
  const check = useQuery({
    queryKey: ["yard-name", settled],
    queryFn: () => call(client["yard-names"].$get({ query: { name: settledName } })),
    enabled: open && settled.length >= 2,
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });
  const owner = check.data?.owner ?? "…";
  const limits = useQuery({ queryKey: ["me", "limits"], queryFn: () => call(client.me.limits.$get()), enabled: open });
  const repos = useQuery({ queryKey: ["me", "github", "repos"], queryFn: () => call(client.me.github.repos.$get()), enabled: open, staleTime: 60_000 });
  const yardsLimit = limits.data?.limits.find((l) => l.key === "yards");
  const atLimit = !!yardsLimit && yardsLimit.limit !== null && yardsLimit.used !== null && yardsLimit.used >= yardsLimit.limit;
  const picked = repos.data?.repos.find((r) => r.fullName === repo) ?? null;

  const reset = () => {
    setName("");
    setRepo(null);
  };
  const create = useMutation({
    mutationFn: () => call(client.yards.$post({ json: { name: name.trim(), importUrl: picked?.cloneUrl, jurisdiction: "default" } })),
    onSuccess: async (y) => {
      toasts.add({ title: "Yard created", description: picked ? `Importing ${picked.fullName}'s open issues into the backlog…` : y.name, variant: "success" });
      await qc.invalidateQueries({ queryKey: ["yards"] });
      void qc.invalidateQueries({ queryKey: ["me", "limits"] });
      setOpen(false);
      reset();
      void navigate({ to: "/$owner/$yard", params: { owner: y.owner, yard: y.slug } });
    },
    onError: (e) => toastError(e, "Could not create yard"),
  });

  const fresh = settledName === name.trim() && !check.isFetching && check.data?.slug === slug;
  const taken = fresh && check.data && !check.data.available ? check.data : null;
  const status =
    slug.length < 2
      ? name.trim()
        ? { tone: "bad", text: "Use at least two letters or numbers." }
        : null
      : !fresh || !check.data
        ? { tone: "muted", text: `${owner}/${slug}` }
        : check.data.available
          ? { tone: "good", text: `Available: ${owner}/${slug}` }
          : { tone: "bad", text: `You already have ${owner}/${slug}.` };
  const ready = fresh && !!check.data?.available && !atLimit && !create.isPending;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Dialog className="p-6" size="base">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <Dialog.Title className="text-h2">New yard</Dialog.Title>
          <Dialog.Description className="text-sm text-body">A yard is one repo plus the agents working on it.</Dialog.Description>
          <div>
            <Input label="Name" placeholder="My project" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <p
              aria-live="polite"
              className={cx("mt-1.5 min-h-5 text-[13px]", status?.tone === "good" ? "text-good" : status?.tone === "bad" ? "text-bad" : "text-muted")}
            >
              {status?.text}
              {taken?.yard && (
                <button type="button" className="ml-2 text-fg underline underline-offset-2" onClick={() => (setOpen(false), reset(), void navigate({ to: "/$owner/$yard", params: yardParams(taken.yard!) }))}>
                  Open it
                </button>
              )}
              {taken?.suggestion && (
                <button type="button" className="ml-2 text-fg underline underline-offset-2" onClick={() => setName(taken.suggestion!)}>
                  Use “{taken.suggestion}”
                </button>
              )}
            </p>
          </div>
          {repos.data?.connected && repos.data.repos.length > 0 && (
            <details className="group rounded-md text-sm" open={!!repo}>
              <summary className="cursor-pointer select-none text-body hover:text-fg">Advanced</summary>
              <div className="mt-3">
                <Select
                  label="Start from a GitHub repo"
                  className="w-full"
                  value={repo}
                  placeholder="No, start from a README"
                  onValueChange={(v) => {
                    const r = repos.data.repos.find((x) => x.fullName === v) ?? null;
                    setRepo(r?.fullName ?? null);
                    if (r && !name.trim()) setName(r.name);
                  }}
                  items={Object.fromEntries(repos.data.repos.map((r) => [r.fullName, r.fullName]))}
                />
                {picked && (
                  <p className="mt-1.5 text-[13px] text-body">
                    Copies {picked.fullName} into Forkyard, with its open issues as the backlog.{" "}
                    <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => setRepo(null)}>
                      Start from a README instead
                    </button>
                  </p>
                )}
              </div>
            </details>
          )}
          {atLimit && (
            <p className="text-[13px] text-bad">
              You've created {yardsLimit!.limit} yards, the most an account can have here.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
              {create.isPending ? (picked ? "Importing…" : "Creating…") : "Create yard"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

const TaskForm = z.object({
  title: z.string().trim().min(1, "Give the task a title").max(200),
  brief: z.string().max(20_000),
  cloud: z.number().int().min(0).max(1000, "At most 1000 agents"),
  local: z.number().int().min(0).max(1000, "At most 1000 agents"),
}).refine((v) => v.cloud + v.local > 0, { message: "At least one agent", path: ["cloud"] });

/**
 * Seats for a task: cloud agents Forkyard runs (Pi on Cloudflare) and local seats your own agents
 * (Claude Code, Codex CLI, …) take over MCP. A few friendly names, then numbered ones.
 */
const NAMES = ["Ada", "Bash", "Cyd", "Dex", "Eli", "Fay", "Gus", "Hal"];
function agentSpecs(cloud: number, local: number) {
  const n = cloud + local;
  const name = (i: number) => (n <= NAMES.length ? NAMES[i]! : `Agent ${String(i + 1).padStart(String(n).length, "0")}`);
  return [
    ...Array.from({ length: cloud }, (_, i) => ({ name: name(i), harness: "pi", role: "agent" as const, runner: "cloud" as const })),
    ...Array.from({ length: local }, (_, i) => ({ name: name(cloud + i), harness: "agent", role: "agent" as const, runner: "mcp" as const })),
  ];
}

export function CreateTaskDialog({ yard, open, setOpen, initialBrief = "" }: { yard: string; open: boolean; setOpen: (o: boolean) => void; initialBrief?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const create = useMutation({
    mutationFn: (v: z.infer<typeof TaskForm>) =>
      call(yardRoute.tasks.$post({ param: { yard }, query: {}, json: { title: v.title, brief: v.brief, autopilot: true, agents: agentSpecs(v.cloud, v.local) } })),
    onSuccess: (r) => {
      const task = r as unknown as CreatedTask;
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      void qc.invalidateQueries({ queryKey: ["yards"] });
      // Only local seats need connecting; a cloud-only task just starts.
      if (task.agents.some((a) => a.harness !== "pi")) setCreated(task);
      else {
        setOpen(false);
        form.reset();
        void navigate({ to: "/$owner/$yard/t/$task", params: { ...yardParams(yard), task: task.task.id } });
      }
    },
    onError: (e) => toastError(e, "Could not create task"),
  });
  const form = useForm({
    defaultValues: { title: "", brief: initialBrief, cloud: 3, local: 0 },
    validators: { onChange: TaskForm },
    onSubmit: ({ value }) => create.mutateAsync(value).catch(() => undefined),
  });
  const close = () => {
    setOpen(false);
    if (created) void navigate({ to: "/$owner/$yard/t/$task", params: { ...yardParams(yard), task: created.task.id } });
    setCreated(null);
    form.reset();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Dialog className="p-6" size="lg">
        {!created ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <Dialog.Title className="text-h2">New task</Dialog.Title>
            <Dialog.Description className="text-sm text-body">Agents each work in their own fork. The best one is merged automatically; you're asked only if they get stuck.</Dialog.Description>
            <form.Field name="title">
              {(f) => (
                <Input
                  label="What should change?"
                  placeholder="Add dark mode"
                  value={f.state.value}
                  onBlur={f.handleBlur}
                  onChange={(e) => f.handleChange(e.target.value)}
                  error={f.state.meta.isTouched ? firstError(f.state.meta.errors) : undefined}
                />
              )}
            </form.Field>
            <form.Field name="brief">
              {(f) => (
                <InputArea label="Details (optional)" placeholder="Constraints, acceptance criteria…" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} rows={3} />
              )}
            </form.Field>
            <div className="grid grid-cols-2 gap-3">
              <form.Field name="cloud">
                {(f) => (
                  <Input
                    label="Cloud agents"
                    type="number"
                    min={0}
                    max={1000}
                    value={String(f.state.value)}
                    onChange={(e) => f.handleChange(Number(e.target.value) || 0)}
                    description="Pi on Cloudflare, on your ChatGPT plan if connected."
                    error={firstError(f.state.meta.errors)}
                  />
                )}
              </form.Field>
              <form.Field name="local">
                {(f) => (
                  <Input
                    label="Your agents"
                    type="number"
                    min={0}
                    max={1000}
                    value={String(f.state.value)}
                    onChange={(e) => f.handleChange(Number(e.target.value) || 0)}
                    description="Seats for Claude Code, Codex and others, over MCP."
                  />
                )}
              </form.Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={close}>Cancel</Button>
              <form.Subscribe selector={(s) => [s.canSubmit, s.values.cloud + s.values.local, s.values.title.trim().length > 0] as const}>
                {([canSubmit, n, hasTitle]) => (
                  <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit || !hasTitle || n < 1}>
                    Start {n} agent{n === 1 ? "" : "s"}
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <Dialog.Title className="text-h2">Task started.</Dialog.Title>
            <Dialog.Description className="text-sm text-body">
              {created.agents.some((a) => a.harness === "pi") ? "Cloud agents are already working. " : ""}Point your own agents at this MCP server: each signs in and takes a seat.
            </Dialog.Description>
            <ClipboardText text={`${location.origin}/mcp`} />
            <details className="text-sm">
              <summary className="cursor-pointer text-body">Headless agents: use an API key instead</summary>
              <p className="mt-2 text-xs text-body">
                Shown once. Send as <code>Authorization: Bearer …</code>.
              </p>
              <div className="mt-2 space-y-2">
                {created.credentials.filter((c) => created.agents.find((a) => a.id === c.agentId)?.harness !== "pi").map((c) => (
                  <div key={c.agentId} className="grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="truncate text-sm">{created.agents.find((a) => a.id === c.agentId)?.name}</span>
                    <ClipboardText text={c.apiKey} />
                  </div>
                ))}
              </div>
            </details>
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={close}>
                Open task
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

/** Deleting a yard is for good, so it asks for the yard's name first (as GitHub does for repos). */
export function DeleteYardDialog({ yard, name, open, setOpen }: { yard: string; name: string; open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const del = useMutation({
    mutationFn: () => call(client.yards[":yard"].$delete({ param: { yard } })),
    onSuccess: async () => {
      toasts.add({ title: "Yard deleted", description: name, variant: "success" });
      setOpen(false);
      qc.removeQueries({ queryKey: ["yard", yard] });
      await qc.invalidateQueries({ queryKey: ["yards"] });
      void qc.invalidateQueries({ queryKey: ["me", "limits"] });
      void navigate({ to: "/" });
    },
    onError: (e) => toastError(e, "Could not delete yard"),
  });
  const ok = typed.trim() === name;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTyped("");
      }}
    >
      <Dialog className="p-6" size="base">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) del.mutate();
          }}
        >
          <Dialog.Title className="text-h2">Delete “{name}”?</Dialog.Title>
          <Dialog.Description className="text-sm text-body">
            This deletes the yard's repo, every agent's fork, its tasks, reviews and backlog. It can't be undone.
          </Dialog.Description>
          <Input label={`Type “${name}” to confirm`} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={del.isPending} disabled={!ok}>
              Delete yard
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
