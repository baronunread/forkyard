import type { Env } from "./env";
import { num } from "./env";
import type { Principal } from "./auth";
import { ServiceError } from "./service";

/**
 * Hard caps. Workers Paid bills usage with no ceiling, so Forkyard keeps its own:
 * every LIMIT_* var that is set is enforced; unset means no cap (local dev, swarm runs).
 * FORKYARD_PAUSED="true" stops new yards, tasks and model calls outright.
 *
 * Per account (people; the admin key is exempt): yards owned, tasks a day.
 * Whole deployment: agents per task, live forks, cloud-agent tool turns, Workers AI calls a day.
 */
export function limits(env: Env) {
  const cap = (v?: string) => num(v, Infinity);
  return {
    paused: env.FORKYARD_PAUSED === "true",
    yardsPerAccount: cap(env.LIMIT_YARDS_PER_ACCOUNT),
    tasksPerAccountPerDay: cap(env.LIMIT_TASKS_PER_ACCOUNT_PER_DAY),
    agentsPerTask: cap(env.LIMIT_AGENTS_PER_TASK),
    liveForks: cap(env.LIMIT_LIVE_FORKS),
    agentTurns: cap(env.LIMIT_AGENT_TURNS),
    workersAiPerDay: cap(env.LIMIT_WORKERS_AI_PER_DAY),
  };
}

const limited = (msg: string): never => {
  throw new ServiceError(429, `limit: ${msg}`);
};

function assertRunning(env: Env) {
  if (limits(env).paused) limited("this Forkyard is paused by its operator");
}

/** Count one use of `key` today; true while the count stays within `cap`. */
export async function spend(env: Env, key: string, cap: number): Promise<boolean> {
  if (cap === Infinity) return true;
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare("INSERT INTO usage (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(day, key)
    .first<{ n: number }>();
  return (r?.n ?? Infinity) <= cap;
}

export async function assertCanCreateYard(env: Env, p: Principal) {
  assertRunning(env);
  const l = limits(env);
  if (p.kind !== "user" || l.yardsPerAccount === Infinity) return;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM yard_members WHERE user_id = ? AND role = 'owner'").bind(p.userId).first<{ n: number }>();
  if ((r?.n ?? 0) >= l.yardsPerAccount) limited(`an account can own ${l.yardsPerAccount} yards`);
}

export async function assertCanCreateTask(env: Env, p: Principal, agents: number) {
  assertRunning(env);
  const l = limits(env);
  if (agents > l.agentsPerTask) limited(`at most ${l.agentsPerTask} agents per task`);
  if (l.liveForks !== Infinity) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE fork_deleted_at IS NULL AND status != 'failed'").first<{ n: number }>();
    if ((r?.n ?? 0) + agents > l.liveForks) limited(`${l.liveForks} live forks across Forkyard (${r?.n ?? 0} in use); decide or abandon a task first`);
  }
  if (p.kind === "user" && !(await spend(env, `tasks:${p.userId}`, l.tasksPerAccountPerDay)))
    limited(`an account can start ${l.tasksPerAccountPerDay} tasks a day`);
}

/** One Workers AI call (a review or a cloud-agent turn). False once today's budget is spent. */
export async function spendWorkersAi(env: Env): Promise<boolean> {
  const l = limits(env);
  return !l.paused && (await spend(env, "workers-ai", l.workersAiPerDay));
}
