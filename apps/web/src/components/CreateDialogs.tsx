import { ClipboardText, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import { Plus, Trash } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { call, client, yardRoute, type CreatedTask } from "../lib/api";
import { toastError, toasts } from "../lib/toast";
import { Button } from "./ui";

const HARNESSES = ["claude-code", "codex", "cursor", "gemini-cli", "opencode", "aider", "script", "human"];

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
  agents: z.array(z.object({ name: z.string().trim().min(1, "Name the agent").max(40), harness: z.string() })).min(1, "At least one agent"),
});

export function CreateTaskDialog({ yard, open, setOpen }: { yard: string; open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const create = useMutation({
    mutationFn: (v: z.infer<typeof TaskForm>) =>
      call(yardRoute.tasks.$post({ param: { yard }, query: {}, json: { title: v.title, brief: v.brief, agents: v.agents.map((a) => ({ ...a, role: "agent" as const })) } })),
    onSuccess: (r) => {
      setCreated(r as unknown as CreatedTask);
      void qc.invalidateQueries({ queryKey: ["yard", yard] });
      void qc.invalidateQueries({ queryKey: ["yards"] });
    },
    onError: (e) => toastError(e, "Could not create task"),
  });
  const form = useForm({
    defaultValues: {
      title: "",
      brief: "",
      agents: [
        { name: "Ada", harness: "claude-code" },
        { name: "Bash", harness: "codex" },
        { name: "Cyd", harness: "gemini-cli" },
      ],
    },
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
      <Dialog className="p-6" size="xl">
        {!created ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <Dialog.Title className="text-h2">New task</Dialog.Title>
            <Dialog.Description className="text-sm text-body">Every agent gets its own fork of the base repo, a scoped git token and AGENTS.md.</Dialog.Description>
            <form.Field name="title">
              {(f) => (
                <Input
                  label="Title"
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
                <InputArea
                  label="Brief"
                  placeholder="What should the agents do? Constraints, acceptance criteria…"
                  value={f.state.value}
                  onChange={(e) => f.handleChange(e.target.value)}
                  rows={4}
                />
              )}
            </form.Field>
            <form.Field name="agents" mode="array">
              {(list) => (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Agents ({list.state.value.length})</div>
                  {list.state.value.map((_, i) => (
                    <div key={i} className="flex items-end gap-2">
                      <form.Field name={`agents[${i}].name`}>
                        {(f) => (
                          <div className="flex-1">
                            <Input aria-label="Agent name" className="w-full" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`agents[${i}].harness`}>
                        {(f) => (
                          <Select
                            aria-label="Harness"
                            className="w-40"
                            value={f.state.value}
                            onValueChange={(v) => f.handleChange(String(v))}
                            items={Object.fromEntries(HARNESSES.map((h) => [h, h]))}
                          />
                        )}
                      </form.Field>
                      <Button variant="ghost" size="icon" aria-label="Remove agent" icon={<Trash />} onClick={() => list.removeValue(i)} />
                    </div>
                  ))}
                  <Button size="sm" icon={<Plus />} onClick={() => list.pushValue({ name: `Agent ${list.state.value.length + 1}`, harness: "claude-code" })}>
                    Add agent
                  </Button>
                </div>
              )}
            </form.Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={close}>Cancel</Button>
              <form.Subscribe selector={(s) => [s.canSubmit, s.values.agents.length, s.values.title.trim().length > 0] as const}>
                {([canSubmit, n, hasTitle]) => (
                  <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit || !hasTitle || n === 0}>
                    Fan out to {n} agent{n === 1 ? "" : "s"}
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <Dialog.Title className="text-h2">Task created.</Dialog.Title>
            <Dialog.Description className="text-sm text-body">Each agent connects to the MCP server below, signs in, and picks its seat on this task.</Dialog.Description>
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
