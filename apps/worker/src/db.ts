import { Budgets, type Agent, type Ask, type ChangedFile, type Decision, type Intent, type Review, type Task, type Yard } from "@forkyard/shared";

/** Row mappers and small queries over D1. */

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function yardFromRow(r: Row): Yard {
  return {
    id: String(r.id),
    name: String(r.name),
    baseRepo: String(r.base_repo),
    defaultBranch: String(r.default_branch),
    jurisdiction: r.jurisdiction === "eu" ? "eu" : "default",
    previewUrlTemplate: s(r.preview_url_template),
    budgets: Budgets.parse(JSON.parse(String(r.budgets ?? "{}"))),
    createdAt: String(r.created_at),
  };
}

export function taskFromRow(r: Row): Task {
  return {
    id: String(r.id),
    yardId: String(r.yard_id),
    title: String(r.title),
    brief: String(r.brief),
    status: r.status as Task["status"],
    baseCommit: String(r.base_commit),
    createdAt: String(r.created_at),
    decidedAt: s(r.decided_at),
  };
}

export function agentFromRow(r: Row): Agent {
  return {
    id: String(r.id),
    yardId: String(r.yard_id),
    taskId: String(r.task_id),
    name: String(r.name),
    harness: String(r.harness),
    role: r.role === "judge" ? "judge" : "agent",
    color: String(r.color),
    initials: String(r.initials),
    status: r.status as Agent["status"],
    forkName: String(r.fork_name),
    forkRemote: s(r.fork_remote),
    headCommit: s(r.head_commit),
    forkMs: r.fork_ms === null || r.fork_ms === undefined ? null : Number(r.fork_ms),
    createdAt: String(r.created_at),
  };
}

export function intentFromRow(r: Row): Intent {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    taskId: String(r.task_id),
    summary: String(r.summary),
    why: String(r.why),
    details: s(r.details),
    commit: s(r.commit_hash),
    source: r.source as Intent["source"],
    createdAt: String(r.created_at),
  };
}

export function reviewFromRow(r: Row): Review {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    taskId: String(r.task_id),
    commit: String(r.commit_hash),
    score: Number(r.score),
    summary: String(r.summary),
    checks: JSON.parse(String(r.checks)),
    comments: JSON.parse(String(r.comments)),
    reviewer: String(r.reviewer),
    createdAt: String(r.created_at),
  };
}

export function decisionFromRow(r: Row): Decision {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    mode: r.mode === "assemble" ? "assemble" : "winner",
    winnerAgentId: s(r.winner_agent_id),
    selections: JSON.parse(String(r.selections)),
    resultCommit: String(r.result_commit),
    decidedBy: String(r.decided_by),
    createdAt: String(r.created_at),
  };
}

export async function getYard(db: D1Database, id: string): Promise<Yard | null> {
  const r = await db.prepare("SELECT * FROM yards WHERE id = ?").bind(id).first();
  return r ? yardFromRow(r) : null;
}

export async function listYards(db: D1Database): Promise<Yard[]> {
  const { results } = await db.prepare("SELECT * FROM yards ORDER BY created_at DESC").all();
  return results.map(yardFromRow);
}

export async function getTask(db: D1Database, yardId: string, taskId: string): Promise<Task | null> {
  const r = await db.prepare("SELECT * FROM tasks WHERE yard_id = ? AND id = ?").bind(yardId, taskId).first();
  return r ? taskFromRow(r) : null;
}

export async function listTasks(db: D1Database, yardId: string): Promise<Task[]> {
  const { results } = await db.prepare("SELECT * FROM tasks WHERE yard_id = ? ORDER BY created_at DESC").bind(yardId).all();
  return results.map(taskFromRow);
}

export async function listAgents(db: D1Database, yardId: string, taskId?: string): Promise<Agent[]> {
  const stmt = taskId
    ? db.prepare("SELECT * FROM agents WHERE yard_id = ? AND task_id = ? ORDER BY created_at, id").bind(yardId, taskId)
    : db.prepare("SELECT * FROM agents WHERE yard_id = ? ORDER BY created_at, id").bind(yardId);
  const { results } = await stmt.all();
  return results.map(agentFromRow);
}

export async function getAgent(db: D1Database, yardId: string, taskId: string, agentId: string): Promise<Agent | null> {
  const r = await db
    .prepare("SELECT * FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?")
    .bind(yardId, taskId, agentId)
    .first();
  return r ? agentFromRow(r) : null;
}

export async function agentByForkName(db: D1Database, forkName: string): Promise<Agent | null> {
  const r = await db.prepare("SELECT * FROM agents WHERE fork_name = ?").bind(forkName).first();
  return r ? agentFromRow(r) : null;
}

