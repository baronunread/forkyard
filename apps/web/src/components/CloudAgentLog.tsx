import { Cloud } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { call, taskRoute } from "../lib/api";
import { cx } from "./ui";

/** What a cloud agent (Pi on Cloudflare) has done, folded away: its own transcript, tool calls and all. */
export function CloudAgentLog({ yard, task, agent }: { yard: string; task: string; agent: string }) {
  const log = useQuery({
    queryKey: ["yard", yard, "task", task, "agent", agent, "transcript"],
    queryFn: () => call(taskRoute.agents[":agent"].transcript.$get({ param: { yard, task, agent } })),
    refetchInterval: 4000,
  });
  const entries = (log.data?.entries ?? []).filter((e) => e.text.trim() && e.kind !== "pi.system");
  return (
    <details className="group rounded-lg bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-medium">
        <Cloud size={16} className="text-body" /> What it did, step by step
        <span className="ml-auto text-xs font-normal text-muted">{entries.length} steps</span>
      </summary>
      <ol className="max-h-80 space-y-1 overflow-y-auto border-t border-line px-5 py-3 text-[13px]">
        {entries.length === 0 && <li className="text-body">Starting…</li>}
        {entries.map((e, i) => (
          <li key={i} className={cx("whitespace-pre-wrap break-words", e.kind === "pi.user" ? "text-body" : e.kind === "pi.tool-result" ? "pl-4 font-mono text-xs text-muted" : "text-fg")}>
            {e.kind === "pi.tool-result" ? e.text.slice(0, 300) : e.text.slice(0, 600)}
          </li>
        ))}
      </ol>
    </details>
  );
}
