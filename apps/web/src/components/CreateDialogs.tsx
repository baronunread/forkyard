import { ClipboardText, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { call, client, yardRoute, type CreatedTask } from "../lib/api";
import { toastError, toasts } from "../lib/toast";
import { Button } from "./ui";

/** First validation message of a TanStack Form field, if any. */
function firstError(errors: unknown[]): string | undefined {
  const e = errors[0];
  if (!e) return undefined;
  return typeof e === "string" ? e : ((e as { message?: string }).message ?? String(e));
}

const YardForm = z.object({
  id: z
    .string()
    .min(2, "At least 2 characters")
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, digits, single dashes"),
  name: z.string().max(80),
  importUrl: z.union([z.literal(""), z.url("Must be a URL")]),
  preview: z.string(),
});

export function CreateYardDialog({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (v: z.infer<typeof YardForm>) =>
      call(
        client.yards.$post({
          json: { id: v.id, name: v.name || undefined, importUrl: v.importUrl || undefined, previewUrlTemplate: v.preview || null, jurisdiction: "default" },
        }),
      ),
    onSuccess: async (y) => {
      toasts.add({ title: "Yard created", description: y.id, variant: "success" });
      await qc.invalidateQueries({ queryKey: ["yards"] });
      setOpen(false);
      form.reset();
      void navigate({ to: "/y/$yard", params: { yard: y.id } });
    },
    onError: (e) => toastError(e, "Could not create yard"),
  });
  const form = useForm({
    defaultValues: { id: "", name: "", importUrl: "", preview: "" },
    validators: { onChange: YardForm },
    onSubmit: ({ value }) => create.mutateAsync(value).catch(() => undefined),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="p-6" size="lg">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <Dialog.Title className="text-h2">New yard</Dialog.Title>
          <Dialog.Description className="text-sm text-body">A yard is one base repo plus everything happening around it.</Dialog.Description>
          <form.Field name="id">
            {(f) => (
              <Input
                label="Id"
                placeholder="my-project"
                value={f.state.value}
                onBlur={f.handleBlur}
                onChange={(e) => f.handleChange(e.target.value.toLowerCase())}
                description="Lowercase letters, digits, single dashes."
                error={f.state.meta.isTouched ? firstError(f.state.meta.errors) : undefined}
              />
            )}
          </form.Field>
          <form.Field name="name">{(f) => <Input label="Name" placeholder="My project" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />}</form.Field>
          <form.Field name="importUrl">
            {(f) => (
              <Input
                label="Import from a public git URL (optional)"
                placeholder="https://github.com/owner/repo.git"
                value={f.state.value}
                onBlur={f.handleBlur}
                onChange={(e) => f.handleChange(e.target.value)}
                description="Leave empty to start from a README."
                error={f.state.meta.isTouched ? firstError(f.state.meta.errors) : undefined}
              />
            )}
          </form.Field>
          <form.Field name="preview">
            {(f) => (
              <Input
                label="Preview URL template (optional)"
                placeholder="https://{agent}-{task}-myapp.example.workers.dev"
                value={f.state.value}
                onChange={(e) => f.handleChange(e.target.value)}
                description="Placeholders: {yard} {task} {agent} {fork}"
              />
            )}
          </form.Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <form.Subscribe selector={(s) => [s.canSubmit, s.values.id.length >= 2] as const}>
              {([canSubmit, hasId]) => (
                <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit || !hasId}>
                  Create yard
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

const TaskForm = z.object({
  title: z.string().trim().min(1, "Give the task a title").max(200),
  brief: z.string().max(20_000),
  agents: z.number().int().min(1, "At least one agent").max(1000, "At most 1000 agents"),
});

/** Agent names for a task of n: a few friendly names, then numbered ones. */
const NAMES = ["Ada", "Bash", "Cyd", "Dex", "Eli", "Fay", "Gus", "Hal"];
function agentSpecs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: n <= NAMES.length ? NAMES[i]! : `Agent ${String(i + 1).padStart(String(n).length, "0")}`,
    harness: "agent",
    role: "agent" as const,
  }));
}

export function CreateTaskDialog({ yard, open, setOpen }: { yard: string; open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const create = useMutation({
    mutationFn: (v: z.infer<typeof TaskForm>) => call(yardRoute.tasks.$post({ param: { yard }, query: {}, json: { title: v.title, brief: v.brief, autopilot: true, agents: agentSpecs(v.agents) } })),
    onSuccess: (r) => {
      setCreated(r as unknown as CreatedTask);
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      void qc.invalidateQueries({ queryKey: ["yards"] });
    },
    onError: (e) => toastError(e, "Could not create task"),
  });
  const form = useForm({
    defaultValues: { title: "", brief: "", agents: 3 },
    validators: { onChange: TaskForm },
    onSubmit: ({ value }) => create.mutateAsync(value).catch(() => undefined),
  });
  const close = () => {
    setOpen(false);
    if (created) void navigate({ to: "/y/$yard/t/$task", params: { yard, task: created.task.id } });
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
            <form.Field name="agents">
              {(f) => (
                <Input
                  label="Agents"
                  type="number"
                  min={1}
                  max={1000}
                  className="w-32"
                  value={String(f.state.value)}
                  onChange={(e) => f.handleChange(Number(e.target.value) || 0)}
                  description="More agents, more attempts to choose from."
                  error={firstError(f.state.meta.errors)}
                />
              )}
            </form.Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={close}>Cancel</Button>
              <form.Subscribe selector={(s) => [s.canSubmit, s.values.agents, s.values.title.trim().length > 0] as const}>
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
            <Dialog.Description className="text-sm text-body">Point your agents at this MCP server. Each signs in and takes a seat on the task.</Dialog.Description>
            <ClipboardText text={`${location.origin}/mcp`} />
            <details className="text-sm">
              <summary className="cursor-pointer text-body">Headless agents: use an API key instead</summary>
              <p className="mt-2 text-xs text-body">
                Shown once. Send as <code>Authorization: Bearer …</code>.
              </p>
              <div className="mt-2 space-y-2">
                {created.credentials.map((c) => (
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
