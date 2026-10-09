import {
  applyHunks,
  splitLines,
  type TaggedHunk,
  type Agent,
  type AssembledFile,
  type DecideConflict,
  type DecideInput,
  type DecidePreview,
  type Decision,
  type Task,
  type Yard,
} from "@forkyard/shared";
import { disposeRepo, getArtifacts, treeReader, type Repo } from "./artifacts";
import { listAgents, newId, now } from "./db";
import { commitTree, computeHunks, forkDiff, IGNORED_PREFIXES, mapLimit, MAX_FILES, readPathAt, treeChanges } from "./diff";
import type { Env } from "./env";
import { buildCommit, type FileChange } from "./git/build";
import { utf8 } from "./git/objects";

/**
 * Deciding a task: either one fork wins whole, or hunks from several forks
 * are assembled onto the task's base. Preview is pure (no writes); apply
 * builds a commit with the Forkyard writer and moves the base branch with a
 * compare-and-swap, so a concurrent decision can never be overwritten.
 */

export class DecideError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

interface Ctx {
  env: Env;
  yard: Yard;
  task: Task;
  agents: Map<string, Agent>;
  repos: Map<string, Repo>;
}

async function repoFor(ctx: Ctx, agentId: string): Promise<Repo> {
  const cached = ctx.repos.get(agentId);
  if (cached) return cached;
  const agent = ctx.agents.get(agentId);
  if (!agent) throw new DecideError(`unknown agent ${agentId}`);
  if (!agent.headCommit) throw new DecideError(`${agent.name} has not pushed anything yet`);
  const repo = await getArtifacts(ctx.env, ctx.yard.jurisdiction).get(agent.forkName);
  ctx.repos.set(agentId, repo);
  return repo;
}

export async function previewDecision(env: Env, yard: Yard, task: Task, input: DecideInput): Promise<DecidePreview> {
  const agents = new Map((await listAgents(env.DB, yard.id, task.id)).map((a) => [a.id, a]));
  const ctx: Ctx = { env, yard, task, agents, repos: new Map() };
  try {
    return await preview(ctx, input);
  } finally {
    for (const r of ctx.repos.values()) disposeRepo(r);
  }
}

