import { DurableObject } from "cloudflare:workers";
import {
  AGENTS_MD_TEMPLATE,
  detectOverlaps,
  describeEvent,
  forkName,
  initialsFor,
  normalizePattern,
  pickAgentColor,
  slugify,
  summarize,
  type Agent,
  type AgentCredential,
  type Ask,
  type AskKind,
  type AutopilotState,
  type ChangedFile,
  type Claim,
  type CreateTaskInput,
  type Decision,
  type Intent,
  type IntentInput,
  type NewYardEvent,
  type Overlap,
  type Review,
  type ServerMessage,
  type Task,
  type Workspace,
  type Yard as YardRecord,
  type YardEvent,
} from "@forkyard/shared";
import { disposeRepo, errorCode, getArtifacts, type Repo } from "./artifacts";
import { agentFromRow, askFromRow, getAsk, getYard, latestIntents, latestReviews, listAgents, newId, now, sha256Hex } from "./db";
import { applyDecision, DecideError } from "./decide";
import { mapLimit } from "./diff";
import { num, type Env } from "./env";

/**
 * One Durable Object per yard. It owns the live state that must be strongly
 * ordered and pushed to clients in real time:
 *
 * - the yard event log (gap-free `seq` offsets; replay via `eventsSince`)
 * - path claims and footprints, and the overlaps derived from them
 * - WebSockets to the UI and to agents (Hibernation API)
 * - in-flight fork fan-outs
 *
 * Durable relational records (tasks, agents, intents, reviews, decisions)
 * are written to D1 from here so D1 has a single writer per yard.
 */

interface SocketInfo {
  role: "ui" | "agent";
  agentId: string | null;
  taskId: string | null;
}

/** Overlap sizes worth a new entry in the shared log (it always starts at 2). */
const OVERLAP_MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const PULSE_WINDOW_MS = 120_000;
const PULSE_BUCKET_MS = 5_000;

/** How often the alarm re-checks the review queue while reviews are waiting. */
const REVIEW_TICK_MS = 500;

export interface YardStatus {
  yard: YardRecord;
  head: number;
  tasks: Task[];
  agents: Agent[];
  claims: Claim[];
  overlaps: Overlap[];
  recent: YardEvent[];
  connected: { ui: number; agents: number };
  /** The review scheduler: reviews in flight and agents waiting for one. */
  reviews: { running: number; queued: number };
  /** Recent activity from the event log: pushes per bucket (oldest first) and per-minute rates. */
  pulse: { buckets: number[]; bucketMs: number; pushesPerMin: number; reviewsPerMin: number; overlapsPerMin: number };
  /** What needs a person in this yard, oldest first. */
  asks: Ask[];
  /** Autopilot state per task. */
  autopilot: Record<string, AutopilotState>;
  /** How each decided task was decided. */
  decisions: Record<string, { mode: Decision["mode"]; winnerAgentId: string | null; decidedBy: string; resultCommit: string }>;
}

export interface PushInput {
  repoName: string;
  ref: string;
  before: string | null;
  after: string;
  message: string | null;
  pushedAt: string | null;
  transport: "queue" | "workflow" | "local" | "api";
  emittedAt?: string | null;
  startReview: boolean;
}

