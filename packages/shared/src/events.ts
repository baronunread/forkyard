import { z } from "zod";
import { Agent, Ask, Claim, Decision, Intent, Overlap, Review, Task } from "./schemas";

/**
 * Yard event log. The envelope is transport-independent: the same object is
 * appended to the Yard Durable Object log, fanned out over WebSockets,
 * forwarded to a K2 stream, and replayed through `events_since`.
 *
 * `seq` is the yard-local, gap-free offset. Producers never set it; the Yard
 * DO assigns it on append.
 */

const base = {
  seq: z.number().int().nonnegative(),
  id: z.string(),
  yardId: z.string(),
  ts: z.string(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
};

const ev = <T extends string, D extends z.ZodTypeAny>(type: T, data: D) =>
  z.object({ ...base, type: z.literal(type), data });

export const YardEvent = z.discriminatedUnion("type", [
  ev("yard.created", z.object({ baseRepo: z.string() })),
  ev("task.created", z.object({ task: Task, agentIds: z.array(z.string()) })),
  ev("agent.forking", z.object({ agent: Agent })),
  ev("agent.ready", z.object({ agent: Agent, forkMs: z.number() })),
  ev("agent.failed", z.object({ agent: Agent, error: z.string() })),
  ev("agent.status", z.object({ status: z.string(), note: z.string().nullable() })),
  ev("claim.added", z.object({ claims: z.array(Claim) })),
  ev("claim.released", z.object({ patterns: z.array(z.string()) })),
  ev("overlap.detected", z.object({ overlap: Overlap })),
  ev("overlap.cleared", z.object({ overlap: Overlap })),
  ev("intent.recorded", z.object({ intent: Intent })),
  ev(
    "push.received",
    z.object({
      ref: z.string(),
      before: z.string().nullable(),
      after: z.string(),
      message: z.string().nullable(),
      pushedAt: z.string().nullable(),
      transport: z.enum(["queue", "workflow", "local", "api"]),
    }),
  ),
  ev(
    "diff.updated",
    z.object({
      commit: z.string(),
      paths: z.array(z.string()),
      additions: z.number(),
      deletions: z.number(),
    }),
  ),
  ev("review.started", z.object({ commit: z.string(), workflowId: z.string() })),
  ev("review.completed", z.object({ review: Review })),
  ev("decision.made", z.object({ decision: Decision })),
  ev("task.abandoned", z.object({ reason: z.string() })),
  ev("fork.deleted", z.object({ forkName: z.string() })),
  ev("ask.opened", z.object({ ask: Ask })),
  ev("ask.answered", z.object({ ask: Ask })),
  ev("backlog.imported", z.object({ repo: z.string(), imported: z.number(), skipped: z.number(), error: z.string().nullable() })),
]);
export type YardEvent = z.infer<typeof YardEvent>;
export type YardEventType = YardEvent["type"];
export type YardEventOf<T extends YardEventType> = Extract<YardEvent, { type: T }>;

/** What producers hand to the log: everything except the fields the log assigns. */
export type NewYardEvent = {
  [K in YardEventType]: Omit<YardEventOf<K>, "seq" | "id" | "ts" | "yardId">;
}[YardEventType];

export const EVENT_TYPES = YardEvent.options.map((o) => o.shape.type.value) as YardEventType[];

/** Messages pushed over the yard WebSocket (server -> client). */
export type ServerMessage =
  | { kind: "hello"; yardId: string; head: number; role: "ui" | "agent"; agentId: string | null }
  | { kind: "event"; event: YardEvent }
  | { kind: "overlap"; overlap: Overlap; you: string }
  | { kind: "pong"; t: number };

/** Messages accepted over the yard WebSocket (client -> server). */
export type ClientMessage = { kind: "ping"; t: number } | { kind: "replay"; since: number };

/** Short, human-readable one-liner for timelines, logs and LLM digests. */
export function describeEvent(e: YardEvent, agentName: (id: string | null) => string = (id) => id ?? "?"): string {
  const who = agentName(e.agentId);
  switch (e.type) {
    case "yard.created":
      return `yard created on ${e.data.baseRepo}`;
    case "task.created":
      return `task "${e.data.task.title}" fanned out to ${e.data.agentIds.length} agents`;
    case "agent.forking":
      return `${who} is getting a fork`;
    case "agent.ready":
      return `${who}'s fork is ready (${Math.round(e.data.forkMs)} ms)`;
    case "agent.failed":
      return `${who} failed: ${e.data.error}`;
    case "agent.status":
      return `${who} is ${e.data.status}${e.data.note ? ` — ${e.data.note}` : ""}`;
    case "claim.added":
      return `${who} claimed ${e.data.claims.map((c) => c.pattern).join(", ")}`;
    case "claim.released":
      return `${who} released ${e.data.patterns.join(", ")}`;
    case "overlap.detected":
      return `overlap on ${e.data.overlap.path} between ${e.data.overlap.agents.map((a) => agentName(a)).join(" & ")} (${e.data.overlap.kind})`;
    case "overlap.cleared":
      return `overlap on ${e.data.overlap.path} cleared`;
    case "intent.recorded":
      return `${who}: ${e.data.intent.summary}`;
    case "push.received":
      return `${who} pushed ${e.data.after.slice(0, 7)}${e.data.message ? ` "${e.data.message.split("\n")[0]}"` : ""}`;
    case "diff.updated":
      return `${who} now changes ${e.data.paths.length} file(s), +${e.data.additions} −${e.data.deletions}`;
    case "review.started":
      return `review started for ${who} @ ${e.data.commit.slice(0, 7)}`;
    case "review.completed":
      return `${who} scored ${e.data.review.score}/100 — ${e.data.review.summary}`;
    case "decision.made":
      return e.data.decision.mode === "winner"
        ? `decided: ${agentName(e.data.decision.winnerAgentId)} wins → ${e.data.decision.resultCommit.slice(0, 7)}`
        : `decided: assembled from ${new Set(e.data.decision.selections.map((s) => s.agentId)).size} forks → ${e.data.decision.resultCommit.slice(0, 7)}`;
    case "task.abandoned":
      return `task abandoned: ${e.data.reason}`;
    case "fork.deleted":
      return `fork ${e.data.forkName} deleted`;
    case "ask.opened":
      return e.agentId ? `${who} asked for help: ${e.data.ask.question}` : `needs a decision: ${e.data.ask.question}`;
    case "ask.answered":
      return `${e.data.ask.answeredBy ?? "someone"} answered: ${e.data.ask.answer ?? ""}`;
    case "backlog.imported":
      return e.data.error ? `couldn't import issues from ${e.data.repo}: ${e.data.error}` : `imported ${e.data.imported} issues from ${e.data.repo}`;
  }
}
