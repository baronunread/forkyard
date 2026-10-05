import type { AutopilotState } from "@forkyard/shared";

/**
 * A task's state as one sentence a person can read at a glance, plus how far
 * along it is. Derived from agent statuses and the autopilot; the agents and
 * autopilot do the work, this only says where things stand.
 */
export type Tone = "calm" | "busy" | "attention" | "done";
export interface Phase {
  label: string;
  tone: Tone;
  /** 0..1, or null when there's nothing to measure. */
  progress: number | null;
}

interface AgentLite {
  status: string;
}

export function taskPhase(
  task: { status: string },
  agents: AgentLite[],
  autopilot: AutopilotState | undefined,
  needsYou: number,
  decision?: { mode: string; winnerAgentId: string | null; decidedBy: string } | null,
  agentName?: (id: string) => string,
): Phase {
  if (task.status === "decided") {
    const who = decision?.winnerAgentId ? `${agentName?.(decision.winnerAgentId) ?? decision.winnerAgentId}'s fork` : "an assembled change";
    const by = decision?.decidedBy === "autopilot" ? "by autopilot" : decision ? `by ${decision.decidedBy}` : "";
    return { label: `Merged ${who} ${by}`.trim(), tone: "done", progress: null };
  }
  if (task.status === "abandoned") return { label: "Abandoned", tone: "done", progress: null };
  if (needsYou > 0) return { label: needsYou === 1 ? "Needs you" : `${needsYou} things need you`, tone: "attention", progress: null };

  const live = agents.filter((a) => a.status !== "failed" && a.status !== "retired");
  const n = live.length;
  const reviewed = live.filter((a) => a.status === "reviewed").length;
  const forking = live.filter((a) => a.status === "forking").length;
  const progress = n ? reviewed / n : null;
  const agentsWord = (k: number) => `${k} agent${k === 1 ? "" : "s"}`;
  if (!n) return { label: "No agents left", tone: "attention", progress: null };
  if (forking === n) return { label: `Starting ${agentsWord(n)}`, tone: "busy", progress: 0 };
  if (reviewed === n)
    return autopilot === "waiting"
      ? { label: "All forks reviewed · merging the best one", tone: "busy", progress: 1 }
      : { label: "All forks reviewed · ready for your decision", tone: "attention", progress: 1 };
  return { label: `${agentsWord(n)} working · ${reviewed} reviewed`, tone: "busy", progress };
}
