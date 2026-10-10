import { ClipboardText, Dialog, DropdownMenu, Empty, Loader } from "@cloudflare/kumo";
import { DotsThree, Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import { CreateTaskDialog, DeleteYardDialog } from "../components/CreateDialogs";
import { Button, cx, Dot } from "../components/ui";
import { useCommands } from "../lib/commands";
import { useYardSync } from "../lib/live";
import { yardParams, yardQuery, yardsQuery } from "../lib/queries";

/** "Start a task about this" from anywhere inside a yard: the Code tab passes the path. */
export type StartTask = (brief?: string) => void;

const YardContext = createContext<{ yard: string; start: StartTask } | null>(null);

/** The yard the current tab belongs to (its id) and a way to start a task in it. */
export function useYard() {
  const ctx = useContext(YardContext);
  if (!ctx) throw new Error("useYard outside a yard");
  return ctx;
}

const TABS = [
  { to: "/$owner/$yard", label: "Overview", exact: true },
  { to: "/$owner/$yard/code/$", label: "Code", exact: false },
  { to: "/$owner/$yard/backlog", label: "Backlog", exact: false },
  { to: "/$owner/$yard/log", label: "Log", exact: false },
] as const;

/**
 * A yard is a project: its name and owner, what you can do with it, and four views of it.
 * The live socket lives here, so every tab stays current.
 */
export function YardLayout({ yard }: { yard: string }) {
  const status = useQuery(yardQuery(yard));
  const listed = useQuery(yardsQuery).data?.find((y) => y.id === yard);
  const live = useYardSync(yard);
  const navigate = useNavigate();
  const [newTask, setNewTask] = useState<{ brief: string } | null>(null);
  const [connect, setConnect] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const params = yardParams(yard);
  const go = (to: (typeof TABS)[number]["to"]) => void navigate({ to, params: { ...params, _splat: "" } });
  const start: StartTask = (brief = "") => setNewTask({ brief });
  useHotkeys([{ hotkey: "N", callback: () => start() }]);
  useCommands(
    "yard",
    [
      { id: "new-task", group: "Actions", title: "New task", hint: "n", run: () => start() },
      ...TABS.map((t) => ({ id: `tab-${t.label}`, group: "Go to", title: t.label, run: () => go(t.to) })),
      { id: "connect", group: "Actions", title: "Connect an agent…", run: () => setConnect(true) },
      { id: "delete-yard", group: "Actions", title: "Delete yard…", run: () => setDeleting(true) },
    ],
    [yard],
  );

  if (status.error)
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <Empty title="Can't load this yard" description={status.error.message} />
      </div>
    );
  const s = status.data;
  if (!s)
    return (
      <div className="p-10">
        <Loader />
      </div>
    );
  const name = s.yard.name;

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-8 pt-8 max-sm:px-4">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <h1 className="truncate text-h1">{name}</h1>
                <span title={live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline"}>
                  <Dot color={live === "live" ? "var(--color-good)" : live === "connecting" ? "var(--color-busy)" : "var(--color-bad)"} pulse={live !== "live"} />
                </span>
              </div>
              <p className="mt-1 font-mono text-[13px] text-muted">
                {params.owner}/{params.yard}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => setConnect(true)}>Connect an agent</Button>
              <Button variant="primary" icon={<Plus />} onClick={() => start()}>
                New task
              </Button>
              <DropdownMenu>
                <DropdownMenu.Trigger render={<Button size="icon" variant="ghost" aria-label="More" icon={<DotsThree size={18} weight="bold" />} />} />
                <DropdownMenu.Content sideOffset={6} align="end" className="min-w-44">
                  <DropdownMenu.Item onClick={() => setDeleting(true)} className="text-bad">
                    Delete yard…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            </div>
          </div>
          <nav aria-label="Yard" className="mt-6 -mb-px flex gap-1">
            {TABS.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                params={{ ...params, _splat: "" }}
                activeOptions={{ exact: t.exact, includeSearch: false }}
                className={cx("border-b-2 border-transparent px-3 pb-3 text-sm text-body hover:text-fg", "data-[status=active]:border-ink data-[status=active]:font-medium data-[status=active]:text-fg")}
              >
                {t.label}
                {t.label === "Overview" && (listed?.summary.needsYou ?? 0) > 0 && (
                  <span className="ml-1.5 rounded-full bg-overlap px-1.5 text-[11px] font-semibold text-white tabular-nums">{listed!.summary.needsYou}</span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-8 py-8 max-sm:px-4">
        <YardContext.Provider value={{ yard, start }}>
          <Outlet />
        </YardContext.Provider>
      </div>

      {newTask && <CreateTaskDialog key={newTask.brief} yard={yard} open setOpen={(o) => !o && setNewTask(null)} initialBrief={newTask.brief} />}
      <DeleteYardDialog yard={yard} name={name} open={deleting} setOpen={setDeleting} />
      <Dialog.Root open={connect} onOpenChange={setConnect}>
        <Dialog className="space-y-4 p-6" size="base">
          <Dialog.Title className="text-h2">Connect an agent</Dialog.Title>
          <Dialog.Description className="text-sm text-body">
            Your agents work with plain git. Once, make a token in Settings → Git access and clone {name} with it; git remembers it. Then open a task and use{" "}
            <b>Add your agent</b>: it gives you one line to hand over.
          </Dialog.Description>
          <ClipboardText text={`git clone ${location.origin}/git/${params.owner}/${params.yard}.git`} />
          <details className="text-[13px] text-body">
            <summary className="cursor-pointer">Prefer MCP tools?</summary>
            <p className="mt-2">
              Claude Code: <code className="font-mono text-fg">claude mcp add --transport http forkyard {location.origin}/mcp</code>
            </p>
          </details>
          <div className="flex justify-end">
            <Button onClick={() => setConnect(false)}>Done</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
