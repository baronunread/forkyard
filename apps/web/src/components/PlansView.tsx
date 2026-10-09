import { Empty } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { matchesGlob } from "@forkyard/shared";
import type { TaskDetail } from "../lib/api";
import { AgentBadge } from "./AgentChip";
import { Card, cx } from "./ui";

/**
 * Plans before code: what each agent means to do and the files it expects to touch, side by
 * side, before anyone writes a line. A file two agents plan to touch is marked on both.
 */
export function PlansView({ detail }: { detail: TaskDetail }) {
  const name = (id: string) => detail.agents.find((a) => a.id === id)?.name ?? id;
  const planned = detail.agents.filter((a) => a.intent || detail.claims.some((c) => c.agentId === a.id));
  if (!planned.length) return <Empty size="sm" title="No plans yet" description="Agents say what they'll do and which files they'll touch before they edit." />;
  /** Other agents whose claim overlaps this file, by the overlaps the yard detected. */
  const sharedWith = (agentId: string, pattern: string) =>
    [
      ...new Set(
        detail.overlaps
          .filter((o) => o.active && o.agents.includes(agentId) && (o.path === pattern || matchesGlob(pattern, o.path) || matchesGlob(o.path, pattern)))
          .flatMap((o) => o.agents.filter((a) => a !== agentId)),
      ),
    ].map(name);

  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
      {planned.map((a) => {
        const files = detail.claims.filter((c) => c.agentId === a.id).map((c) => c.pattern);
        const clashes = files.filter((f) => sharedWith(a.id, f).length).length;
        return (
          <Card key={a.id} className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <AgentBadge agent={a} size={22} />
              <span className="font-medium">{a.name}</span>
              {clashes > 0 && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-overlap">
                  <Warning weight="fill" /> {clashes} shared
                </span>
              )}
            </div>
            <div>
              <p className={cx("text-[15px] leading-snug", a.intent ? "text-fg" : "text-muted")}>{a.intent?.summary ?? "No plan written yet"}</p>
              {a.intent?.why && <p className="mt-1 line-clamp-3 text-[13px] text-body">{a.intent.why}</p>}
            </div>
            {files.length > 0 && (
              <ul className="space-y-1 border-t border-line pt-3 font-mono text-xs">
                {files.map((f) => {
                  const others = sharedWith(a.id, f);
                  return (
                    <li key={f} className={cx("flex items-baseline gap-2", others.length ? "text-overlap" : "text-body")}>
                      <span className="min-w-0 truncate" title={f}>
                        {f}
                      </span>
                      {others.length > 0 && <span className="shrink-0 font-sans">also {others.join(", ")}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
