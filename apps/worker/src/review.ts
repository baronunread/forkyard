import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  matchesGlob,
  parseForkName,
  parseIntentMarkdown,
  type ChangedFile,
  type Check,
  type Jurisdiction,
  type Review,
  type ReviewComment,
} from "@forkyard/shared";
import { disposeRepo, getArtifacts } from "./artifacts";
import * as chatgpt from "./chatgpt";
import { agentByForkName, getAgent, getTask, getYard, listIntents, newId, now } from "./db";
import { computeHunks, forkDiff, mapLimit, readPathAt, readText } from "./diff";
import type { Env } from "./env";
import { mirrorPreviewBranch } from "./preview";
import { yardStub } from "./yard";

/**
 * Review pipeline, one Workflow instance per push:
 *
 *   diff fork vs base → publish footprint (overlaps) → pick up intent →
 *   deterministic checks → review agent (Workers AI, optional) → persist.
 *
 * Accepts either Forkyard params (when started by the Queue consumer) or a
 * raw `cf.artifacts.repo.pushed` event (when wired directly with a Wrangler
 * `triggers.events` → workflow target).
 */

export interface ReviewParams {
  kind: "forkyard";
  yardId: string;
  taskId: string;
  agentId: string;
  forkName: string;
  commit: string;
  baseCommit: string;
  jurisdiction: Jurisdiction;
}

export interface ArtifactsPushEvent {
  type: string;
  source: { type?: string; namespace?: string; repoName: string };
  payload: { ref: string; before?: string; after: string; commits?: { id: string; message: string; timestamp?: string }[] };
  metadata?: { emittedAt?: string };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["API key", /\b(?:sk|rk)-[A-Za-z0-9]{32,}\b/],
  ["Cloudflare/Artifacts token", /\bart_(?:v1|local)_[A-Za-z0-9._-]{20,}/],
];

