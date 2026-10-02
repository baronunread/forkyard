import {
  Budgets,
  baseRepoName,
  matchesGlob,
  summarize,
  type Agent,
  type ChangedFile,
  type ClaimInput,
  type CreateTaskInput,
  type CreateYardInput,
  type DecideInput,
  type FileCompare,
  type ForkDiff,
  type IntentInput,
  type Overlap,
  type Review,
  type Intent,
  type Task,
  type Yard,
} from "@forkyard/shared";
import { disposeRepo, errorCode, getArtifacts } from "./artifacts";
import { actingAgent, assertAdmin, assertCanDecide, assertMemberOrAdmin, assertPerson, assertTask, assertYard, AuthError, isMember, type Principal } from "./auth";
import {
  getAgent,
  getDecision,
  getTask,
  getYard,
  latestDiff,
  latestIntents,
  latestReviews,
  listAgents,
  listIntents,
  listReviews,
  listYards,
  newId,
  now,
} from "./db";
import { applyDecision, DecideError, previewDecision } from "./decide";
import { computeHunks, forkDiff, mapLimit, readPathAt } from "./diff";
import type { Env } from "./env";
import { buildCommit, textFile } from "./git/build";
import { deletePreviewBranch, previewBranchSlug } from "./preview";
import { yardStub } from "./yard";

export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500,
    message: string,
  ) {
    super(message);
  }
}

export function toServiceError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  if (err instanceof AuthError) return new ServiceError(err.status, err.message);
  if (err instanceof DecideError) return new ServiceError(err.status, err.message);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("budget:")) return new ServiceError(429, msg);
  if (/not found/i.test(msg)) return new ServiceError(404, msg);
  if (/is (decided|abandoned|closed)|already/i.test(msg)) return new ServiceError(409, msg);
  const code = errorCode(err);
  if (code === "NOT_FOUND") return new ServiceError(404, msg);
  if (code === "ALREADY_EXISTS") return new ServiceError(409, msg);
  if (code?.startsWith("INVALID")) return new ServiceError(400, msg);
  return new ServiceError(500, msg);
}

async function mustYard(env: Env, yardId: string): Promise<Yard> {
  const y = await getYard(env.DB, yardId);
  if (!y) throw new ServiceError(404, `yard ${yardId} not found`);
  return y;
}

async function mustTask(env: Env, yardId: string, taskId: string): Promise<Task> {
  const t = await getTask(env.DB, yardId, taskId);
  if (!t) throw new ServiceError(404, `task ${taskId} not found in yard ${yardId}`);
  return t;
}

export function previewUrl(yard: Yard, agent: Pick<Agent, "id" | "taskId" | "forkName">): string | null {
  if (!yard.previewUrlTemplate) return null;
  return yard.previewUrlTemplate
    .replaceAll("{branch}", previewBranchSlug(agent.taskId, agent.id))
    .replaceAll("{yard}", yard.id)
    .replaceAll("{task}", agent.taskId)
    .replaceAll("{agent}", agent.id)
    .replaceAll("{fork}", agent.forkName);
}

// ── yards ──────────────────────────────────────────────────────────────────

export async function yardsList(env: Env, p: Principal): Promise<Yard[]> {
  const all = await listYards(env.DB);
  if (p.kind === "agent") return all.filter((y) => y.id === p.yardId);
  if (p.kind === "user") {
    const visible = await Promise.all(all.map((y) => isMember(env, p.userId, y.id)));
    return all.filter((_, i) => visible[i]);
  }
  return all;
}

