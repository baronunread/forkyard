import { Banner, Button, ClipboardText, Empty, Input, LayerCard, Loader } from "@cloudflare/kumo";
import { Plus, Robot } from "@phosphor-icons/react";
import { useState } from "react";
import { CreateYardDialog } from "../components/CreateDialogs";
import { call, client, getKey, setKey } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync } from "../lib/data";
import { navigate } from "../lib/router";

export function Home() {
  const yards = useAsync(() => call(client.yards.$get()), []);
  const me = useAsync(() => call(client.me.$get()), []);
  const [open, setOpen] = useState(false);
  const [key, setKeyInput] = useState(getKey() ?? "");
  useCommands(
    "home",
    [
      { id: "new-yard", group: "Actions", title: "Create a yard", run: () => setOpen(true) },
      ...(yards.data ?? []).map((y) => ({ id: `yard-${y.id}`, group: "Yards", title: `Open yard ${y.name}`, run: () => navigate({ name: "yard", yard: y.id }) })),
    ],
    [yards.data],
  );
  const origin = location.origin;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <section>
        <h1 className="text-2xl font-semibold">Yards</h1>
        <p className="mt-1 max-w-2xl text-kumo-subtle">
          Agents work in their own forks, concurrently. Forkyard tells them when they overlap, and shows you what each one changed and why — so you can pick
          what ships.
        </p>
      </section>

      {(yards.error?.message.includes("authentication") || me.error) && (
        <Banner
          variant="alert"
          title="Sign in"
          description={
            <span className="flex items-end gap-2">
              <Input aria-label="Admin key" placeholder="Admin key (or use Cloudflare Access)" value={key} onChange={(e) => setKeyInput(e.target.value)} />
              <Button
                onClick={() => {
                  setKey(key || null);
                  location.reload();
                }}
              >
                Save
              </Button>
            </span>
          }
        />
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm text-kumo-subtle">{me.data ? `${me.data.principal.label} · Artifacts ${me.data.artifactsMode}${me.data.devMode ? " · dev mode" : ""}` : ""}</span>
        <Button variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
          New yard
        </Button>
      </div>

      {yards.loading && !yards.data ? (
        <Loader />
      ) : yards.data?.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {yards.data.map((y) => (
            <button key={y.id} className="text-left" onClick={() => navigate({ name: "yard", yard: y.id })}>
              <LayerCard className="h-full p-4 transition hover:ring-kumo-line">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">{y.name}</span>
                  <span className="ml-auto font-mono text-xs text-kumo-subtle">{y.jurisdiction === "eu" ? "EU" : ""}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-kumo-subtle">
                  {y.baseRepo} · {y.defaultBranch}
                </div>
                <div className="mt-2 text-xs text-kumo-subtle">created {new Date(y.createdAt).toLocaleString()}</div>
              </LayerCard>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="No yards yet" description="Create one, or run the demo seed script." commandLine="pnpm seed" />
      )}

      <LayerCard className="space-y-2 p-4">
        <div className="flex items-center gap-2 font-semibold">
          <Robot /> For agents
        </div>
        <p className="text-sm text-kumo-subtle">Any coding agent can join a yard with plain MCP + git. Point it at:</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <ClipboardText text={`${origin}/mcp`} />
          <ClipboardText text={`${origin}/llms.txt`} />
        </div>
      </LayerCard>

      <CreateYardDialog open={open} setOpen={setOpen} onCreated={yards.reload} />
    </div>
  );
}
