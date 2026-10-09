import { blobText, disposeRepo, getArtifacts, type CommitMeta, type Repo } from "./artifacts";
import { assertYard, type Principal } from "./auth";
import { getYard } from "./db";
import { previousLine } from "@forkyard/shared";
import { computeHunks, MAX_TEXT_BYTES, treeChanges } from "./diff";
import type { Env } from "./env";
import { ServiceError } from "./service";

/**
 * The yard's code as people read it: folders, files and the log of the base repo, where each
 * change says which task (and which agents) made it instead of only a commit message.
 */

/** A change on the base: a commit, and the task whose decision made it when there is one. */
export interface Change {
  commit: string;
  message: string;
  author: string;
  at: string;
  task: { id: string; title: string; mode: string } | null;
  agents: string[];
}

export interface CodeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  /** Git mode: "100755" executable, "120000" symlink. */
  mode: string;
  last: Change | null;
}

const LOG_DEPTH = 40;

async function openBase<T>(env: Env, p: Principal, yardId: string, fn: (repo: Repo, ref: string) => Promise<T>): Promise<T> {
  await assertYard(env, p, yardId);
  const yard = await getYard(env.DB, yardId);
  if (!yard) throw new ServiceError(404, `yard ${yardId} not found`);
  const repo = await getArtifacts(env, yard.jurisdiction).get(yard.baseRepo);
  try {
    return await fn(repo, yard.defaultBranch);
  } finally {
    disposeRepo(repo);
  }
}

