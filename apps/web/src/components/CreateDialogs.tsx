import { Button, ClipboardText, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import { Plus, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { call, client, yardRoute, type CreatedTask } from "../lib/api";
import { navigate } from "../lib/router";
import { toastError, toasts } from "../lib/toast";

const HARNESSES = ["claude-code", "codex", "cursor", "gemini-cli", "opencode", "aider", "script", "human"];

export function CreateYardDialog({ open, setOpen, onCreated }: { open: boolean; setOpen: (o: boolean) => void; onCreated: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await call(
        client.yards.$post({
          json: {
            id,
            name: name || undefined,
            importUrl: importUrl || undefined,
            previewUrlTemplate: preview || null,
            jurisdiction: "default",
          },
        }),
      );
      toasts.add({ title: "Yard created", description: id, variant: "success" });
      setOpen(false);
      onCreated();
      navigate({ name: "yard", yard: id });
    } catch (e) {
      toastError(e, "Could not create yard");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="space-y-3 p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold">New yard</Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">A yard is one base repo plus everything happening around it.</Dialog.Description>
        <Input label="Id" placeholder="my-project" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} description="Lowercase letters, digits, single dashes." />
        <Input label="Name" placeholder="My project" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Import from a public git URL (optional)"
          placeholder="https://github.com/owner/repo.git"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          description="Leave empty to start from a README."
        />
        <Input
          label="Preview URL template (optional)"
          placeholder="https://{agent}-{task}-myapp.example.workers.dev"
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          description="Placeholders: {yard} {task} {agent} {fork}"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" className="fy-primary" loading={busy} disabled={id.length < 2} onClick={submit}>
            Create yard
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function CreateTaskDialog({ yard, open, setOpen, onCreated }: { yard: string; open: boolean; setOpen: (o: boolean) => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [agents, setAgents] = useState([
    { name: "Ada", harness: "claude-code" },
    { name: "Bash", harness: "codex" },
    { name: "Cyd", harness: "gemini-cli" },
  ]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await call(yardRoute.tasks.$post({ param: { yard }, query: {}, json: { title, brief, agents: agents.map((a) => ({ ...a, role: "agent" as const })) } }));
      setCreated(r as unknown as CreatedTask);
      onCreated();
    } catch (e) {
      toastError(e, "Could not create task");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setOpen(false);
    if (created) navigate({ name: "task", yard, task: created.task.id });
    setCreated(null);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Dialog className="space-y-3 p-6" size="xl">
        {!created ? (
          <>
            <Dialog.Title className="text-lg font-semibold">New task</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">Every agent gets its own fork of the base repo, a scoped git token and AGENTS.md.</Dialog.Description>
            <Input label="Title" placeholder="Add dark mode" value={title} onChange={(e) => setTitle(e.target.value)} />
            <InputArea label="Brief" placeholder="What should the agents do? Constraints, acceptance criteria…" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} />
            <div className="space-y-2">
              <div className="text-sm font-medium">Agents ({agents.length})</div>
              {agents.map((a, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input aria-label="Agent name" value={a.name} onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </div>
                  <Select
                    aria-label="Harness"
                    className="w-40"
                    value={a.harness}
                    onValueChange={(v) => setAgents(agents.map((x, j) => (j === i ? { ...x, harness: String(v) } : x)))}
                    items={Object.fromEntries(HARNESSES.map((h) => [h, h]))}
                  />
                  <Button variant="ghost" shape="square" aria-label="Remove agent" icon={<Trash />} onClick={() => setAgents(agents.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button size="sm" icon={<Plus />} onClick={() => setAgents([...agents, { name: `Agent ${agents.length + 1}`, harness: "claude-code" }])}>
                Add agent
              </Button>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" className="fy-primary" loading={busy} disabled={!title || agents.length === 0} onClick={submit}>
                Fan out to {agents.length} agent{agents.length === 1 ? "" : "s"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Dialog.Title className="text-lg font-semibold">Task created — hand each agent its key</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              Keys are shown once. An agent connects to <code>{location.origin}/mcp</code> with its key and calls <code>workspace_get</code>.
            </Dialog.Description>
            <div className="space-y-2">
              {created.credentials.map((c) => (
                <div key={c.agentId} className="grid grid-cols-[120px_1fr] items-center gap-2">
                  <span className="truncate text-sm font-medium">{created.agents.find((a) => a.id === c.agentId)?.name}</span>
                  <ClipboardText text={c.apiKey} />
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="primary" className="fy-primary" onClick={close}>
                Open task
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