export class Yard extends DurableObject<Env> {
  private sql: SqlStorage;
  private yardCache: YardRecord | null = null;
  private forks = new Map<string, Promise<Agent>>();
  private reservedTaskIds = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
        task_id TEXT, agent_id TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS claims (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, pattern TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id, pattern)
      );
      CREATE TABLE IF NOT EXISTS reviews_pending (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, queued_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS reviews_inflight (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, commit_hash TEXT NOT NULL, started_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS footprints (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, head TEXT NOT NULL, changed TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS overlaps (
        task_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, agents TEXT NOT NULL,
        active INTEGER NOT NULL, detected_at TEXT NOT NULL, PRIMARY KEY (task_id, key)
      );
      CREATE TABLE IF NOT EXISTS fork_tokens (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT,
        PRIMARY KEY (task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS autopilot (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS k2_samples (seq INTEGER NOT NULL, type TEXT NOT NULL, latency_ms REAL NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_samples (seq INTEGER NOT NULL, latency_ms REAL NOT NULL, observed_at TEXT NOT NULL);
    `);
  }

  // ── yard metadata ──────────────────────────────────────────────────────────

  async init(yard: YardRecord): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('yard', ?)", JSON.stringify(yard));
    this.yardCache = yard;
    await this.append({ type: "yard.created", taskId: null, agentId: null, data: { baseRepo: yard.baseRepo } });
  }

  private async yard(): Promise<YardRecord> {
    if (this.yardCache) return this.yardCache;
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'yard'").toArray()[0];
    if (row) return (this.yardCache = JSON.parse(row.v) as YardRecord);
    throw new Error("yard not initialised");
  }

  private artifacts() {
    return this.yardCache ? getArtifacts(this.env, this.yardCache.jurisdiction) : getArtifacts(this.env);
  }

  // ── event log ─────────────────────────────────────────────────────────────

  async append(e: NewYardEvent): Promise<YardEvent> {
    const yard = this.yardCache ?? (await this.yard().catch(() => null));
    const id = newId("ev_");
    const ts = now();
    const cur = this.sql.exec(
      "INSERT INTO events (id, ts, type, task_id, agent_id, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
      id,
      ts,
      e.type,
      e.taskId,
      e.agentId,
      JSON.stringify(e.data),
    );
    const seq = Number(cur.one().seq);
    const event = { ...e, seq, id, ts, yardId: yard?.id ?? "?" } as YardEvent;
    this.broadcast({ kind: "event", event }, event.taskId);
    if (this.env.EVENTS_K2) this.ctx.waitUntil(this.forwardToK2(event));
    return event;
  }

  private async forwardToK2(event: YardEvent) {
    try {
      const res = await this.env.EVENTS_K2!.send([
        {
          content: new TextEncoder().encode(JSON.stringify(event)),
          headers: { "event-type": event.type, "yard-id": event.yardId },
        },
      ]);
      if (!res.success) console.warn("k2 send failed", res.error?.message);
    } catch (err) {
      console.warn("k2 send threw", err);
    }
  }

  async eventsSince(
    since: number,
    limit = 200,
    filter: { taskId?: string; agentId?: string; types?: string[] } = {},
  ): Promise<{ events: YardEvent[]; head: number; next: number }> {
    const yard = await this.yard();
    const clauses = ["seq > ?"];
    const args: (string | number)[] = [since];
    if (filter.taskId) {
      clauses.push("(task_id = ? OR task_id IS NULL)");
      args.push(filter.taskId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.types?.length) {
      clauses.push(`type IN (${filter.types.map(() => "?").join(",")})`);
      args.push(...filter.types);
    }
    const rows = this.sql
      .exec<Record<string, string | number | null>>(
        `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`,
        ...args,
        Math.min(1000, Math.max(1, limit)),
      )
      .toArray();
    const events = rows.map((r) => this.rowToEvent(r, yard.id));
    return { events, head: this.head(), next: events.length ? events[events.length - 1]!.seq : since };
  }

  private rowToEvent(r: Record<string, string | number | null>, yardId: string): YardEvent {
    return {
      seq: Number(r.seq),
      id: String(r.id),
      ts: String(r.ts),
      type: r.type,
      taskId: r.task_id === null ? null : String(r.task_id),
      agentId: r.agent_id === null ? null : String(r.agent_id),
      yardId,
      data: JSON.parse(String(r.data)),
    } as YardEvent;
  }

  private head(): number {
    return Number(this.sql.exec<{ h: number | null }>("SELECT MAX(seq) AS h FROM events").one().h ?? 0);
  }

  // ── tasks and fan-out ─────────────────────────────────────────────────────

  async createTask(
    input: CreateTaskInput,
    createdBy: string,
  ): Promise<{ task: Task; agents: Agent[]; credentials: AgentCredential[] }> {
    const yard = await this.yard();
    const db = this.env.DB;
    if (input.agents.length > yard.budgets.maxAgentsPerTask)
      throw new Error(`budget: at most ${yard.budgets.maxAgentsPerTask} agents per task in this yard`);
    const live = await db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE yard_id = ? AND fork_deleted_at IS NULL AND status != 'failed'")
      .bind(yard.id)
      .first<{ n: number }>();
    if ((live?.n ?? 0) + input.agents.length > yard.budgets.maxActiveForks)
      throw new Error(`budget: this yard allows ${yard.budgets.maxActiveForks} live forks (${live?.n ?? 0} in use)`);

    const taskId = input.id ?? (await this.uniqueTaskId(slugify(input.title, 24)));
    const base = await this.artifacts().get(yard.baseRepo);
    let baseCommit: string;
    try {
      const [head] = await base.log({ ref: yard.defaultBranch, limit: 1 });
      if (!head) throw new Error("base repo has no commits");
      baseCommit = head.hash;
    } finally {
      disposeRepo(base);
    }

    const createdAt = now();
    const task: Task = { id: taskId, yardId: yard.id, title: input.title, brief: input.brief, status: "open", baseCommit, createdAt, decidedAt: null };
    const taken = new Set<string>();
    const usedColors: string[] = [];
    const agents: Agent[] = input.agents.map((spec) => {
      let id = slugify(spec.name, 20);
      for (let i = 2; taken.has(id); i++) id = `${slugify(spec.name, 17)}-${i}`;
      taken.add(id);
      const color = pickAgentColor(spec.name, usedColors);
      usedColors.push(color.hex);
      return {
        id,
        yardId: yard.id,
        taskId,
        name: spec.name,
        harness: spec.harness,
        role: spec.role,
        color: color.hex,
        initials: initialsFor(spec.name),
        status: "forking",
        forkName: forkName(yard.id, taskId, id),
        forkRemote: null,
        headCommit: null,
        forkMs: null,
        createdAt,
      };
    });
    const credentials: AgentCredential[] = [];
    const stmts: D1PreparedStatement[] = [
      db
        .prepare("INSERT INTO tasks (yard_id, id, title, brief, status, base_commit, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)")
        .bind(yard.id, taskId, input.title, input.brief, baseCommit, createdAt),
    ];
    for (const a of agents) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO agents (yard_id, task_id, id, name, harness, role, color, initials, status, fork_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'forking', ?, ?)`,
          )
          .bind(yard.id, taskId, a.id, a.name, a.harness, a.role, a.color, a.initials, a.forkName, createdAt),
      );
      const apiKey = `fy_${a.id}_${crypto.randomUUID().replace(/-/g, "")}`;
      credentials.push({ agentId: a.id, apiKey });
      stmts.push(
        db
          .prepare("INSERT INTO api_keys (key_hash, yard_id, task_id, agent_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(await sha256Hex(apiKey), yard.id, taskId, a.id, a.role, createdAt),
      );
    }
    // D1 batches are transactions; keep each one small so a thousand-agent fan-out doesn't hit limits.
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));

    this.setAutopilot(taskId, input.autopilot === false ? "off" : "waiting");
    await this.append({ type: "task.created", taskId, agentId: null, data: { task, agentIds: agents.map((a) => a.id) } });
    for (const a of agents) await this.append({ type: "agent.forking", taskId, agentId: a.id, data: { agent: a } });

    // Fan out: every fork starts now, concurrently; each resolves on its own.
    const fanout = this.fanOut(yard, task, agents);
    this.ctx.waitUntil(fanout);
    void createdBy;
    return { task, agents, credentials };
  }

  /**
   * A free task id. Concurrent task_create calls interleave at the D1 await, so an id is
   * reserved in memory the moment it's picked (this object is the only writer for its yard).
   */
  private async uniqueTaskId(base: string): Promise<string> {
    const yard = await this.yard();
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base.slice(0, 21)}-${i}`;
      if (this.reservedTaskIds.has(id)) continue;
      this.reservedTaskIds.add(id);
      const r = await this.env.DB.prepare("SELECT 1 FROM tasks WHERE yard_id = ? AND id = ?").bind(yard.id, id).first();
      if (!r) return id;
    }
  }

  /**
   * Every fork starts as soon as a slot is free (FORK_CONCURRENCY at a time, so a
   * thousand-agent task doesn't open a thousand fork calls at once). Each agent's
   * promise exists from the start, so workspace_get can wait on its own fork.
   */
  private async fanOut(yard: YardRecord, task: Task, agents: Agent[]): Promise<void> {
    const base = await this.artifacts().get(yard.baseRepo);
    const limit = Math.max(1, num(this.env.FORK_CONCURRENCY, 64));
    const starts = agents.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    });
    const done = agents.map((a, i) => {
      const p = starts[i]!.promise.then(() => this.forkOne(base, task, a));
      this.forks.set(`${task.id}/${a.id}`, p);
      return p.finally(() => this.forks.delete(`${task.id}/${a.id}`));
    });
    try {
      await mapLimit(agents, limit, async (_a, i) => {
        starts[i]!.resolve();
        await done[i]!.catch(() => undefined);
      });
    } finally {
      disposeRepo(base);
    }
  }

  private async forkOne(base: Repo, task: Task, agent: Agent): Promise<Agent> {
    const t0 = performance.now();
    const description = `Forkyard ${task.yardId}/${task.id} — ${agent.name}`;
    let remote: string | null = null;
    let token: string | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !remote; attempt++) {
      try {
        const res = await base.fork(agent.forkName, { description, defaultBranchOnly: true });
        remote = res.remote;
        token = res.token;
      } catch (err) {
        lastErr = err;
        const code = errorCode(err);
        if (code === "ALREADY_EXISTS") {
          // Idempotent retry of a fan-out: adopt the existing fork.
          const existing = await this.artifacts().get(agent.forkName);
          try {
            remote = (await existing.info()).remote;
          } finally {
            disposeRepo(existing);
          }
        } else if (code === "INTERNAL_ERROR" || code === "UPSTREAM_UNAVAILABLE" || code === "FORK_IN_PROGRESS") {
          await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
        } else break;
      }
    }
    // Workers freeze timers between I/O, so wall-clock deltas are measured around the fork call itself.
    const forkMs = Math.round((performance.now() - t0) * 10) / 10;
    if (!remote) {
      const error = lastErr instanceof Error ? lastErr.message : String(lastErr);
      await this.env.DB.prepare("UPDATE agents SET status = 'failed' WHERE yard_id = ? AND task_id = ? AND id = ?")
        .bind(task.yardId, task.id, agent.id)
        .run();
      const failed = { ...agent, status: "failed" as const };
      await this.append({ type: "agent.failed", taskId: task.id, agentId: agent.id, data: { agent: failed, error } });
      return failed;
    }
    if (token)
      this.sql.exec(
        "INSERT OR REPLACE INTO fork_tokens (task_id, agent_id, token, expires_at) VALUES (?, ?, ?, NULL)",
        task.id,
        agent.id,
        token,
      );
    await this.env.DB.prepare(
      "UPDATE agents SET status = 'ready', fork_remote = ?, fork_ms = ? WHERE yard_id = ? AND task_id = ? AND id = ?",
    )
      .bind(remote, forkMs, task.yardId, task.id, agent.id)
      .run();
    const ready: Agent = { ...agent, status: "ready", forkRemote: remote, forkMs };
    await this.append({ type: "agent.ready", taskId: task.id, agentId: agent.id, data: { agent: ready, forkMs } });
    return ready;
  }

  /** Resolve when this agent's own fork is ready (or failed) — never waits on the others. */
  async waitForAgent(taskId: string, agentId: string): Promise<Agent> {
    const pending = this.forks.get(`${taskId}/${agentId}`);
    if (pending) return pending;
    const yard = await this.yard();
    const r = await this.env.DB.prepare("SELECT * FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?")
      .bind(yard.id, taskId, agentId)
      .first();
    if (!r) throw new Error(`agent ${agentId} not found on task ${taskId}`);
    const agent = agentFromRow(r);
    if (agent.status !== "forking") return agent;
    // The DO restarted mid fan-out: poll D1 briefly.
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const again = await this.env.DB.prepare("SELECT * FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?")
        .bind(yard.id, taskId, agentId)
        .first();
      if (again && again.status !== "forking") return agentFromRow(again);
    }
    return agent;
  }

  async workspace(taskId: string, agentId: string): Promise<Workspace> {
    const yard = await this.yard();
    const agent = await this.waitForAgent(taskId, agentId);
    if (agent.status === "failed") throw new Error(`fork for ${agentId} failed; create a new task or retry`);
    if (agent.status === "retired") throw new Error(`task ${taskId} is closed; ${agentId} has no workspace anymore`);
    const task = await this.env.DB.prepare("SELECT * FROM tasks WHERE yard_id = ? AND id = ?").bind(yard.id, taskId).first();
    if (!task) throw new Error("task not found");

    // Hand out the fork's initial token once; mint scoped, expiring tokens after that.
    let token: string;
    let tokenExpiresAt: string | null = null;
    const stored = this.sql
      .exec<{ token: string; expires_at: string | null }>("SELECT token, expires_at FROM fork_tokens WHERE task_id = ? AND agent_id = ?", taskId, agentId)
      .toArray()[0];
    if (stored) {
      token = stored.token;
      tokenExpiresAt = stored.expires_at;
      this.sql.exec("DELETE FROM fork_tokens WHERE task_id = ? AND agent_id = ?", taskId, agentId);
    } else {
      const repo = await this.artifacts().get(agent.forkName);
      try {
        const t = await repo.createToken("write", num(this.env.TOKEN_TTL_SECONDS, 4 * 3600));
        token = t.plaintext;
        tokenExpiresAt = t.expiresAt;
      } finally {
        disposeRepo(repo);
      }
    }
    const remote = agent.forkRemote!;
    const t = {
      id: String(task.id),
      yardId: yard.id,
      title: String(task.title),
      brief: String(task.brief),
      status: task.status as Task["status"],
      baseCommit: String(task.base_commit),
      createdAt: String(task.created_at),
      decidedAt: task.decided_at ? String(task.decided_at) : null,
    };
    return {
      agent,
      task: t,
      yard,
      git: {
        remote,
        token,
        tokenExpiresAt,
        branch: yard.defaultBranch,
        cloneCommand: `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote} ${agent.id}`,
      },
      agentsMd: AGENTS_MD_TEMPLATE,
      digest: await this.digest(taskId, agentId),
    };
  }

  /** What every other agent on this task is doing, in a form an LLM can read. */
  async digest(taskId: string, forAgent: string | null): Promise<string> {
    const yard = await this.yard();
    const agents = await listAgents(this.env.DB, yard.id, taskId);
    const intents = await latestIntents(this.env.DB, yard.id, taskId);
    const claims = this.claimsFor(taskId);
    const fps = this.footprints(taskId);
    const overlaps = this.overlapsFor(taskId).filter((o) => o.active);
    const lines: string[] = [];
    for (const a of agents) {
      if (a.id === forAgent) continue;
      const i = intents.get(a.id);
      const c = claims.filter((x) => x.agentId === a.id).map((x) => x.pattern);
      const changed = fps.get(a.id) ?? [];
      lines.push(
        `- ${a.name} [${a.initials}] (${a.harness}) — ${a.status}` +
          (i ? `\n  intent: ${i.summary} — ${i.why.split("\n")[0]}` : "") +
          (c.length ? `\n  claims: ${c.join(", ")}` : "") +
          (changed.length ? `\n  changed: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ` (+${changed.length - 20})` : ""}` : ""),
      );
    }
    const mine = forAgent ? overlaps.filter((o) => o.agents.includes(forAgent)) : overlaps;
    const ov = mine.map((o) => `- ${o.kind} overlap on ${o.path} with ${o.agents.filter((a) => a !== forAgent).join(", ")}`);
    return [
      lines.length ? `Other agents on this task:\n${lines.join("\n")}` : "You are the only agent on this task.",
      ov.length ? `\nOverlaps involving you:\n${ov.join("\n")}` : "\nNo overlaps involving you right now.",
    ].join("\n");
  }

  // ── claims and overlaps ───────────────────────────────────────────────────

  private claimsFor(taskId: string): Claim[] {
    return this.sql
      .exec<{ task_id: string; agent_id: string; pattern: string; created_at: string }>(
        "SELECT * FROM claims WHERE task_id = ? ORDER BY created_at",
        taskId,
      )
      .toArray()
      .map((r) => ({ taskId: r.task_id, agentId: r.agent_id, pattern: r.pattern, createdAt: r.created_at }));
  }

  private footprints(taskId: string): Map<string, string[]> {
    return new Map(
      this.sql
        .exec<{ agent_id: string; changed: string }>("SELECT agent_id, changed FROM footprints WHERE task_id = ?", taskId)
        .toArray()
        .map((r) => [r.agent_id, JSON.parse(r.changed) as string[]]),
    );
  }

  private overlapsFor(taskId: string): Overlap[] {
    return this.sql
      .exec<{ task_id: string; key: string; kind: string; path: string; agents: string; active: number; detected_at: string }>(
        "SELECT * FROM overlaps WHERE task_id = ? ORDER BY detected_at",
        taskId,
      )
      .toArray()
      .map((r) => ({
        key: r.key,
        taskId: r.task_id,
        kind: r.kind as Overlap["kind"],
        path: r.path,
        agents: JSON.parse(r.agents) as string[],
        active: !!r.active,
        detectedAt: r.detected_at,
      }));
  }

  async claim(taskId: string, agentId: string, patterns: string[]): Promise<{ claims: Claim[]; overlaps: Overlap[] }> {
    await this.assertOpen(taskId);
    const createdAt = now();
    const added: Claim[] = [];
    for (const raw of patterns) {
      const pattern = normalizePattern(raw);
      if (!pattern) continue;
      const exists = this.sql.exec("SELECT 1 FROM claims WHERE task_id = ? AND agent_id = ? AND pattern = ?", taskId, agentId, pattern).toArray();
      if (exists.length) continue;
      this.sql.exec("INSERT INTO claims (task_id, agent_id, pattern, created_at) VALUES (?, ?, ?, ?)", taskId, agentId, pattern, createdAt);
      added.push({ taskId, agentId, pattern, createdAt });
    }
    if (added.length) await this.append({ type: "claim.added", taskId, agentId, data: { claims: added } });
    await this.markWorking(taskId, agentId, "claimed paths");
    await this.recomputeOverlaps(taskId);
    return {
      claims: this.claimsFor(taskId).filter((c) => c.agentId === agentId),
      overlaps: this.overlapsFor(taskId).filter((o) => o.active && o.agents.includes(agentId)),
    };
  }

  async release(taskId: string, agentId: string, patterns: string[] | null): Promise<{ released: string[]; overlaps: Overlap[] }> {
    const mine = this.claimsFor(taskId).filter((c) => c.agentId === agentId).map((c) => c.pattern);
    const target = patterns ? patterns.map(normalizePattern).filter((p) => mine.includes(p)) : mine;
    for (const p of target) this.sql.exec("DELETE FROM claims WHERE task_id = ? AND agent_id = ? AND pattern = ?", taskId, agentId, p);
    if (target.length) await this.append({ type: "claim.released", taskId, agentId, data: { patterns: target } });
    await this.recomputeOverlaps(taskId);
    return { released: target, overlaps: this.overlapsFor(taskId).filter((o) => o.active && o.agents.includes(agentId)) };
  }

  private async recomputeOverlaps(taskId: string): Promise<void> {
    const yard = await this.yard();
    const agents = (await listAgents(this.env.DB, yard.id, taskId)).filter((a) => a.status !== "failed" && a.status !== "retired");
    const claims = this.claimsFor(taskId);
    const fps = this.footprints(taskId);
    const detected = detectOverlaps(
      agents.map((a) => ({
        agentId: a.id,
        claims: claims.filter((c) => c.agentId === a.id).map((c) => c.pattern),
        changed: fps.get(a.id) ?? [],
      })),
    );
    const current = new Map(this.overlapsFor(taskId).map((o) => [o.key, o]));
    const seen = new Set<string>();
    for (const d of detected) {
      seen.add(d.key);
      const prev = current.get(d.key);
      const sameAgents = prev && prev.agents.join(",") === d.agents.join(",");
      if (prev?.active && sameAgents) continue;
      const overlap: Overlap = {
        key: d.key,
        taskId,
        kind: d.kind,
        path: d.path,
        agents: d.agents,
        active: true,
        // An overlap that grows keeps the time it was first seen.
        detectedAt: prev?.active ? prev.detectedAt : now(),
      };
      this.sql.exec(
        "INSERT OR REPLACE INTO overlaps (task_id, key, kind, path, agents, active, detected_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        taskId,
        d.key,
        d.kind,
        d.path,
        JSON.stringify(d.agents),
        overlap.detectedAt,
      );
      // Every agent newly in the overlap is told directly. The shared log only records it when
      // it starts and when it crosses a size milestone, so a hot file in a thousand-agent swarm
      // is a handful of events, not one per agent that touches it.
      const before = prev?.active ? new Set(prev.agents) : new Set<string>();
      const joined = d.agents.filter((a) => !before.has(a));
      const crossed = OVERLAP_MILESTONES.some((m) => before.size < m && d.agents.length >= m);
      if (!prev?.active || crossed) await this.append({ type: "overlap.detected", taskId, agentId: null, data: { overlap } });
      for (const a of joined) this.sendToAgent(taskId, a, { kind: "overlap", overlap, you: a });
    }
    for (const [key, prev] of current) {
      if (!prev.active || seen.has(key)) continue;
      this.sql.exec("UPDATE overlaps SET active = 0 WHERE task_id = ? AND key = ?", taskId, key);
      await this.append({ type: "overlap.cleared", taskId, agentId: null, data: { overlap: { ...prev, active: false } } });
    }
  }

  private async assertOpen(taskId: string): Promise<void> {
    const yard = await this.yard();
    const t = await this.env.DB.prepare("SELECT status FROM tasks WHERE yard_id = ? AND id = ?").bind(yard.id, taskId).first<{ status: string }>();
    if (!t) throw new Error(`task ${taskId} not found`);
    if (t.status !== "open") throw new Error(`task ${taskId} is ${t.status}`);
  }

  // ── intents, pushes, diffs, reviews, decisions ───────────────────────────

  async recordIntent(
    taskId: string,
    agentId: string,
    input: IntentInput,
    source: Intent["source"],
    commit: string | null = null,
  ): Promise<Intent> {
    const yard = await this.yard();
    const intent: Intent = {
      id: newId("in_"),
      agentId,
      taskId,
      summary: input.summary,
      why: input.why,
      details: input.details ?? null,
      commit,
      source,
      createdAt: now(),
    };
    await this.env.DB.prepare(
      "INSERT INTO intents (id, yard_id, task_id, agent_id, summary, why, details, commit_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(intent.id, yard.id, taskId, agentId, intent.summary, intent.why, intent.details, commit, source, intent.createdAt)
      .run();
    await this.append({ type: "intent.recorded", taskId, agentId, data: { intent } });
    if (source !== "git") await this.markWorking(taskId, agentId, "recorded an intent");
    return intent;
  }

  /** First sign of life after the fork is ready moves an agent from `ready` to `working`. */
  private async markWorking(taskId: string, agentId: string, note: string): Promise<void> {
    const yard = await this.yard();
    const res = await this.env.DB.prepare("UPDATE agents SET status = 'working' WHERE yard_id = ? AND task_id = ? AND id = ? AND status = 'ready'")
      .bind(yard.id, taskId, agentId)
      .run();
    if (res.meta.changes) await this.append({ type: "agent.status", taskId, agentId, data: { status: "working", note } });
  }

  async onPush(agent: Agent, input: PushInput): Promise<{ workflowId: string | null }> {
    const yard = await this.yard();
    const received = Date.now();
    // Event delivery is not ordered: a late event for an older push must not move the
    // head backwards, so read the fork's actual branch head instead of trusting `after`.
    const onDefault = input.ref === `refs/heads/${yard.defaultBranch}`;
    let head = input.after;
    if (onDefault) {
      const repo = await this.artifacts().get(agent.forkName);
      try {
        const [c] = await repo.log({ ref: yard.defaultBranch, limit: 1 });
        if (c) head = c.hash;
      } catch {
        /* fall back to the event's commit */
      } finally {
        disposeRepo(repo);
      }
    }
    if (onDefault)
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE agents SET head_commit = ?, status = CASE WHEN status IN ('retired','failed') THEN status ELSE 'pushed' END WHERE yard_id = ? AND task_id = ? AND id = ?",
        ).bind(head, yard.id, agent.taskId, agent.id),
        // The latest intent without a commit is attached to this push.
        this.env.DB.prepare(
          `UPDATE intents SET commit_hash = ? WHERE id = (
             SELECT id FROM intents WHERE yard_id = ? AND task_id = ? AND agent_id = ? AND commit_hash IS NULL ORDER BY created_at DESC LIMIT 1)`,
        ).bind(input.after, yard.id, agent.taskId, agent.id),
      ]);
    const ev = await this.append({
      type: "push.received",
      taskId: agent.taskId,
      agentId: agent.id,
      data: {
        ref: input.ref,
        before: input.before,
        after: input.after,
        message: input.message,
        pushedAt: input.pushedAt,
        transport: input.transport,
      },
    });
    if (input.emittedAt) {
      const lat = received - Date.parse(input.emittedAt);
      if (Number.isFinite(lat)) this.sql.exec("INSERT INTO live_samples (seq, latency_ms, observed_at) VALUES (?, ?, ?)", ev.seq, lat, now());
    }
    if (!input.startReview || !onDefault || this.env.REVIEWS === "off") return { workflowId: null };
    // Queue the review and return: the push is already visible, and starting a Workflow must
    // not hold up the next event in the queue. The alarm starts it within a tick.
    this.sql.exec("INSERT OR IGNORE INTO reviews_pending (task_id, agent_id, queued_at) VALUES (?, ?, ?)", agent.taskId, agent.id, Date.now());
    await this.scheduleReviewTick();
    return { workflowId: this.reviewId(agent.forkName, head) };
  }

  private reviewId(forkName: string, head: string): string {
    return `${forkName}-${head.slice(0, 12)}`.slice(0, 100);
  }

  /**
   * Reviews are scheduled, not fired per push:
   *  - one review per agent at a time; a push during a review is covered by the next one,
   *    which reviews whatever the agent's head is by then;
   *  - at most REVIEW_CONCURRENCY reviews in flight per yard; the rest queue and start as
   *    slots free (onReview). A swarm of a thousand agents pushing at once is a queue of
   *    reviews, not a thousand simultaneous Workflow instances.
   * A review that never reports back is considered lost after REVIEW_STALE_MS.
   */
  /**
   * One drain at a time: concurrent callers (alarm, onReview, a push) would otherwise both
   * pick the same queued agent while the first is still awaiting D1. A call that arrives
   * mid-drain asks for one more pass instead.
   */
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private async drainReviews(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.drainOnce();
        } while (this.drainAgain);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    // Whatever happens below, the alarm comes back while anything is still queued.
    if (Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews_pending").one().n) > 0) await this.scheduleReviewTick();
    const REVIEW_STALE_MS = 5 * 60_000;
    const cap = Math.max(1, num(this.env.REVIEW_CONCURRENCY, 16));
    this.sql.exec("DELETE FROM reviews_inflight WHERE started_at < ?", Date.now() - REVIEW_STALE_MS);
    const busy = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews_inflight").one().n);
    if (busy >= cap) return;
    const next = this.sql
      .exec<{ task_id: string; agent_id: string }>(
        `SELECT p.task_id, p.agent_id FROM reviews_pending p
         WHERE NOT EXISTS (SELECT 1 FROM reviews_inflight i WHERE i.task_id = p.task_id AND i.agent_id = p.agent_id)
         ORDER BY p.queued_at LIMIT ?`,
        cap - busy,
      )
      .toArray();
    if (!next.length) return;
    const yard = await this.yard();
    for (const { task_id: taskId, agent_id: agentId } of next) {
      this.sql.exec("DELETE FROM reviews_pending WHERE task_id = ? AND agent_id = ?", taskId, agentId);
      const row = await this.env.DB.prepare(
        `SELECT a.head_commit, a.fork_name, a.status, t.base_commit, t.status AS task_status FROM agents a
         JOIN tasks t ON t.yard_id = a.yard_id AND t.id = a.task_id WHERE a.yard_id = ? AND a.task_id = ? AND a.id = ?`,
      )
        .bind(yard.id, taskId, agentId)
        .first<{ head_commit: string | null; fork_name: string; status: string; base_commit: string; task_status: string }>();
      if (!row?.head_commit || row.task_status !== "open" || row.status === "retired") continue;
      const head = row.head_commit;
      const running = this.sql
        .exec<{ commit_hash: string }>("SELECT commit_hash FROM reviews_inflight WHERE task_id = ? AND agent_id = ?", taskId, agentId)
        .toArray()[0];
      if (running?.commit_hash === head) continue;
      const workflowId = this.reviewId(row.fork_name, head);
      this.sql.exec("INSERT OR REPLACE INTO reviews_inflight (task_id, agent_id, commit_hash, started_at) VALUES (?, ?, ?, ?)", taskId, agentId, head, Date.now());
      try {
        await this.env.REVIEW_WORKFLOW.create({
          id: workflowId,
          params: { kind: "forkyard", yardId: yard.id, taskId, agentId, forkName: row.fork_name, commit: head, baseCommit: row.base_commit, jurisdiction: yard.jurisdiction },
        });
        await this.append({ type: "review.started", taskId, agentId, data: { commit: head, workflowId } });
      } catch (err) {
        // The same head was already reviewed (an older instance): nothing new to do.
        this.sql.exec("DELETE FROM reviews_inflight WHERE task_id = ? AND agent_id = ?", taskId, agentId);
        if (!String(err).toLowerCase().includes("already")) console.error("review start failed", err);
      }
    }
  }

  async onDiff(taskId: string, agentId: string, commit: string, files: ChangedFile[]): Promise<void> {
    const paths = files.map((f) => f.path);
    this.sql.exec(
      "INSERT OR REPLACE INTO footprints (task_id, agent_id, head, changed) VALUES (?, ?, ?, ?)",
      taskId,
      agentId,
      commit,
      JSON.stringify(paths),
    );
    const additions = files.reduce((n, f) => n + f.additions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    await this.append({ type: "diff.updated", taskId, agentId, data: { commit, paths, additions, deletions } });
    await this.recomputeOverlaps(taskId);
  }

  async onReview(review: Review): Promise<void> {
    const yard = await this.yard();
    await this.env.DB.prepare(
      "UPDATE agents SET status = 'reviewed' WHERE yard_id = ? AND task_id = ? AND id = ? AND status IN ('pushed','working','ready') AND head_commit = ?",
    )
      .bind(yard.id, review.taskId, review.agentId, review.commit)
      .run();
    await this.append({ type: "review.completed", taskId: review.taskId, agentId: review.agentId, data: { review } });
    // Free the slot. If the agent pushed while this review ran, review its newest head next.
    this.sql.exec("DELETE FROM reviews_inflight WHERE task_id = ? AND agent_id = ?", review.taskId, review.agentId);
    const row = await this.env.DB.prepare("SELECT head_commit FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?")
      .bind(yard.id, review.taskId, review.agentId)
      .first<{ head_commit: string | null }>();
    if (row?.head_commit && row.head_commit !== review.commit)
      this.sql.exec("INSERT OR IGNORE INTO reviews_pending (task_id, agent_id, queued_at) VALUES (?, ?, ?)", review.taskId, review.agentId, Date.now());
    await this.drainReviews();
    if (this.autopilotOf(review.taskId) === "waiting") await this.wakeAt(Date.now() + this.quietMs());
  }

  /** A review gave up (its Workflow failed): free the slot and let the queue move. */
  async reviewFailed(taskId: string, agentId: string, commit: string): Promise<void> {
    this.sql.exec("DELETE FROM reviews_inflight WHERE task_id = ? AND agent_id = ? AND commit_hash = ?", taskId, agentId, commit);
    await this.drainReviews();
  }

  async onDecision(decision: Decision): Promise<void> {
    const yard = await this.yard();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE tasks SET status = 'decided', decided_at = ? WHERE yard_id = ? AND id = ?").bind(decision.createdAt, yard.id, decision.taskId),
      this.env.DB.prepare("UPDATE agents SET status = 'retired' WHERE yard_id = ? AND task_id = ? AND status != 'failed'").bind(yard.id, decision.taskId),
    ]);
    this.sql.exec("DELETE FROM claims WHERE task_id = ?", decision.taskId);
    this.sql.exec("UPDATE overlaps SET active = 0 WHERE task_id = ?", decision.taskId);
    this.sql.exec("DELETE FROM fork_tokens WHERE task_id = ?", decision.taskId);
    if (decision.decidedBy === "autopilot") this.setAutopilot(decision.taskId, "merged");
    await this.append({ type: "decision.made", taskId: decision.taskId, agentId: null, data: { decision } });
    await this.closeAsks(decision.taskId, "The task was decided.");
  }

  async abandon(taskId: string, reason: string): Promise<void> {
    const yard = await this.yard();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE tasks SET status = 'abandoned', decided_at = ? WHERE yard_id = ? AND id = ? AND status = 'open'").bind(now(), yard.id, taskId),
      this.env.DB.prepare("UPDATE agents SET status = 'retired' WHERE yard_id = ? AND task_id = ? AND status != 'failed'").bind(yard.id, taskId),
    ]);
    this.sql.exec("DELETE FROM claims WHERE task_id = ?", taskId);
    this.sql.exec("UPDATE overlaps SET active = 0 WHERE task_id = ?", taskId);
    this.sql.exec("DELETE FROM fork_tokens WHERE task_id = ?", taskId);
    await this.append({ type: "task.abandoned", taskId, agentId: null, data: { reason } });
    await this.closeAsks(taskId, "The task was abandoned.");
  }

  async forkDeleted(taskId: string, agentId: string, name: string): Promise<void> {
    await this.append({ type: "fork.deleted", taskId, agentId, data: { forkName: name } });
  }

  // ── status ────────────────────────────────────────────────────────────────

  async status(recent = 40): Promise<YardStatus> {
    const yard = await this.yard();
    const { results: taskRows } = await this.env.DB.prepare("SELECT * FROM tasks WHERE yard_id = ? ORDER BY created_at DESC").bind(yard.id).all();
    const agents = await listAgents(this.env.DB, yard.id);
    const { results: decisionRows } = await this.env.DB.prepare("SELECT task_id, mode, winner_agent_id, decided_by, result_commit FROM decisions WHERE yard_id = ?")
      .bind(yard.id)
      .all<{ task_id: string; mode: Decision["mode"]; winner_agent_id: string | null; decided_by: string; result_commit: string }>();
    const tasks = taskRows.map((r) => ({
      id: String(r.id),
      yardId: yard.id,
      title: String(r.title),
      brief: String(r.brief),
      status: r.status as Task["status"],
      baseCommit: String(r.base_commit),
      createdAt: String(r.created_at),
      decidedAt: r.decided_at ? String(r.decided_at) : null,
    }));
    const claims = this.sql
      .exec<{ task_id: string; agent_id: string; pattern: string; created_at: string }>("SELECT * FROM claims ORDER BY created_at")
      .toArray()
      .map((r) => ({ taskId: r.task_id, agentId: r.agent_id, pattern: r.pattern, createdAt: r.created_at }));
    const overlaps = this.sql
      .exec<{ task_id: string; key: string; kind: string; path: string; agents: string; active: number; detected_at: string }>(
        "SELECT * FROM overlaps WHERE active = 1",
      )
      .toArray()
      .map((r) => ({
        key: r.key,
        taskId: r.task_id,
        kind: r.kind as Overlap["kind"],
        path: r.path,
        agents: JSON.parse(r.agents) as string[],
        active: true,
        detectedAt: r.detected_at,
      }));
    const rows = this.sql
      .exec<Record<string, string | number | null>>("SELECT * FROM events ORDER BY seq DESC LIMIT ?", recent)
      .toArray()
      .reverse();
    const sockets = this.ctx.getWebSockets();
    const infos = sockets.map((ws) => ws.deserializeAttachment() as SocketInfo | null);
    return {
      yard,
      head: this.head(),
      tasks,
      agents,
      claims,
      overlaps,
      recent: rows.map((r) => this.rowToEvent(r, yard.id)),
      connected: { ui: infos.filter((i) => i?.role === "ui").length, agents: infos.filter((i) => i?.role === "agent").length },
      reviews: {
        running: Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews_inflight").one().n),
        queued: Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews_pending").one().n),
      },
      pulse: this.pulse(),
      asks: await this.openAsks(),
      decisions: Object.fromEntries(
        decisionRows.map((d) => [d.task_id, { mode: d.mode, winnerAgentId: d.winner_agent_id, decidedBy: d.decided_by, resultCommit: d.result_commit }]),
      ),
      autopilot: Object.fromEntries(
        this.sql.exec<{ task_id: string; state: string }>("SELECT task_id, state FROM autopilot").toArray().map((r) => [r.task_id, r.state as AutopilotState]),
      ),
    };
  }

  /** The last two minutes from the event log: pushes per 5 s bucket, and per-minute rates. */
  private pulse(): YardStatus["pulse"] {
    const nowMs = Date.now();
    const since = new Date(nowMs - PULSE_WINDOW_MS).toISOString();
    const rows = this.sql
      .exec<{ ts: string; type: string }>("SELECT ts, type FROM events WHERE ts >= ? AND type IN ('push.received', 'review.completed', 'overlap.detected')", since)
      .toArray();
    const n = PULSE_WINDOW_MS / PULSE_BUCKET_MS;
    const buckets = new Array<number>(n).fill(0);
    const minuteAgo = nowMs - 60_000;
    let pushesPerMin = 0;
    let reviewsPerMin = 0;
    let overlapsPerMin = 0;
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (r.type === "push.received") {
        const i = n - 1 - Math.floor((nowMs - t) / PULSE_BUCKET_MS);
        if (i >= 0) buckets[i]!++;
        if (t >= minuteAgo) pushesPerMin++;
      } else if (t >= minuteAgo) {
        if (r.type === "review.completed") reviewsPerMin++;
        else overlapsPerMin++;
      }
    }
    return { buckets, bucketMs: PULSE_BUCKET_MS, pushesPerMin, reviewsPerMin, overlapsPerMin };
  }

  async describe(since = 0, limit = 50): Promise<string[]> {
    const yard = await this.yard();
    const agents = await listAgents(this.env.DB, yard.id);
    const name = (id: string | null) => agents.find((a) => a.id === id)?.name ?? id ?? "?";
    const { events } = await this.eventsSince(since, limit);
    return events.map((e) => `#${e.seq} ${describeEvent(e, name)}`);
  }

  // ── WebSockets (Hibernation API) ──────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const role = request.headers.get("X-Forkyard-Role") === "agent" ? "agent" : "ui";
    const agentId = request.headers.get("X-Forkyard-Agent");
    const taskId = request.headers.get("X-Forkyard-Task");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const tags = role === "ui" ? ["ui"] : [`agent:${taskId}/${agentId}`, `task:${taskId}`];
    this.ctx.acceptWebSocket(server, tags);
    const info: SocketInfo = { role, agentId, taskId };
    server.serializeAttachment(info);
    const yard = await this.yard();
    const hello: ServerMessage = { kind: "hello", yardId: yard.id, head: this.head(), role, agentId };
    server.send(JSON.stringify(hello));
    const since = Number(new URL(request.url).searchParams.get("since") ?? "NaN");
    if (Number.isFinite(since)) {
      const { events } = await this.eventsSince(since, 500, role === "agent" && taskId ? { taskId } : {});
      for (const event of events) server.send(JSON.stringify({ kind: "event", event } satisfies ServerMessage));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: { kind?: string; t?: number; since?: number };
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (msg.kind === "ping") ws.send(JSON.stringify({ kind: "pong", t: msg.t ?? Date.now() } satisfies ServerMessage));
    else if (msg.kind === "replay" && typeof msg.since === "number") {
      const info = ws.deserializeAttachment() as SocketInfo | null;
      const { events } = await this.eventsSince(msg.since, 500, info?.role === "agent" && info.taskId ? { taskId: info.taskId } : {});
      for (const event of events) ws.send(JSON.stringify({ kind: "event", event } satisfies ServerMessage));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private broadcast(msg: ServerMessage, taskId: string | null): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets("ui")) safeSend(ws, data);
    if (taskId) for (const ws of this.ctx.getWebSockets(`task:${taskId}`)) safeSend(ws, data);
    else
      for (const ws of this.ctx.getWebSockets()) {
        const info = ws.deserializeAttachment() as SocketInfo | null;
        if (info?.role === "agent") safeSend(ws, data);
      }
  }

  private sendToAgent(taskId: string, agentId: string, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(`agent:${taskId}/${agentId}`)) safeSend(ws, data);
  }

  // ── K2 spike: pull consumer on an alarm ───────────────────────────────────

  async startK2Poll(seconds: number): Promise<{ configured: boolean; until: number | null }> {
    if (!this.k2Configured()) return { configured: false, until: null };
    const until = Date.now() + Math.min(600, Math.max(5, seconds)) * 1000;
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('k2_until', ?)", String(until));
    await this.ctx.storage.setAlarm(Date.now() + 10);
    return { configured: true, until };
  }

  private k2Configured(): boolean {
    return !!(this.env.EVENTS_K2 && this.env.K2_STREAM_ID && this.env.K2_SUBSCRIPTION_ID && this.env.K2_API_TOKEN);
  }

  /** One alarm, two jobs: keep the review queue moving, and poll K2 while a spike window is open. */
  override async alarm(): Promise<void> {
    await this.drainReviews().catch((err) => console.error("review drain failed", err));
    await this.autopilotSweep().catch((err) => console.error("autopilot sweep failed", err));
    const until = Number(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'k2_until'").toArray()[0]?.v ?? 0);
    const k2 = this.k2Configured() && Date.now() <= until;
    if (k2) {
      try {
        await this.consumeK2Once();
      } catch (err) {
        console.warn("k2 consume failed", err);
      }
    }
    const reviewsWaiting = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews_pending").one().n) > 0;
    if (k2) await this.wakeAt(Date.now() + 250);
    else if (reviewsWaiting) await this.wakeAt(Date.now() + REVIEW_TICK_MS);
  }

  /** Bring the alarm forward to `t` if it isn't already due sooner. */
  private async wakeAt(t: number): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at <= Date.now() || at > t) await this.ctx.storage.setAlarm(t);
  }

  /** Make sure the alarm will look at the review queue soon. */
  private async scheduleReviewTick(): Promise<void> {
    await this.wakeAt(Date.now() + REVIEW_TICK_MS);
  }

  // ── asks: what needs a person ─────────────────────────────────────────────

  async openAsk(taskId: string | null, agentId: string | null, kind: AskKind, question: string, context: string | null, options: Ask["options"]): Promise<Ask> {
    const yard = await this.yard();
    const ask: Ask = {
      id: newId("ask_"),
      yardId: yard.id,
      taskId,
      agentId,
      kind,
      question,
      context,
      options,
      status: "open",
      answer: null,
      answeredBy: null,
      createdAt: now(),
      answeredAt: null,
    };
    await this.env.DB.prepare(
      "INSERT INTO asks (id, yard_id, task_id, agent_id, kind, question, context, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
    )
      .bind(ask.id, yard.id, taskId, agentId, kind, question, context, JSON.stringify(options), ask.createdAt)
      .run();
    await this.append({ type: "ask.opened", taskId, agentId, data: { ask } });
    return ask;
  }

  async answerAsk(id: string, answer: string, by: string): Promise<Ask> {
    const yard = await this.yard();
    const at = now();
    const res = await this.env.DB.prepare("UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE yard_id = ? AND id = ? AND status = 'open'")
      .bind(answer, by, at, yard.id, id)
      .run();
    const ask = await getAsk(this.env.DB, yard.id, id);
    if (!ask) throw new Error(`ask ${id} not found`);
    if (res.meta.changes) await this.append({ type: "ask.answered", taskId: ask.taskId, agentId: ask.agentId, data: { ask } });
    if (ask.taskId && this.autopilotOf(ask.taskId) === "waiting") await this.wakeAt(Date.now() + this.quietMs());
    return ask;
  }

  private async openAsks(taskId?: string): Promise<Ask[]> {
    const yard = await this.yard();
    const stmt = taskId
      ? this.env.DB.prepare("SELECT * FROM asks WHERE yard_id = ? AND task_id = ? AND status = 'open' ORDER BY created_at").bind(yard.id, taskId)
      : this.env.DB.prepare("SELECT * FROM asks WHERE yard_id = ? AND status = 'open' ORDER BY created_at LIMIT 200").bind(yard.id);
    return (await stmt.all()).results.map(askFromRow);
  }

  /** A decided or abandoned task has nothing left to ask about. */
  private async closeAsks(taskId: string, answer: string): Promise<void> {
    for (const ask of await this.openAsks(taskId)) await this.answerAsk(ask.id, answer, "forkyard");
  }

  // ── autopilot: merge the best fork once the agents settle ────────────────

  autopilotOf(taskId: string): AutopilotState {
    return (this.sql.exec<{ state: string }>("SELECT state FROM autopilot WHERE task_id = ?", taskId).toArray()[0]?.state as AutopilotState) ?? "off";
  }

  private setAutopilot(taskId: string, state: AutopilotState): void {
    this.sql.exec("INSERT OR REPLACE INTO autopilot (task_id, state, updated_at) VALUES (?, ?, ?)", taskId, state, Date.now());
  }

  /** A person took the decision over (or handed it back). */
  async setAutopilotFor(taskId: string, on: boolean): Promise<AutopilotState> {
    const cur = this.autopilotOf(taskId);
    if (cur === "merged") return cur;
    this.setAutopilot(taskId, on ? "waiting" : "off");
    if (on) await this.wakeAt(Date.now() + 100);
    return on ? "waiting" : "off";
  }

  private quietMs(): number {
    return Math.max(0, num(this.env.AUTOPILOT_QUIET_MS, 15_000));
  }

  /**
   * For every task on autopilot: once every agent has pushed and its newest head is
   * reviewed, nobody is waiting on a person, and the task has been quiet for a moment,
   * merge the best-scoring fork. Below the bar, or if the merge can't apply, hand the
   * decision to a person with the top candidates as one-click answers.
   */
  private async autopilotSweep(): Promise<void> {
    const waiting = this.sql.exec<{ task_id: string }>("SELECT task_id FROM autopilot WHERE state = 'waiting'").toArray();
    if (!waiting.length) return;
    const yard = await this.yard();
    const quiet = this.quietMs();
    const minScore = num(this.env.AUTOPILOT_MIN_SCORE, 60);
    for (const { task_id: taskId } of waiting) {
      const t = await this.env.DB.prepare("SELECT * FROM tasks WHERE yard_id = ? AND id = ?").bind(yard.id, taskId).first();
      if (!t || t.status !== "open") {
        this.setAutopilot(taskId, "off");
        continue;
      }
      const reviewing = Number(
        this.sql.exec<{ n: number }>(
          "SELECT (SELECT COUNT(*) FROM reviews_pending WHERE task_id = ?) + (SELECT COUNT(*) FROM reviews_inflight WHERE task_id = ?) AS n",
          taskId,
          taskId,
        ).one().n,
      );
      if (reviewing) continue; // onReview wakes us again
      const agents = (await listAgents(this.env.DB, yard.id, taskId)).filter((a) => a.status !== "failed" && a.status !== "retired");
      if (!agents.length || agents.some((a) => a.status !== "reviewed")) continue; // the next review wakes us again
      if ((await this.openAsks(taskId)).length) continue; // someone is waiting on a person
      const last = this.sql
        .exec<{ ts: string | null }>("SELECT MAX(ts) AS ts FROM events WHERE task_id = ? AND type IN ('push.received', 'intent.recorded', 'review.completed')", taskId)
        .one().ts;
      const settleAt = (last ? Date.parse(last) : 0) + quiet;
      if (settleAt > Date.now()) {
        await this.wakeAt(settleAt + 50);
        continue;
      }

      const reviews = await latestReviews(this.env.DB, yard.id, taskId);
      const ranked = agents
        .map((a) => ({ agent: a, review: reviews.get(a.id) }))
        .filter((x): x is { agent: Agent; review: Review } => !!x.review && x.review.commit === x.agent.headCommit)
        .sort((a, b) => b.review.score - a.review.score || a.agent.createdAt.localeCompare(b.agent.createdAt));
      const best = ranked[0];
      if (!best) continue;
      const task: Task = {
        id: taskId,
        yardId: yard.id,
        title: String(t.title),
        brief: String(t.brief),
        status: "open",
        baseCommit: String(t.base_commit),
        createdAt: String(t.created_at),
        decidedAt: null,
      };
      const options = [
        ...ranked.slice(0, 3).map((x) => ({ id: `merge:${x.agent.id}`, label: `Merge ${x.agent.name}'s fork (${x.review.score}/100)` })),
        { id: "abandon", label: "Abandon the task" },
      ];
      if (best.review.score < minScore) {
        this.setAutopilot(taskId, "handed");
        await this.openAsk(
          taskId,
          null,
          "decision",
          `No fork cleared the bar on “${task.title}”.`,
          `The best is ${best.agent.name} at ${best.review.score}/100; autopilot merges at ${minScore} or above. ${best.review.summary}`,
          options,
        );
        continue;
      }
      // Best first; a fork that can't apply (say the base moved under the files it changed)
      // gives way to the next one that clears the bar.
      const eligible = ranked.filter((x) => x.review.score >= minScore).slice(0, 5);
      let merged = false;
      let firstError: string | null = null;
      for (const [i, x] of eligible.entries()) {
        const next = eligible[i + 1] ?? ranked.find((r) => r !== x);
        try {
          const { decision } = await applyDecision(
            this.env,
            yard,
            task,
            {
              mode: "winner",
              winnerAgentId: x.agent.id,
              message: `${task.title}\n\nAutopilot: ${x.agent.name} scored ${x.review.score}/100${next ? `, ahead of ${next.agent.name} at ${next.review.score}` : ""}.`,
            },
            "autopilot",
          );
          await this.onDecision(decision);
          merged = true;
          break;
        } catch (err) {
          if (!(err instanceof DecideError)) console.error("autopilot merge failed", err);
          firstError ??= err instanceof DecideError ? err.message : String(err);
        }
      }
      if (merged) continue;
      this.setAutopilot(taskId, "handed");
      const baseMoved = !!firstError?.includes("base moved");
      await this.openAsk(
        taskId,
        null,
        "decision",
        baseMoved ? `“${task.title}” is based on an old version of ${yard.defaultBranch}.` : `Autopilot couldn't merge a fork on “${task.title}”.`,
        baseMoved
          ? `Since these agents started, other work changed the same files on ${yard.defaultBranch}, so none of the ${eligible.length} best forks applies cleanly. Starting over gives the agents the latest base.`
          : firstError,
        baseMoved
          ? [
              { id: "restart", label: "Start over from the latest base" },
              { id: "abandon", label: "Abandon the task" },
            ]
          : options,
      );
    }
  }

  private async consumeK2Once(): Promise<void> {
    const yard = await this.yard();
    const base = `https://${this.env.K2_STREAM_ID}.k2.cloudflarestorage.com/subscriptions/${this.env.K2_SUBSCRIPTION_ID}`;
    const headers = { Authorization: `Bearer ${this.env.K2_API_TOKEN}`, "Content-Type": "application/json" };
    const workerId = `yard-${yard.id}`;
    const res = await fetch(`${base}/consume`, { method: "POST", headers, body: JSON.stringify({ worker_id: workerId, max_records: 100 }) });
    if (!res.ok) throw new Error(`consume ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { batch_id?: string; records?: { timestamp_ms?: number; content: string }[] };
    const observedAt = Date.now();
    for (const r of body.records ?? []) {
      try {
        const event = JSON.parse(atob(r.content)) as YardEvent;
        if (event.yardId !== yard.id) continue;
        this.sql.exec(
          "INSERT INTO k2_samples (seq, type, latency_ms, observed_at) VALUES (?, ?, ?, ?)",
          event.seq,
          event.type,
          observedAt - Date.parse(event.ts),
          new Date(observedAt).toISOString(),
        );
      } catch {
        /* not ours */
      }
    }
    if (body.batch_id)
      await fetch(`${base}/batches/${body.batch_id}/ack`, { method: "POST", headers, body: JSON.stringify({ worker_id: workerId }) });
  }

  async latencyStats(): Promise<{
    k2: { configured: boolean; stats: ReturnType<typeof summarize>; samples: { seq: number; type: string; latencyMs: number }[] };
    live: { stats: ReturnType<typeof summarize> };
  }> {
    const k2 = this.sql
      .exec<{ seq: number; type: string; latency_ms: number }>("SELECT seq, type, latency_ms FROM k2_samples ORDER BY rowid DESC LIMIT 500")
      .toArray();
    const live = this.sql.exec<{ latency_ms: number }>("SELECT latency_ms FROM live_samples ORDER BY rowid DESC LIMIT 500").toArray();
    return {
      k2: {
        configured: this.k2Configured(),
        stats: summarize(k2.map((r) => r.latency_ms)),
        samples: k2.map((r) => ({ seq: r.seq, type: r.type, latencyMs: r.latency_ms })),
      },
      live: { stats: summarize(live.map((r) => r.latency_ms)) },
    };
  }
}

function safeSend(ws: WebSocket, data: string) {
  try {
    ws.send(data);
  } catch {
    /* socket closing */
  }
}

export function yardStub(env: Env, yard: Pick<YardRecord, "id" | "jurisdiction">) {
  const ns = yard.jurisdiction === "eu" ? env.YARD.jurisdiction("eu") : env.YARD;
  return ns.get(ns.idFromName(yard.id));
}

export async function yardStubById(env: Env, yardId: string) {
  const yard = await getYard(env.DB, yardId);
  if (!yard) return null;
  return { yard, stub: yardStub(env, yard) };
}