async function preview(ctx: Ctx, input: DecideInput): Promise<DecidePreview> {
  const files: AssembledFile[] = [];
  const conflicts: DecideConflict[] = [];

  if (input.mode === "winner") {
    const repo = await repoFor(ctx, input.winnerAgentId);
    const head = ctx.agents.get(input.winnerAgentId)!.headCommit!;
    const changed = await forkDiff(repo, ctx.task.baseCommit, head);
    if (changed.length >= MAX_FILES) throw new DecideError(`the fork changes ${MAX_FILES}+ files; Forkyard merges at most ${MAX_FILES - 1} at once`, 409);
    // The winner's files go in as they are: same bytes, same mode (scripts stay executable, symlinks stay links).
    const out = changed.map((f): AssembledFile => {
      const from = [input.winnerAgentId];
      if (f.status === "deleted") return { path: f.path, status: "deleted", contents: null, fromAgents: from };
      return { path: f.path, status: f.status, contents: "", fromAgents: from, mode: f.mode, blob: f.newHash! };
    });
    await mapLimit(out, 8, async (f) => {
      if (!f.blob || changed.find((c) => c.path === f.path)!.binary) return;
      f.contents = (await readPathAt(repo, head, f.path)).text ?? "";
    });
    files.push(...out);
    return { taskId: ctx.task.id, baseCommit: ctx.task.baseCommit, files, conflicts };
  }

  // Assemble: group selections by path.
  const byPath = new Map<string, { agentId: string; hunkIds?: string[] }[]>();
  for (const s of input.selections) {
    if (IGNORED_PREFIXES.some((p) => s.path.startsWith(p))) continue;
    const list = byPath.get(s.path) ?? [];
    list.push({ agentId: s.agentId, hunkIds: s.hunkIds });
    byPath.set(s.path, list);
  }
  const baseRepo = await getArtifacts(ctx.env, ctx.yard.jurisdiction).get(ctx.yard.baseRepo);
  try {
    for (const [path, sels] of byPath) {
      const base = await readPathAt(baseRepo, ctx.task.baseCommit, path);
      if (base.binary) throw new DecideError(`${path} is binary in base`);
      const versions = await Promise.all(
        sels.map(async (s) => {
          const repo = await repoFor(ctx, s.agentId);
          const v = await readPathAt(repo, ctx.agents.get(s.agentId)!.headCommit!, path);
          if (v.binary) throw new DecideError(`${path} is binary in ${s.agentId}'s fork`);
          return { ...s, exists: v.exists, text: v.text };
        }),
      );
      const whole = versions.filter((v) => !v.hunkIds);
      if (whole.length) {
        const distinct = new Set(whole.map((v) => (v.exists ? v.text : "\u0000deleted")));
        if (distinct.size > 1 || versions.length > whole.length) {
          conflicts.push({ path, detail: "different whole-file versions selected", agents: versions.map((v) => v.agentId) });
          continue;
        }
        const v = whole[0]!;
        files.push({
          path,
          status: !v.exists ? "deleted" : base.exists ? "modified" : "added",
          contents: v.exists ? (v.text ?? "") : null,
          fromAgents: whole.map((w) => w.agentId),
        });
        continue;
      }
      const tagged = versions.flatMap((v) => {
        const hunks = computeHunks(path, base.text ?? "", v.exists ? (v.text ?? "") : "");
        const want = new Set(v.hunkIds);
        const picked = hunks.filter((h) => want.has(h.id));
        const missing = [...want].filter((id) => !hunks.some((h) => h.id === id));
        if (missing.length) conflicts.push({ path, detail: `hunk(s) ${missing.join(", ")} no longer exist in ${v.agentId}'s fork`, agents: [v.agentId] });
        return picked.map((hunk) => ({ agentId: v.agentId, hunk }));
      });
      const res = applyHunks(base.text ?? "", tagged);
      for (const c of res.conflicts)
        conflicts.push({ path, detail: `hunks overlap at base line ${c.a.hunk.oldStart}`, agents: [c.a.agentId, c.b.agentId] });
      const fromAgents = [...new Set(tagged.map((t) => t.agentId))];
      const lineAgents = fromAgents.length > 1 && res.text ? attributeLines(path, base.text ?? "", res.text, tagged) : undefined;
      const deletedAll = !base.exists ? false : res.text === "" && versions.every((v) => !v.exists);
      files.push({
        path,
        status: deletedAll ? "deleted" : base.exists ? "modified" : "added",
        contents: deletedAll ? null : res.text,
        fromAgents,
        ...(lineAgents && !deletedAll ? { lineAgents } : {}),
      });
    }
  } finally {
    disposeRepo(baseRepo);
  }
  return { taskId: ctx.task.id, baseCommit: ctx.task.baseCommit, files: files.sort((a, b) => a.path.localeCompare(b.path)), conflicts };
}

