import { Button, ClipboardText, Empty, Loader } from "@cloudflare/kumo";
import { CaretRight, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { CreateYardDialog } from "../components/CreateDialogs";
import { call, client } from "../lib/api";
import { useCommands } from "../lib/commands";
import { useAsync } from "../lib/data";
import { ago } from "../lib/format";
import { navigate } from "../lib/router";

export function Home() {
  const yards = useAsync(() => call(client.yards.$get()), []);
  const [open, setOpen] = useState(false);
  useCommands(
    "home",
    [
      { id: "new-yard", group: "Actions", title: "New yard", run: () => setOpen(true) },
      ...(yards.data ?? []).map((y) => ({ id: `yard-${y.id}`, group: "Yards", title: y.name, run: () => navigate({ name: "yard", yard: y.id }) })),
    ],
    [yards.data],
  );
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="fy-h1">Yards</h1>
        <Button variant="primary" className="fy-primary" icon={<Plus />} onClick={() => setOpen(true)}>
          New yard
        </Button>
      </div>

      <div className="mt-6">
        {yards.loading && !yards.data ? (
          <Loader />
        ) : yards.data?.length ? (
          <ul className="fy-card divide-y" style={{ borderColor: "var(--fy-border)" }}>
            {yards.data.map((y) => (
              <li key={y.id} style={{ borderColor: "var(--fy-border)" }}>
                <button className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-kumo-tint" onClick={() => navigate({ name: "yard", yard: y.id })}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{y.name}</div>
                    <div className="truncate font-mono text-xs text-kumo-subtle">
                      {y.baseRepo} · {y.defaultBranch}
                    </div>
                  </div>
                  <span className="text-xs text-kumo-subtle">{ago(y.createdAt)}</span>
                  <CaretRight className="text-kumo-inactive" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="fy-card py-10">
            <Empty title="No yards yet" description="A yard is a repo plus the agents working on it." />
          </div>
        )}
      </div>

      <section className="mt-12">
        <div className="fy-eyebrow">Connect an agent</div>
        <p className="mt-2 text-kumo-subtle">Add this MCP server to Claude Code, Codex, Cursor or any MCP client. It will ask you to sign in and pick what the agent works on.</p>
        <div className="mt-3 max-w-md">
          <ClipboardText text={`${location.origin}/mcp`} />
        </div>
      </section>

      <CreateYardDialog open={open} setOpen={setOpen} onCreated={yards.reload} />
    </div>
  );
}
