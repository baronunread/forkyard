import { ClipboardText, Empty, Loader } from "@cloudflare/kumo";
import { GitCommit, Lightning } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Card, SectionTitle } from "../components/ui";
import type { Change } from "../lib/api";
import { ago } from "../lib/format";
import { codeLogQuery } from "../lib/queries";
import { ChangeLine } from "./CodePage";
import { useYard } from "./YardLayout";

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

function dayOf(at: string): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return DAY.format(d);
}

/**
 * What happened to the code, day by day. A change that came from a task reads as that task:
 * its title, how it was decided and the agents who did it, not a merge commit.
 */
export function LogPage() {
  const { yard } = useYard();
  const log = useQuery(codeLogQuery(yard));
  if (log.error) return <Empty title="Can't read the log" description={log.error.message} />;
  if (!log.data) return <Loader />;
  const days = new Map<string, Change[]>();
  for (const c of log.data.changes) days.set(dayOf(c.at), [...(days.get(dayOf(c.at)) ?? []), c]);
  const now = Date.now();

  return (
    <div className="max-w-4xl space-y-8">
      {[...days].map(([day, changes]) => (
        <section key={day} aria-label={day}>
          <SectionTitle className="mb-3 text-body">{day}</SectionTitle>
          <Card className="divide-y divide-line overflow-hidden">
            {changes.map((c) => (
              <div key={c.commit} className="flex items-center gap-4 px-5 py-3.5">
                {c.task ? <Lightning weight="fill" className="shrink-0 text-busy" /> : <GitCommit className="shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  <ChangeLine yard={yard} change={c} className="font-medium" />
                  <div className="mt-0.5 text-[13px] text-body">
                    {c.task ? (c.task.mode === "assemble" ? `Assembled from ${c.agents.length} ${c.agents.length === 1 ? "agent" : "agents"}` : "One fork won") : `by ${c.author}`}
                  </div>
                </div>
                <code className="shrink-0 font-mono text-xs text-muted">{c.commit.slice(0, 7)}</code>
                <span className="w-20 shrink-0 text-right text-xs text-muted">{ago(c.at, now)}</span>
              </div>
            ))}
          </Card>
        </section>
      ))}
      <div className="text-[13px] text-body">
        <p className="mb-2">The base repo, for tools that speak git (agents get their own fork per task):</p>
        <ClipboardText text={log.data.remote} />
      </div>
    </div>
  );
}