export async function yardCreate(env: Env, p: Principal, input: CreateYardInput): Promise<Yard> {
  assertPerson(p);
  if (await getYard(env.DB, input.id)) throw new ServiceError(409, `yard ${input.id} already exists`);
  const artifacts = getArtifacts(env, input.jurisdiction);
  const name = baseRepoName(input.id);
  if (input.importUrl) {
    await artifacts.import({ source: { url: input.importUrl, depth: 50 }, target: { name, opts: { description: `Forkyard base for ${input.id}` } } });
    // Imports finish asynchronously; wait until the repo answers.
    for (let i = 0; ; i++) {
      try {
        disposeRepo(await artifacts.get(name));
        break;
      } catch (err) {
        if (errorCode(err) !== "IMPORT_IN_PROGRESS" || i > 120) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } else {
    await artifacts.create(name, { description: `Forkyard base for ${input.id}`, setDefaultBranch: "main" });
    const files = input.files ?? { "README.md": `# ${input.name ?? input.id}\n\nCreated by Forkyard.\n` };
    const built = await buildCommit({
      reader: { readTree: async () => null },
      baseTree: null,
      parents: [],
      changes: new Map(Object.entries(files).map(([path, text]) => [path.replace(/^\/+/, ""), textFile(text)])),
      message: "Initial commit",
      author: { name: "Forkyard", email: "seed@forkyard.dev" },
    });
    await artifacts.writeCommit(name, built, "refs/heads/main", null);
  }
  const repo = await artifacts.get(name);
  let defaultBranch = "main";
  try {
    defaultBranch = (await repo.info()).defaultBranch;
  } finally {
    disposeRepo(repo);
  }
  const yard: Yard = {
    id: input.id,
    name: input.name ?? input.id,
    baseRepo: name,
    defaultBranch,
    jurisdiction: input.jurisdiction,
    previewUrlTemplate: input.previewUrlTemplate ?? null,
    budgets: Budgets.parse(input.budgets ?? {}),
    createdAt: now(),
  };
  await env.DB.prepare(
    "INSERT INTO yards (id, name, base_repo, default_branch, jurisdiction, preview_url_template, budgets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(yard.id, yard.name, yard.baseRepo, yard.defaultBranch, yard.jurisdiction, yard.previewUrlTemplate, JSON.stringify(yard.budgets), yard.createdAt)
    .run();
  if (p.kind === "user")
    await env.DB.prepare("INSERT INTO yard_members (yard_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(yard.id, p.userId, now()).run();
  await yardStub(env, yard).init(yard);
  return yard;
}

export async function yardStatus(env: Env, p: Principal, yardId: string) {
  await assertYard(env, p, yardId);
  const yard = await mustYard(env, yardId);
  const status = await yardStub(env, yard).status();
  return { ...status, agents: status.agents.map((a) => ({ ...a, previewUrl: previewUrl(yard, a) })) };
}

export async function yardBaseLog(env: Env, p: Principal, yardId: string, limit = 20) {
  await assertYard(env, p, yardId);
  const yard = await mustYard(env, yardId);
  const repo = await getArtifacts(env, yard.jurisdiction).get(yard.baseRepo);
  try {
    const info = await repo.info();
    const log = await repo.log({ ref: yard.defaultBranch, limit });
    return { remote: info.remote, defaultBranch: yard.defaultBranch, commits: log };
  } finally {
    disposeRepo(repo);
  }
}

// ── tasks ──────────────────────────────────────────────────────────────────

export async function taskCreate(env: Env, p: Principal, yardId: string, input: CreateTaskInput) {
  await assertMemberOrAdmin(env, p, yardId);
  const yard = await mustYard(env, yardId);
  if (input.id && (await getTask(env.DB, yardId, input.id))) throw new ServiceError(409, `task ${input.id} already exists`);
  const res = await yardStub(env, yard).createTask(input, p.label);
  return { ...res, agents: res.agents.map((a) => ({ ...a, previewUrl: previewUrl(yard, a) })) };
}

export async function taskList(env: Env, p: Principal, yardId: string): Promise<Task[]> {
  await assertYard(env, p, yardId);
  const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE yard_id = ? ORDER BY created_at DESC").bind(yardId).all();
  const tasks = await Promise.all(results.map((r) => getTask(env.DB, yardId, String(r.id))));
  return tasks.filter((t): t is Task => !!t && (p.kind !== "agent" || t.id === p.taskId));
}

export async function waitForAgent(env: Env, p: Principal, yardId: string, taskId: string, agentId: string): Promise<Agent> {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).waitForAgent(taskId, agentId);
}

export async function taskGet(env: Env, p: Principal, yardId: string, taskId: string) {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  const [agents, intents, reviews, decision, status] = await Promise.all([
    listAgents(env.DB, yardId, taskId),
    latestIntents(env.DB, yardId, taskId),
    latestReviews(env.DB, yardId, taskId),
    getDecision(env.DB, yardId, taskId),
    yardStub(env, yard).status(0),
  ]);
  return {
    yard,
    task,
    agents: agents.map((a) => ({
      ...a,
      previewUrl: previewUrl(yard, a),
      intent: intents.get(a.id) ?? null,
      review: reviews.get(a.id) ?? null,
    })),
    claims: status.claims.filter((c) => c.taskId === taskId),
    overlaps: status.overlaps.filter((o) => o.taskId === taskId),
    decision,
  };
}

export async function taskAbandon(env: Env, p: Principal, yardId: string, taskId: string, reason: string) {
  await assertMemberOrAdmin(env, p, yardId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  if (task.status !== "open") throw new ServiceError(409, `task is ${task.status}`);
  await yardStub(env, yard).abandon(taskId, reason);
  return { ok: true };
}

// ── agent workspace, claims, intents ───────────────────────────────────────

export async function workspaceGet(env: Env, p: Principal, yardId: string, taskId: string, agentId?: string) {
  const id = await actingAgent(env, p, yardId, taskId, agentId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).workspace(taskId, id);
}

export async function claimPaths(env: Env, p: Principal, yardId: string, taskId: string, input: ClaimInput & { agentId?: string }) {
  const id = await actingAgent(env, p, yardId, taskId, input.agentId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).claim(taskId, id, input.paths);
}

export async function releasePaths(env: Env, p: Principal, yardId: string, taskId: string, input: { paths?: string[]; agentId?: string }) {
  const id = await actingAgent(env, p, yardId, taskId, input.agentId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).release(taskId, id, input.paths ?? null);
}

export async function intentRecord(env: Env, p: Principal, yardId: string, taskId: string, input: IntentInput & { agentId?: string }) {
  const id = await actingAgent(env, p, yardId, taskId, input.agentId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  if (task.status !== "open") throw new ServiceError(409, `task is ${task.status}`);
  return yardStub(env, yard).recordIntent(taskId, id, input, p.kind === "agent" ? "mcp" : "api");
}

export async function intentsList(env: Env, p: Principal, yardId: string, taskId: string, agentId?: string): Promise<Intent[]> {
  await assertTask(env, p, yardId, taskId);
  return listIntents(env.DB, yardId, taskId, agentId);
}

// ── events ─────────────────────────────────────────────────────────────────

export async function eventsSince(
  env: Env,
  p: Principal,
  yardId: string,
  since: number,
  limit: number,
  filter: { taskId?: string; agentId?: string; types?: string[] },
) {
  await assertYard(env, p, yardId);
  const yard = await mustYard(env, yardId);
  // Agents only see their own task (and yard-level events).
  const f = p.kind === "agent" ? { ...filter, taskId: p.taskId } : filter;
  return yardStub(env, yard).eventsSince(since, limit, f);
}

// ── diffs and comparison ───────────────────────────────────────────────────

export async function agentDiff(env: Env, p: Principal, yardId: string, taskId: string, agentId: string): Promise<ForkDiff> {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  const agent = await getAgent(env.DB, yardId, taskId, agentId);
  if (!agent) throw new ServiceError(404, `agent ${agentId} not found`);
  if (!agent.headCommit) return { agentId, baseCommit: task.baseCommit, headCommit: null, files: [] };
  const cached = await latestDiff(env.DB, yardId, taskId, agentId, agent.headCommit);
  if (cached) return { agentId, baseCommit: cached.baseCommit, headCommit: cached.commit, files: cached.files };
  // Review pipeline has not caught up yet: compute on demand.
  const repo = await getArtifacts(env, yard.jurisdiction).get(agent.forkName);
  try {
    const files = await forkDiff(repo, task.baseCommit, agent.headCommit);
    return { agentId, baseCommit: task.baseCommit, headCommit: agent.headCommit, files };
  } finally {
    disposeRepo(repo);
  }
}

export interface CompareSummary {
  task: Task;
  baseCommit: string;
  agents: {
    agent: Agent & { previewUrl: string | null };
    intent: Intent | null;
    review: Review | null;
    files: ChangedFile[];
    additions: number;
    deletions: number;
  }[];
  files: { path: string; agents: { agentId: string; status: ChangedFile["status"]; additions: number; deletions: number }[]; overlap: boolean }[];
  overlaps: Overlap[];
}

export async function compareForks(env: Env, p: Principal, yardId: string, taskId: string): Promise<CompareSummary> {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  const [agents, intents, reviews, status] = await Promise.all([
    listAgents(env.DB, yardId, taskId),
    latestIntents(env.DB, yardId, taskId),
    latestReviews(env.DB, yardId, taskId),
    yardStub(env, yard).status(0),
  ]);
  const diffs = await mapLimit(agents, 6, async (a) => (a.headCommit ? (await agentDiff(env, p, yardId, taskId, a.id)).files : []));
  const byPath = new Map<string, CompareSummary["files"][number]>();
  agents.forEach((a, i) => {
    for (const f of diffs[i]!) {
      const e = byPath.get(f.path) ?? { path: f.path, agents: [], overlap: false };
      e.agents.push({ agentId: a.id, status: f.status, additions: f.additions, deletions: f.deletions });
      e.overlap = e.agents.length > 1;
      byPath.set(f.path, e);
    }
  });
  const overlaps = status.overlaps.filter((o) => o.taskId === taskId);
  for (const o of overlaps) for (const f of byPath.values()) if (matchesGlob(f.path, o.path)) f.overlap = true;
  return {
    task,
    baseCommit: task.baseCommit,
    agents: agents.map((a, i) => ({
      agent: { ...a, previewUrl: previewUrl(yard, a) },
      intent: intents.get(a.id) ?? null,
      review: reviews.get(a.id) ?? null,
      files: diffs[i]!,
      additions: diffs[i]!.reduce((n, f) => n + f.additions, 0),
      deletions: diffs[i]!.reduce((n, f) => n + f.deletions, 0),
    })),
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    overlaps,
  };
}

export async function compareFile(env: Env, p: Principal, yardId: string, taskId: string, path: string, agentIds?: string[]): Promise<FileCompare> {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  const agents = (await listAgents(env.DB, yardId, taskId)).filter((a) => !agentIds?.length || agentIds.includes(a.id));
  const artifacts = getArtifacts(env, yard.jurisdiction);
  const baseRepo = await artifacts.get(yard.baseRepo);
  let base: Awaited<ReturnType<typeof readPathAt>>;
  try {
    base = await readPathAt(baseRepo, task.baseCommit, path);
  } finally {
    disposeRepo(baseRepo);
  }
  const versions = await mapLimit(agents, 6, async (a) => {
    if (!a.headCommit) return { agentId: a.id, status: "unchanged" as const, contents: base.text, binary: base.binary, hunks: [] };
    const repo = await artifacts.get(a.forkName);
    try {
      const v = await readPathAt(repo, a.headCommit, path);
      if (v.binary || base.binary)
        return { agentId: a.id, status: (v.exists ? (base.exists ? "modified" : "added") : "deleted") as "modified", contents: null, binary: true, hunks: [] };
      const same = v.exists === base.exists && v.text === base.text;
      const status = same ? ("unchanged" as const) : !v.exists ? ("deleted" as const) : !base.exists ? ("added" as const) : ("modified" as const);
      return {
        agentId: a.id,
        status,
        contents: v.exists ? v.text : null,
        binary: false,
        hunks: same ? [] : computeHunks(path, base.text ?? "", v.text ?? ""),
      };
    } finally {
      disposeRepo(repo);
    }
  });
  return { path, base: base.exists ? base.text : null, baseBinary: base.binary, versions };
}

export async function reviewGet(env: Env, p: Principal, yardId: string, taskId: string, agentId: string): Promise<Review[]> {
  await assertTask(env, p, yardId, taskId);
  return listReviews(env.DB, yardId, taskId, agentId);
}

// ── decisions ──────────────────────────────────────────────────────────────

export async function decidePreview(env: Env, p: Principal, yardId: string, taskId: string, input: DecideInput) {
  await assertTask(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  return previewDecision(env, yard, task, input);
}

export async function decide(env: Env, p: Principal, yardId: string, taskId: string, input: DecideInput) {
  await assertCanDecide(env, p, yardId, taskId);
  const yard = await mustYard(env, yardId);
  const task = await mustTask(env, yardId, taskId);
  const res = await applyDecision(env, yard, task, input, p.label);
  await yardStub(env, yard).onDecision(res.decision);
  return res;
}

// ── benchmarks ─────────────────────────────────────────────────────────────

export async function benchFork(env: Env, p: Principal, yardId: string, concurrency: number, label?: string) {
  await assertMemberOrAdmin(env, p, yardId);
  const yard = await mustYard(env, yardId);
  const n = Math.max(1, Math.min(100, Math.floor(concurrency)));
  const artifacts = getArtifacts(env, yard.jurisdiction);
  const base = await artifacts.get(yard.baseRepo);
  const run = newId("bf").slice(0, 10);
  const names = Array.from({ length: n }, (_, i) => `${yard.id}--bench--${run}${i}`);
  const t0 = performance.now();
  const results = await Promise.all(
    names.map(async (name) => {
      const s = performance.now();
      try {
        await base.fork(name, { description: "forkyard bench", defaultBranchOnly: true });
        return { ok: true as const, ms: performance.now() - s };
      } catch (err) {
        return { ok: false as const, ms: performance.now() - s, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const wallMs = performance.now() - t0;
  disposeRepo(base);
  // Clean up right away: bench forks must never linger into billing.
  await Promise.allSettled(names.map((name) => artifacts.delete(name)));
  const samples = results.filter((r) => r.ok).map((r) => Math.round(r.ms * 10) / 10);
  const stats = summarize(samples);
  const record = {
    id: newId("bench_"),
    kind: "fork",
    label: label ?? `fork x${n}`,
    mode: artifacts.mode,
    concurrency: n,
    stats: { ...stats, wallMs: Math.round(wallMs), failures: results.filter((r) => !r.ok).length },
    createdAt: now(),
  };
  await env.DB.prepare("INSERT INTO bench_runs (id, kind, label, mode, concurrency, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(record.id, record.kind, record.label, record.mode, n, JSON.stringify(record.stats), record.createdAt)
    .run();
  return { ...record, samples, errors: results.filter((r) => !r.ok).map((r) => ("error" in r ? r.error : "")).slice(0, 5) };
}

export async function benchRecord(
  env: Env,
  p: Principal,
  input: { kind: string; label: string; mode: string; concurrency: number; stats: Record<string, unknown> },
) {
  assertPerson(p);
  const id = newId("bench_");
  await env.DB.prepare("INSERT INTO bench_runs (id, kind, label, mode, concurrency, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.kind, input.label, input.mode, input.concurrency, JSON.stringify(input.stats), now())
    .run();
  return { id };
}

export async function benchList(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM bench_runs ORDER BY created_at DESC LIMIT 200").all();
  return results.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    label: String(r.label),
    mode: String(r.mode),
    concurrency: Number(r.concurrency),
    stats: JSON.parse(String(r.stats)) as Record<string, number>,
    createdAt: String(r.created_at),
  }));
}

export async function latency(env: Env, p: Principal, yardId: string) {
  await assertYard(env, p, yardId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).latencyStats();
}

export async function startK2Poll(env: Env, p: Principal, yardId: string, seconds: number) {
  await assertMemberOrAdmin(env, p, yardId);
  const yard = await mustYard(env, yardId);
  return yardStub(env, yard).startK2Poll(seconds);
}

// ── cleanup ────────────────────────────────────────────────────────────────

/** Delete forks of decided/abandoned tasks older than the TTL. Runs from cron. */
export async function cleanupForks(env: Env, ttlHours: number): Promise<{ deleted: string[]; failed: string[] }> {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT a.yard_id, a.task_id, a.id, a.fork_name, y.jurisdiction FROM agents a
     JOIN tasks t ON t.yard_id = a.yard_id AND t.id = a.task_id
     JOIN yards y ON y.id = a.yard_id
     WHERE a.fork_deleted_at IS NULL AND t.status IN ('decided','abandoned') AND t.decided_at <= ?
     LIMIT 200`,
  )
    .bind(cutoff)
    .all<{ yard_id: string; task_id: string; id: string; fork_name: string; jurisdiction: string }>();
  const deleted: string[] = [];
  const failed: string[] = [];
  await mapLimit(results, 8, async (r) => {
    try {
      await getArtifacts(env, r.jurisdiction === "eu" ? "eu" : "default").delete(r.fork_name);
      const yard = await getYard(env.DB, r.yard_id);
      if (yard?.previewUrlTemplate) await deletePreviewBranch(env, yard, r.task_id, r.id).catch((err) => console.warn("preview branch cleanup", err));
      await env.DB.prepare("UPDATE agents SET fork_deleted_at = ? WHERE yard_id = ? AND task_id = ? AND id = ?")
        .bind(now(), r.yard_id, r.task_id, r.id)
        .run();
      await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE yard_id = ? AND task_id = ? AND agent_id = ? AND revoked_at IS NULL")
        .bind(now(), r.yard_id, r.task_id, r.id)
        .run();
      await yardStub(env, { id: r.yard_id, jurisdiction: r.jurisdiction === "eu" ? "eu" : "default" }).forkDeleted(r.task_id, r.id, r.fork_name);
      deleted.push(r.fork_name);
    } catch (err) {
      console.warn("cleanup failed", r.fork_name, err);
      failed.push(r.fork_name);
    }
  });
  return { deleted, failed };
}

/**
 * Admin sweep before billing starts: optionally abandon stale open tasks,
 * delete forks of closed tasks past `ttlHours`, and remove leftover bench forks.
 */
export async function adminCleanup(
  env: Env,
  p: Principal,
  opts: { ttlHours: number; abandonOpenOlderThanHours?: number; sweepBench?: boolean },
) {
  assertAdmin(p);
  const abandoned: string[] = [];
  if (opts.abandonOpenOlderThanHours !== undefined) {
    const cutoff = new Date(Date.now() - opts.abandonOpenOlderThanHours * 3600_000).toISOString();
    const { results } = await env.DB.prepare("SELECT yard_id, id FROM tasks WHERE status = 'open' AND created_at <= ?").bind(cutoff).all<{ yard_id: string; id: string }>();
    for (const t of results) {
      const yard = await getYard(env.DB, t.yard_id);
      if (!yard) continue;
      await yardStub(env, yard).abandon(t.id, "abandoned by admin cleanup");
      abandoned.push(`${t.yard_id}/${t.id}`);
    }
  }
  const forks = await cleanupForks(env, opts.ttlHours);
  const bench: string[] = [];
  if (opts.sweepBench) {
    for (const j of ["default", "eu"] as const) {
      let artifacts;
      try {
        artifacts = getArtifacts(env, j);
      } catch {
        continue;
      }
      let cursor: string | undefined;
      do {
        const page = await artifacts.list({ limit: 200, cursor });
        for (const r of page.repos) if (r.name.includes("--bench--") && (await artifacts.delete(r.name))) bench.push(r.name);
        cursor = page.cursor;
      } while (cursor);
    }
  }
  return { abandoned, deletedForks: forks.deleted, failedForks: forks.failed, deletedBenchForks: bench };
}

export function forbid(message: string): never {
  throw new ServiceError(403, message);
}