interface Analysis {
  checks: Check[];
  comments: ReviewComment[];
  excerpt: string;
  testsTouched: number;
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams | ArtifactsPushEvent> {
  override async run(event: Readonly<WorkflowEvent<ReviewParams | ArtifactsPushEvent>>, step: WorkflowStep) {
    let params: ReviewParams | null;
    const payload = event.payload;
    if ("kind" in payload && payload.kind === "forkyard") params = payload;
    else {
      params = await step.do("route artifacts event", async () => routeArtifactsEvent(this.env, payload as ArtifactsPushEvent, "workflow", false));
      if (!params) return { skipped: "not a Forkyard fork" };
    }
    const p = params;
    try {
      return await this.review(p, step);
    } catch (err) {
      // Give the yard its review slot back so queued reviews keep moving.
      await step.do("release review slot", async () => {
        await yardStub(this.env, { id: p.yardId, jurisdiction: p.jurisdiction }).reviewFailed(p.taskId, p.agentId, p.commit);
      });
      throw err;
    }
  }

  private async review(p: ReviewParams, step: WorkflowStep) {
    const files = await step.do("diff fork vs base", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, async () => {
      const repo = await getArtifacts(this.env, p.jurisdiction).get(p.forkName);
      try {
        const files = await forkDiff(repo, p.baseCommit, p.commit);
        await this.env.DB.prepare(
          "INSERT OR REPLACE INTO diffs (yard_id, task_id, agent_id, commit_hash, base_commit, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(p.yardId, p.taskId, p.agentId, p.commit, p.baseCommit, JSON.stringify(files), now())
          .run();
        return files;
      } finally {
        disposeRepo(repo);
      }
    });

    await step.do("publish footprint", async () => {
      await yardStub(this.env, { id: p.yardId, jurisdiction: p.jurisdiction }).onDiff(p.taskId, p.agentId, p.commit, files);
      return true;
    });

    await step.do("mirror preview branch", { retries: { limit: 2, delay: "2 seconds" } }, async () => {
      // Only yards wired to Workers Builds (they set a preview URL template) get preview branches.
      const yard = await getYard(this.env.DB, p.yardId);
      const agent = await getAgent(this.env.DB, p.yardId, p.taskId, p.agentId);
      if (!yard?.previewUrlTemplate || !agent || agent.headCommit !== p.commit) return null;
      return mirrorPreviewBranch(this.env, yard, agent, p.baseCommit, p.commit);
    });

    const intent = await step.do("pick up intent", async () => {
      const intents = await listIntents(this.env.DB, p.yardId, p.taskId, p.agentId);
      const attached = intents.find((i) => i.commit === p.commit) ?? intents[intents.length - 1];
      // Intents travel with the code too: read .forkyard/intent.md from the pushed commit.
      const repo = await getArtifacts(this.env, p.jurisdiction).get(p.forkName);
      try {
        const md = await readPathAt(repo, p.commit, ".forkyard/intent.md");
        const parsed = md.text ? parseIntentMarkdown(md.text) : null;
        if (parsed && (!attached || attached.summary !== parsed.summary)) {
          const rec = await yardStub(this.env, { id: p.yardId, jurisdiction: p.jurisdiction }).recordIntent(
            p.taskId,
            p.agentId,
            { summary: parsed.summary, why: parsed.why, details: parsed.details ?? undefined },
            "git",
            p.commit,
          );
          return { summary: rec.summary, why: rec.why };
        }
      } finally {
        disposeRepo(repo);
      }
      return attached ? { summary: attached.summary, why: attached.why } : null;
    });

    const analysis = await step.do("checks", async () => analyze(this.env, p, files, intent !== null));

    const res = await step.do(
      "review agent",
      { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => aiReview(this.env, p, files, intent, analysis),
    );
    const ai = "skipped" in res ? null : res;

    return step.do("persist review", async () => {
      const heuristic = heuristicScore(analysis, intent !== null, files);
      const failed = analysis.checks.some((c) => c.status === "fail");
      let score = ai ? Math.round(0.6 * ai.score + 0.4 * heuristic) : heuristic;
      if (failed) score = Math.min(score, 40);
      const review: Review = {
        id: newId("rv_"),
        agentId: p.agentId,
        taskId: p.taskId,
        commit: p.commit,
        score,
        summary: ai?.summary ?? summarizeChecks(analysis.checks, files),
        checks: analysis.checks,
        comments: [...analysis.comments, ...(ai?.comments ?? [])].slice(0, 30),
        // Say why the model didn't weigh in, so a fallback is never silent.
        reviewer: ai ? `${ai.model} + checks` : `checks (heuristic${"skipped" in res ? `: ${res.skipped}` : ""})`,
        createdAt: now(),
      };
      await this.env.DB.prepare(
        "INSERT INTO reviews (id, yard_id, task_id, agent_id, commit_hash, score, summary, checks, comments, reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(review.id, p.yardId, p.taskId, p.agentId, p.commit, review.score, review.summary, JSON.stringify(review.checks), JSON.stringify(review.comments), review.reviewer, review.createdAt)
        .run();
      await yardStub(this.env, { id: p.yardId, jurisdiction: p.jurisdiction }).onReview(review);
      return { reviewId: review.id, score: review.score };
    });
  }
}

/** Map an Artifacts push event to the agent that owns the fork and notify its yard. */
export async function routeArtifactsEvent(
  env: Env,
  ev: ArtifactsPushEvent,
  transport: "queue" | "workflow" | "local",
  startReview: boolean,
): Promise<ReviewParams | null> {
  if (ev.type !== "cf.artifacts.repo.pushed") return null;
  const repoName = ev.source.repoName;
  if (!parseForkName(repoName)) return null;
  const agent = await agentByForkName(env.DB, repoName);
  if (!agent) return null;
  const yard = await getYard(env.DB, agent.yardId);
  const task = await getTask(env.DB, agent.yardId, agent.taskId);
  if (!yard || !task) return null;
  const head = ev.payload.commits?.find((c) => c.id === ev.payload.after) ?? ev.payload.commits?.[0];
  await yardStub(env, yard).onPush(agent, {
    repoName,
    ref: ev.payload.ref,
    before: ev.payload.before ?? null,
    after: ev.payload.after,
    message: head?.message ?? null,
    pushedAt: head?.timestamp ?? null,
    transport,
    emittedAt: ev.metadata?.emittedAt ?? null,
    startReview,
  });
  if (ev.payload.ref !== `refs/heads/${yard.defaultBranch}`) return null;
  return {
    kind: "forkyard",
    yardId: yard.id,
    taskId: task.id,
    agentId: agent.id,
    forkName: agent.forkName,
    commit: ev.payload.after,
    baseCommit: task.baseCommit,
    jurisdiction: yard.jurisdiction,
  };
}

async function analyze(env: Env, p: ReviewParams, files: ChangedFile[], hasIntent: boolean): Promise<Analysis> {
  const checks: Check[] = [];
  const comments: ReviewComment[] = [];
  const repo = await getArtifacts(env, p.jurisdiction).get(p.forkName);
  const excerptParts: string[] = [];
  const conflictHits: string[] = [];
  const secretHits: string[] = [];
  const debugHits: string[] = [];
  try {
    await mapLimit(
      files.filter((f) => !f.binary).slice(0, 80),
      6,
      async (f) => {
        const [o, n] = await Promise.all([readText(repo, f.oldHash), readText(repo, f.newHash)]);
        if (o.text === null || n.text === null) return;
        const hunks = computeHunks(f.path, o.text, n.text);
        for (const h of hunks) {
          let line = h.newStart;
          for (const l of h.lines) {
            if (!l.startsWith("+")) continue;
            const text = l.slice(1);
            if (/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(text)) {
              conflictHits.push(`${f.path}:${line}`);
              comments.push({ path: f.path, line, body: "Unresolved merge conflict marker." });
            }
            for (const [label, re] of SECRET_PATTERNS)
              if (re.test(text)) {
                secretHits.push(`${f.path}:${line} (${label})`);
                comments.push({ path: f.path, line, body: `Looks like a ${label}. Never commit secrets.` });
              }
            if (/\bconsole\.log\(|\bdebugger\b|\bprint\(\s*["']debug/i.test(text) && !/test|spec/.test(f.path))
              debugHits.push(`${f.path}:${line}`);
            line++;
          }
        }
        if (excerptParts.join("\n").length < 12000)
          excerptParts.push(`--- ${f.path} (${f.status})\n${hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]).join("\n").slice(0, 3000)}`);
      },
    );
  } finally {
    disposeRepo(repo);
  }

  checks.push(
    hasIntent
      ? { name: "intent", status: "pass", detail: "Intent recorded for this work." }
      : { name: "intent", status: "warn", detail: "No intent recorded. Call intent_record or commit .forkyard/intent.md." },
  );
  checks.push(
    conflictHits.length
      ? { name: "conflict markers", status: "fail", detail: conflictHits.slice(0, 5).join(", ") }
      : { name: "conflict markers", status: "pass", detail: "None." },
  );
  checks.push(
    secretHits.length
      ? { name: "secrets", status: "fail", detail: secretHits.slice(0, 5).join(", ") }
      : { name: "secrets", status: "pass", detail: "No secret-shaped strings added." },
  );

  const stub = yardStub(env, { id: p.yardId, jurisdiction: p.jurisdiction });
  const status = await stub.status(0);
  const myClaims = status.claims.filter((c) => c.taskId === p.taskId && c.agentId === p.agentId).map((c) => c.pattern);
  if (myClaims.length) {
    const outside = files.filter((f) => !myClaims.some((c) => matchesGlob(f.path, c))).map((f) => f.path);
    checks.push(
      outside.length
        ? { name: "scope", status: "warn", detail: `Changed outside claims: ${outside.slice(0, 8).join(", ")}${outside.length > 8 ? "…" : ""}` }
        : { name: "scope", status: "pass", detail: "All changes are inside claimed paths." },
    );
  } else checks.push({ name: "scope", status: "warn", detail: "No paths claimed; overlaps could not be predicted." });

  const mineOverlaps = status.overlaps.filter((o) => o.taskId === p.taskId && o.agents.includes(p.agentId));
  checks.push(
    mineOverlaps.length
      ? { name: "overlaps", status: "warn", detail: mineOverlaps.map((o) => `${o.path} (${o.agents.filter((a) => a !== p.agentId).join(", ")})`).join("; ") }
      : { name: "overlaps", status: "pass", detail: "No overlaps with other agents." },
  );

  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  checks.push(
    files.length > 50 || lines > 2000
      ? { name: "size", status: "warn", detail: `${files.length} files, ${lines} lines changed — hard to review.` }
      : { name: "size", status: "pass", detail: `${files.length} files, ${lines} lines changed.` },
  );
  if (files.some((f) => f.binary && f.status !== "deleted"))
    checks.push({ name: "binary files", status: "warn", detail: files.filter((f) => f.binary).map((f) => f.path).slice(0, 5).join(", ") });
  checks.push(
    debugHits.length
      ? { name: "debug leftovers", status: "warn", detail: debugHits.slice(0, 5).join(", ") }
      : { name: "debug leftovers", status: "pass", detail: "None." },
  );
  const testsTouched = files.filter((f) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/.test(f.path)).length;
  checks.push(
    testsTouched
      ? { name: "tests", status: "pass", detail: `${testsTouched} test file(s) changed.` }
      : { name: "tests", status: "warn", detail: "No tests changed." },
  );
  return { checks, comments: comments.slice(0, 20), excerpt: excerptParts.join("\n\n").slice(0, 16000), testsTouched };
}

function heuristicScore(a: Analysis, hasIntent: boolean, files: ChangedFile[]): number {
  let score = 72;
  if (hasIntent) score += 8;
  for (const c of a.checks) {
    if (c.status === "fail") score -= 30;
    else if (c.status === "warn" && c.name !== "tests" && c.name !== "intent") score -= 6;
  }
  score += Math.min(10, a.testsTouched * 5);
  if (files.length === 0) score = 10;
  return Math.max(0, Math.min(100, score));
}

function summarizeChecks(checks: Check[], files: ChangedFile[]): string {
  const fails = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const warns = checks.filter((c) => c.status === "warn").map((c) => c.name);
  const size = `${files.length} file(s), +${files.reduce((n, f) => n + f.additions, 0)} −${files.reduce((n, f) => n + f.deletions, 0)}`;
  if (fails.length) return `${size}; failing: ${fails.join(", ")}.`;
  if (warns.length) return `${size}; warnings: ${warns.join(", ")}.`;
  return `${size}; all checks pass.`;
}

async function aiReview(
  env: Env,
  p: ReviewParams,
  files: ChangedFile[],
  intent: { summary: string; why: string } | null,
  a: Analysis,
): Promise<{ score: number; summary: string; comments: ReviewComment[]; model: string } | { skipped: string }> {
  if (files.length === 0) return { skipped: "no files" };
  const ask = await env.DB.prepare("SELECT t.review, (SELECT COUNT(*) FROM agents a WHERE a.yard_id = t.yard_id AND a.task_id = t.id AND a.role = 'agent') AS n FROM tasks t WHERE t.yard_id = ? AND t.id = ?")
    .bind(p.yardId, p.taskId)
    .first<{ review: number; n: number }>();
  if (ask && ask.n < 2 && !ask.review) return { skipped: "one agent, no review asked" };
  // The yard owner's own ChatGPT plan reviews; without one, the checks alone score the fork.
  const owner = await chatgpt.yardReviewer(env, p.yardId);
  if (!owner) return { skipped: "no ChatGPT plan to review with" };
  const task = await getTask(env.DB, p.yardId, p.taskId);
  const agent = await getAgent(env.DB, p.yardId, p.taskId, p.agentId);
  const prompt = [
    `Task: ${task?.title}\n${task?.brief ?? ""}`,
    `Agent: ${agent?.name} (${agent?.harness})`,
    intent ? `Agent's intent: ${intent.summary}\nWhy: ${intent.why}` : "Agent recorded no intent.",
    `Automated checks:\n${a.checks.map((c) => `- ${c.name}: ${c.status} — ${c.detail}`).join("\n")}`,
    `Diff (context-free hunks, truncated):\n${a.excerpt}`,
  ].join("\n\n");
  const system =
    'You review one agent\'s fork for a task that several agents attempted in parallel. Judge correctness, scope discipline, and whether the change does what the task asks. Reply with JSON only: {"score": 0-100, "summary": "<= 2 sentences", "comments": [{"path": string|null, "line": number|null, "body": string}]}';

  let raw: string;
  let model: string;
  try {
    const r = await chatgpt.complete(env, owner, system, prompt);
    raw = r.text;
    model = `chatgpt:${r.model}`;
  } catch (err) {
    return { skipped: `ChatGPT failed: ${String(err).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 160)}` };
  }
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) {
    console.warn("review answer has no JSON", model, raw.slice(0, 200));
    return { skipped: raw ? "the model's answer had no JSON" : "the model's answer was empty" };
  }
  try {
    const parsed = JSON.parse(json) as { score?: number; summary?: string; comments?: ReviewComment[] };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (!Number.isFinite(score)) return { skipped: "the model gave no score" };
    return {
      score,
      summary: String(parsed.summary ?? "").slice(0, 400) || "Reviewed.",
      comments: (parsed.comments ?? []).slice(0, 10).map((c) => ({ path: c.path ?? null, line: typeof c.line === "number" ? c.line : null, body: String(c.body).slice(0, 500) })),
      model,
    };
  } catch {
    return { skipped: "the model's JSON didn't parse" };
  }
}