/** Commits on the base, newest first, each joined to the task decision that produced it. */
async function changes(env: Env, yardId: string, repo: Repo, ref: string, limit = LOG_DEPTH): Promise<(Change & { meta: CommitMeta })[]> {
  const log = await repo.log({ ref, limit });
  const { results } = await env.DB.prepare(
    `SELECT d.result_commit, d.task_id, d.mode, t.title FROM decisions d JOIN tasks t ON t.yard_id = d.yard_id AND t.id = d.task_id WHERE d.yard_id = ?`,
  )
    .bind(yardId)
    .all<{ result_commit: string; task_id: string; mode: string; title: string }>();
  const byCommit = new Map(results.map((r) => [r.result_commit, r]));
  return log.map((c) => {
    const d = byCommit.get(c.hash);
    return {
      meta: c,
      commit: c.hash,
      message: c.message,
      author: c.author.name,
      at: new Date(c.authoredAt * 1000).toISOString(),
      task: d ? { id: d.task_id, title: d.title, mode: d.mode } : null,
      // Decision commits credit their agents: "Co-authored-by: Ada (pi) <…>".
      agents: [...c.message.matchAll(/^Co-authored-by: (.+?) \(/gm)].map((m) => m[1]!),
    };
  });
}

/** Walk the log newest first and give each path the newest change that touched it (or anything under it). */
async function lastTouched(repo: Repo, log: (Change & { meta: CommitMeta })[], paths: string[]): Promise<Map<string, Change>> {
  const out = new Map<string, Change>();
  const pending = new Set(paths);
  for (let i = 0; i < log.length && pending.size; i++) {
    const c = log[i]!;
    const first = c.meta.parents[0];
    const next = log[i + 1]?.meta;
    const parent = !first ? null : next?.hash === first ? next : await repo.readCommit(first);
    // ponytail: a shallow import's oldest commit diffs against nothing (reads the whole tree once).
    const touched = (await treeChanges(repo, parent?.treeHash ?? null, c.meta.treeHash)).map((t) => t.path);
    for (const p of [...pending])
      if (touched.some((t) => t === p || t.startsWith(`${p}/`))) {
        const { meta: _m, ...change } = c;
        out.set(p, change);
        pending.delete(p);
      }
  }
  return out;
}

/** The tree hash at `path` in a commit, or null when there's no folder there. */
async function treeAt(repo: Repo, rootTree: string, path: string): Promise<string | null> {
  let hash = rootTree;
  for (const seg of path.split("/").filter(Boolean)) {
    const e = (await repo.readTree(hash))?.find((x) => x.name === seg);
    if (!e || e.type !== "tree") return null;
    hash = e.hash;
  }
  return hash;
}

const README = /^readme(\.(md|markdown|txt))?$/i;

/** A folder of the base: its entries (folders first), the change that last touched each, and its README. */
export async function codeTree(env: Env, p: Principal, yardId: string, path: string) {
  return openBase(env, p, yardId, async (repo, ref) => {
    const log = await changes(env, yardId, repo, ref);
    const head = log[0];
    if (!head) return { path, entries: [] as CodeEntry[], readme: null, head: null, here: null, commits: 0 };
    const tree = await treeAt(repo, head.meta.treeHash, path);
    if (!tree) throw new ServiceError(404, `no folder ${path} on ${ref}`);
    const raw = (await repo.readTree(tree)) ?? [];
    const prefix = path ? `${path.replace(/\/$/, "")}/` : "";
    const entries = raw
      .filter((e) => e.type !== "gitlink")
      .map((e) => ({ name: e.name, path: prefix + e.name, type: e.type === "tree" ? ("tree" as const) : ("blob" as const), mode: e.mode }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
    const last = await lastTouched(repo, log, [...entries.map((e) => e.path), ...(path ? [path] : [])]);
    const readmeEntry = raw.find((e) => e.type !== "tree" && README.test(e.name));
    const readmeBlob = readmeEntry ? await repo.readBlob(readmeEntry.hash) : null;
    const readme = readmeBlob && readmeBlob.size <= MAX_TEXT_BYTES ? { name: readmeEntry!.name, text: (await blobText(readmeBlob)).text } : null;
    const { meta: _m, ...headChange } = head;
    // The folder's own latest change (the repo's, at the root).
    const here = path ? (last.get(path) ?? null) : headChange;
    return { path, entries: entries.map((e) => ({ ...e, last: last.get(e.path) ?? null })), readme, head: headChange, here, commits: log.length };
  });
}

/** One file of the base, with the change that last touched it. */
export async function codeFile(env: Env, p: Principal, yardId: string, path: string) {
  return openBase(env, p, yardId, async (repo, ref) => {
    const blob = await repo.readFile({ ref, path });
    if (!blob) throw new ServiceError(404, `no file ${path} on ${ref}`);
    const log = await changes(env, yardId, repo, ref);
    const last = (await lastTouched(repo, log, [path])).get(path) ?? null;
    if (blob.size > MAX_TEXT_BYTES) return { path, size: blob.size, text: null, binary: true, last };
    const r = await blobText(blob);
    return { path, size: blob.size, text: r.text, binary: r.binary, last };
  });
}

/** The base's log: newest first, each change with its task. */
export async function codeLog(env: Env, p: Principal, yardId: string, limit = 50) {
  return openBase(env, p, yardId, async (repo, ref) => {
    const info = await repo.info();
    const log = await changes(env, yardId, repo, ref, limit);
    return { remote: info.remote, defaultBranch: ref, changes: log.map(({ meta: _m, ...c }) => c) };
  });
}

/** A run of lines with the same origin: the change that wrote them, the agent and what it meant to do. */
export interface WhySpan {
  start: number;
  end: number;
  change: Change | null;
  agent: string | null;
  color: string | null;
  intent: { summary: string; why: string } | null;
}

async function textAt(repo: Repo, commit: string, path: string): Promise<string | null> {
  const blob = await repo.readFile({ ref: commit, path });
  if (!blob || blob.size > MAX_TEXT_BYTES) return null;
  const r = await blobText(blob);
  return r.binary ? null : r.text;
}

/**
 * Why each line of a file is there. Walks the base's log newest first; each line belongs to the
 * change that wrote it. For a task's change, the agent comes from the decision (the winner, the
 * only agent on the file, or the per-line record of an assembled file) and its intent is the one
 * the agent recorded. Lines older than the log window have no change.
 */
export async function codeWhy(env: Env, p: Principal, yardId: string, path: string) {
  return openBase(env, p, yardId, async (repo, ref) => {
    const log = await changes(env, yardId, repo, ref);
    const head = log[0];
    const current = head ? await textAt(repo, head.commit, path) : null;
    if (current === null) throw new ServiceError(404, `no text file ${path} on ${ref}`);
    const lines = current === "" ? 0 : current.replace(/\n$/, "").split("\n").length;
    const owner: { commit: number; at: number }[] = new Array(lines);
    let pos = Array.from({ length: lines }, (_, i) => i as number | null);
    let text: string | null = current;
    for (let c = 0; c < log.length && text !== null && pos.some((x) => x !== null); c++) {
      const parentHash = log[c]!.meta.parents[0];
      const before = parentHash ? await textAt(repo, parentHash, path) : null;
      const hunks = computeHunks(path, before ?? "", text);
      pos = pos.map((q, i) => {
        if (q === null) return null;
        const prev = before === null ? "added" : previousLine(hunks, q);
        if (prev !== "added") return prev;
        owner[i] = { commit: c, at: q };
        return null;
      });
      text = before;
    }

    const [decisions, agents, intents, mixed] = await env.DB.batch<Record<string, string | null>>([
      env.DB.prepare("SELECT result_commit, task_id, mode, winner_agent_id, selections FROM decisions WHERE yard_id = ?").bind(yardId),
      env.DB.prepare("SELECT task_id, id, name, color FROM agents WHERE yard_id = ?").bind(yardId),
      env.DB.prepare("SELECT task_id, agent_id, summary, why FROM intents WHERE yard_id = ? ORDER BY created_at").bind(yardId),
      env.DB.prepare("SELECT commit_hash, agents FROM line_agents WHERE yard_id = ? AND path = ?").bind(yardId, path),
    ]);
    const decisionOf = new Map(decisions!.results.map((d) => [d.result_commit!, d]));
    const nameOf = new Map(agents!.results.map((a) => [`${a.task_id}/${a.id}`, { name: a.name!, color: a.color! }]));
    const intentOf = new Map(intents!.results.map((x) => [`${x.task_id}/${x.agent_id}`, { summary: x.summary!, why: x.why! }]));
    const lineAgents = new Map(mixed!.results.map((m) => [m.commit_hash!, JSON.parse(m.agents!) as (string | null)[]]));
    const agentFor = (o: { commit: number; at: number } | undefined): string | null => {
      if (!o) return null;
      const d = decisionOf.get(log[o.commit]!.commit);
      if (!d) return null;
      if (d.winner_agent_id) return d.winner_agent_id;
      const perLine = lineAgents.get(d.result_commit!)?.[o.at];
      if (perLine) return perLine;
      const onFile = [...new Set((JSON.parse(d.selections ?? "[]") as { path: string; agentId: string }[]).filter((s) => s.path === path).map((s) => s.agentId))];
      return onFile.length === 1 ? onFile[0]! : null;
    };

    const spans: (WhySpan & { agentId: string | null })[] = [];
    for (let i = 0; i < lines; i++) {
      const o = owner[i];
      const entry = o ? log[o.commit]! : null;
      const agentId = agentFor(o);
      const last = spans[spans.length - 1];
      if (last && last.change?.commit === entry?.commit && last.agentId === agentId) {
        last.end = i + 1;
        continue;
      }
      const key = entry?.task && agentId ? `${entry.task.id}/${agentId}` : null;
      spans.push({
        start: i,
        end: i + 1,
        change: entry ? { commit: entry.commit, message: entry.message, author: entry.author, at: entry.at, task: entry.task, agents: entry.agents } : null,
        agent: key ? (nameOf.get(key)?.name ?? agentId) : null,
        color: key ? (nameOf.get(key)?.color ?? null) : null,
        agentId,
        intent: key ? (intentOf.get(key) ?? null) : null,
      });
    }
    return { path, lines, spans: spans.map(({ agentId: _a, ...span }): WhySpan => span), window: log.length };
  });
}