export async function applyDecision(
  env: Env,
  yard: Yard,
  task: Task,
  input: DecideInput,
  decidedBy: string,
): Promise<{ decision: Decision; preview: DecidePreview }> {
  if (task.status !== "open") throw new DecideError(`task is already ${task.status}`, 409);
  const p = await previewDecision(env, yard, task, input);
  if (p.conflicts.length) throw new DecideError(`cannot apply: ${p.conflicts.length} conflict(s): ${p.conflicts.map((c) => `${c.path}: ${c.detail}`).join("; ")}`, 409);
  if (p.files.length === 0) throw new DecideError("nothing to apply: the selection changes no files");

  const artifacts = getArtifacts(env, yard.jurisdiction);
  const base = await artifacts.get(yard.baseRepo);
  try {
    const [head] = await base.log({ ref: yard.defaultBranch, limit: 1 });
    if (!head) throw new DecideError("base repo has no commits", 409);
    // If the base moved since the task started, refuse when any decided file also changed there.
    if (head.hash !== task.baseCommit) {
      const moved = await treeChanges(base, await commitTree(base, task.baseCommit), head.treeHash);
      const touched = new Set(p.files.map((f) => f.path));
      const clash = moved.filter((m) => touched.has(m.path)).map((m) => m.path);
      if (clash.length)
        throw new DecideError(`base moved since this task started and also changed ${clash.join(", ")}; start a follow-up task from the new base`, 409);
    }
    const agents = await listAgents(env.DB, yard.id, task.id);
    const winner = input.mode === "winner" ? agents.find((a) => a.id === input.winnerAgentId) : undefined;
    const fork = winner && p.files.some((f) => f.blob) ? await artifacts.get(winner.forkName) : null;
    const changes = new Map<string, FileChange>();
    try {
      await mapLimit(p.files, 8, async (f) => {
        if (f.contents === null) return void changes.set(f.path, null);
        const blob = f.blob && fork ? await fork.readBlob(f.blob) : null;
        if (f.blob && !blob) throw new DecideError(`${f.path} is missing from the winner's fork`, 409);
        changes.set(f.path, { contents: blob ? new Uint8Array(await blob.arrayBuffer()) : utf8(f.contents), mode: f.mode });
      });
    } finally {
      if (fork) disposeRepo(fork);
    }
    const involved = agents.filter((a) => p.files.some((f) => f.fromAgents.includes(a.id)));
    const how =
      input.mode === "winner"
        ? `Winner: ${agents.find((a) => a.id === input.winnerAgentId)?.name ?? input.winnerAgentId}`
        : `Assembled from ${involved.map((a) => a.name).join(", ")}`;
    const message = [
      input.message?.trim() || `${task.title}`,
      "",
      `Forkyard decision for task ${task.id}. ${how}.`,
      `Files: ${p.files.map((f) => f.path).join(", ")}`,
      "",
      ...involved.map((a) => `Co-authored-by: ${a.name} (${a.harness}) <${a.id}@agents.forkyard.dev>`),
    ].join("\n");
    const built = await buildCommit({
      reader: treeReader(base),
      baseTree: head.treeHash,
      parents: [head.hash],
      changes,
      message,
      author: { name: "Forkyard", email: "decisions@forkyard.dev" },
    });
    await artifacts.writeCommit(yard.baseRepo, built, `refs/heads/${yard.defaultBranch}`, head.hash);
    const decision: Decision = {
      id: newId("dc_"),
      taskId: task.id,
      mode: input.mode,
      winnerAgentId: input.mode === "winner" ? input.winnerAgentId : null,
      selections: input.mode === "assemble" ? input.selections : [],
      resultCommit: built.commit,
      decidedBy,
      createdAt: now(),
    };
    await env.DB.prepare(
      "INSERT INTO decisions (id, yard_id, task_id, mode, winner_agent_id, selections, result_commit, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(decision.id, yard.id, task.id, decision.mode, decision.winnerAgentId, JSON.stringify(decision.selections), decision.resultCommit, decidedBy, decision.createdAt)
      .run();
    // Keep who wrote which line of multi-agent files: the forks that know it get cleaned up.
    const mixed = p.files.filter((f) => f.lineAgents);
    if (mixed.length)
      await env.DB.batch(
        mixed.map((f) =>
          env.DB.prepare("INSERT OR REPLACE INTO line_agents (yard_id, commit_hash, path, agents) VALUES (?, ?, ?, ?)").bind(yard.id, built.commit, f.path, JSON.stringify(f.lineAgents)),
        ),
      );
    return { decision, preview: p };
  } finally {
    disposeRepo(base);
  }
}

/**
 * Who wrote each line of an assembled file: a line the merge added (relative to the base) goes to
 * the agent whose selected hunk added that exact text; unchanged lines are null.
 */
export function attributeLines(path: string, base: string, result: string, tagged: TaggedHunk[]): (string | null)[] {
  const byText = new Map<string, string>();
  for (const t of tagged) for (const l of t.hunk.lines) if (l.startsWith("+") && !byText.has(l.slice(1))) byText.set(l.slice(1), t.agentId);
  const lines = splitLines(result);
  const out: (string | null)[] = lines.map(() => null);
  for (const h of computeHunks(path, base, result)) {
    const start = Math.max(0, h.newStart - 1);
    for (let i = start; i < start + h.newLines; i++) out[i] = byText.get(lines[i]!) ?? null;
  }
  return out;
}