export async function latestIntents(db: D1Database, yardId: string, taskId: string): Promise<Map<string, Intent>> {
  const { results } = await db
    .prepare(
      `SELECT i.* FROM intents i
       JOIN (SELECT agent_id, MAX(created_at) AS m FROM intents WHERE yard_id = ? AND task_id = ? GROUP BY agent_id) x
       ON i.agent_id = x.agent_id AND i.created_at = x.m
       WHERE i.yard_id = ? AND i.task_id = ?`,
    )
    .bind(yardId, taskId, yardId, taskId)
    .all();
  return new Map(results.map((r) => [String(r.agent_id), intentFromRow(r)]));
}

export async function listIntents(db: D1Database, yardId: string, taskId: string, agentId?: string): Promise<Intent[]> {
  const stmt = agentId
    ? db.prepare("SELECT * FROM intents WHERE yard_id = ? AND task_id = ? AND agent_id = ? ORDER BY created_at").bind(yardId, taskId, agentId)
    : db.prepare("SELECT * FROM intents WHERE yard_id = ? AND task_id = ? ORDER BY created_at").bind(yardId, taskId);
  const { results } = await stmt.all();
  return results.map(intentFromRow);
}

export async function latestReviews(db: D1Database, yardId: string, taskId: string): Promise<Map<string, Review>> {
  const { results } = await db
    .prepare(
      `SELECT r.* FROM reviews r
       JOIN (SELECT agent_id, MAX(created_at) AS m FROM reviews WHERE yard_id = ? AND task_id = ? GROUP BY agent_id) x
       ON r.agent_id = x.agent_id AND r.created_at = x.m
       WHERE r.yard_id = ? AND r.task_id = ?`,
    )
    .bind(yardId, taskId, yardId, taskId)
    .all();
  return new Map(results.map((r) => [String(r.agent_id), reviewFromRow(r)]));
}

export async function listReviews(db: D1Database, yardId: string, taskId: string, agentId: string): Promise<Review[]> {
  const { results } = await db
    .prepare("SELECT * FROM reviews WHERE yard_id = ? AND task_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 20")
    .bind(yardId, taskId, agentId)
    .all();
  return results.map(reviewFromRow);
}

export async function latestDiff(
  db: D1Database,
  yardId: string,
  taskId: string,
  agentId: string,
  commit?: string | null,
): Promise<{ commit: string; baseCommit: string; files: ChangedFile[] } | null> {
  const r = commit
    ? await db
        .prepare("SELECT * FROM diffs WHERE yard_id = ? AND task_id = ? AND agent_id = ? AND commit_hash = ?")
        .bind(yardId, taskId, agentId, commit)
        .first()
    : await db
        .prepare("SELECT * FROM diffs WHERE yard_id = ? AND task_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(yardId, taskId, agentId)
        .first();
  return r ? { commit: String(r.commit_hash), baseCommit: String(r.base_commit), files: JSON.parse(String(r.files)) } : null;
}

export async function getDecision(db: D1Database, yardId: string, taskId: string): Promise<Decision | null> {
  const r = await db
    .prepare("SELECT * FROM decisions WHERE yard_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(yardId, taskId)
    .first();
  return r ? decisionFromRow(r) : null;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function now(): string {
  return new Date().toISOString();
}

export function askFromRow(r: Row): Ask {
  return {
    id: String(r.id),
    yardId: String(r.yard_id),
    taskId: s(r.task_id),
    agentId: s(r.agent_id),
    kind: r.kind as Ask["kind"],
    question: String(r.question),
    context: s(r.context),
    options: JSON.parse(String(r.options ?? "[]")) as Ask["options"],
    status: r.status as Ask["status"],
    answer: s(r.answer),
    answeredBy: s(r.answered_by),
    createdAt: String(r.created_at),
    answeredAt: s(r.answered_at),
  };
}

export async function getAsk(db: D1Database, yardId: string, id: string): Promise<Ask | null> {
  const r = await db.prepare("SELECT * FROM asks WHERE yard_id = ? AND id = ?").bind(yardId, id).first();
  return r ? askFromRow(r) : null;
}

/** Open asks across the given yards, oldest first: the oldest has waited longest. */
export async function openAsks(db: D1Database, yardIds: string[]): Promise<Ask[]> {
  if (!yardIds.length) return [];
  const out: Ask[] = [];
  for (let i = 0; i < yardIds.length; i += 90) {
    const ids = yardIds.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT * FROM asks WHERE status = 'open' AND yard_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at LIMIT 200`)
      .bind(...ids)
      .all();
    out.push(...results.map(askFromRow));
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
