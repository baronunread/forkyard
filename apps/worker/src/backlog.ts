import type { BacklogComment, BacklogItem, FileBacklogInput, StartBacklogInput } from "@forkyard/shared";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { githubAccessToken } from "./better-auth";
import { assertMemberOrAdmin, assertYard, type Principal } from "./auth";
import { getYard, now } from "./db";
import type { Env } from "./env";
import { ServiceError, taskCreate } from "./service";
import { yardStubById } from "./yard";

/**
 * The backlog (issue #15): tasks that haven't started. An item is a title and a markdown body
 * with comments; "Start" turns it into a normal task with the body and comments as its brief.
 * GitHub issues come in once, as items: no link back, no sync.
 */

type Row = Record<string, string | number | null>;

function toItem(r: Row): BacklogItem {
  return {
    id: String(r.id),
    yardId: String(r.yard_id),
    title: String(r.title),
    body: String(r.body),
    labels: JSON.parse(String(r.labels ?? "[]")) as string[],
    author: String(r.author),
    source: r.source === "github" ? "github" : "forkyard",
    sourceRef: r.source_ref === null ? null : String(r.source_ref),
    status: String(r.status) as BacklogItem["status"],
    taskId: r.task_id === null ? null : String(r.task_id),
    createdAt: String(r.created_at),
    comments: Number(r.comments ?? 0),
  };
}

const SELECT = `SELECT b.*, (SELECT COUNT(*) FROM backlog_comments c WHERE c.yard_id = b.yard_id AND c.item_id = b.id) AS comments FROM backlog_items b`;

/** The backlog, and the GitHub repo whose issues are still coming in (or null). */
export async function backlogList(env: Env, p: Principal, yardId: string): Promise<{ items: BacklogItem[]; importing: string | null }> {
  await assertYard(env, p, yardId);
  const [items, yard] = await env.DB.batch<Row>([
    env.DB.prepare(`${SELECT} WHERE b.yard_id = ? ORDER BY b.created_at DESC`).bind(yardId),
    env.DB.prepare("SELECT importing_issues FROM yards WHERE id = ?").bind(yardId),
  ]);
  const importing = yard!.results[0]?.importing_issues;
  return { items: items!.results.map(toItem), importing: importing ? String(importing) : null };
}

export async function backlogGet(env: Env, p: Principal, yardId: string, id: string): Promise<BacklogItem & { thread: BacklogComment[] }> {
  await assertYard(env, p, yardId);
  const row = await env.DB.prepare(`${SELECT} WHERE b.yard_id = ? AND b.id = ?`).bind(yardId, id).first<Row>();
  if (!row) throw new ServiceError(404, `backlog item ${id} not found`);
  const { results } = await env.DB.prepare("SELECT author, body, created_at FROM backlog_comments WHERE yard_id = ? AND item_id = ? ORDER BY created_at")
    .bind(yardId, id)
    .all<Row>();
  return { ...toItem(row), thread: results.map((c) => ({ author: String(c.author), body: String(c.body), createdAt: String(c.created_at) })) };
}

/** Items are numbered per yard, like issues. */
async function nextId(env: Env, yardId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS n FROM backlog_items WHERE yard_id = ?").bind(yardId).first<{ n: number }>();
  return r?.n ?? 1;
}

export async function backlogFile(env: Env, p: Principal, yardId: string, input: FileBacklogInput): Promise<BacklogItem> {
  await assertMemberOrAdmin(env, p, yardId);
  const id = String(await nextId(env, yardId));
  await env.DB.prepare("INSERT INTO backlog_items (yard_id, id, title, body, labels, author, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'forkyard', ?)")
    .bind(yardId, id, input.title, input.body, JSON.stringify(input.labels), p.label, now())
    .run();
  return (await backlogGet(env, p, yardId, id)) as BacklogItem;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  comments: number;
  comments_url: string;
  created_at: string;
  pull_request?: unknown;
}

/**
 * Open issues of a GitHub repo, with their comments, as backlog items. Re-running skips what's
 * already here. Uses the caller's GitHub sign-in token when there is one (5,000 requests/hour);
 * without it, GitHub's anonymous limit (60/hour, shared by Cloudflare's egress IPs) applies.
 * ponytail: public repos only (sign-in asks for no repo scope); private repos and image
 * re-hosting come with #14.
 */
export async function backlogImportGithub(env: Env, p: Principal, yardId: string, repo: string, token: string | null, f: typeof fetch = fetch) {
  await assertMemberOrAdmin(env, p, yardId);
  if (!(await getYard(env.DB, yardId))) throw new ServiceError(404, `yard ${yardId} not found`);
  const gh = async <T>(url: string): Promise<T> => {
    const res = await f(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "forkyard", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (res.status === 404) throw new ServiceError(404, `GitHub repo ${repo} not found (public repos only for now)`);
    if (res.status === 403 || res.status === 429)
      throw new ServiceError(429, token ? "GitHub's rate limit is spent; try again in an hour" : "GitHub's rate limit for anonymous requests is spent; sign in with GitHub to import");
    if (!res.ok) throw new ServiceError(502, `GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  };
  const issues: GhIssue[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh<GhIssue[]>(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}&direction=asc`);
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  const have = new Set(
    (await env.DB.prepare("SELECT source_ref FROM backlog_items WHERE yard_id = ? AND source = 'github'").bind(yardId).all<{ source_ref: string }>()).results.map((r) => r.source_ref),
  );
  // Keep GitHub's number when it's free here, so "#15" means the same thing in both places.
  const taken = new Set((await env.DB.prepare("SELECT id FROM backlog_items WHERE yard_id = ?").bind(yardId).all<{ id: string }>()).results.map((r) => r.id));
  let n = Math.max(await nextId(env, yardId), ...issues.map((i) => i.number + 1));
  let imported = 0;
  for (const issue of issues) {
    const ref = `${repo}#${issue.number}`;
    if (have.has(ref)) continue;
    const comments = issue.comments ? await gh<{ user: { login: string } | null; body: string | null; created_at: string }[]>(`${issue.comments_url}?per_page=100`) : [];
    const id = taken.has(String(issue.number)) ? String(n++) : String(issue.number);
    taken.add(id);
    const labels = issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO backlog_items (yard_id, id, title, body, labels, author, source, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, 'github', ?, ?)").bind(
        yardId,
        id,
        issue.title,
        issue.body ?? "",
        JSON.stringify(labels),
        `@${issue.user?.login ?? "ghost"}`,
        ref,
        issue.created_at,
      ),
      ...comments.map((c) =>
        env.DB.prepare("INSERT INTO backlog_comments (yard_id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(yardId, id, `@${c.user?.login ?? "ghost"}`, c.body ?? "", c.created_at),
      ),
    ]);
    imported++;
  }
  return { imported, skipped: issues.length - imported };
}

const BRIEF_MAX = 8000;
const TITLE_MAX = 120;

/** The task's brief: the item's body, then its discussion, cut to what a brief holds. */
export function briefFor(item: Pick<BacklogItem, "body" | "sourceRef">, thread: BacklogComment[]): string {
  const parts = [item.body.trim() || "(no description)"];
  if (thread.length) parts.push("## Discussion", ...thread.map((c) => `**${c.author}:** ${c.body.trim()}`));
  if (item.sourceRef) parts.push(`(Imported from GitHub ${item.sourceRef}.)`);
  const text = parts.join("\n\n");
  return text.length <= BRIEF_MAX ? text : `${text.slice(0, BRIEF_MAX - 40)}\n\n… (cut; see the backlog item)`;
}

export async function backlogStart(env: Env, p: Principal, yardId: string, id: string, input: StartBacklogInput) {
  await assertMemberOrAdmin(env, p, yardId);
  const item = await backlogGet(env, p, yardId, id);
  if (item.status !== "open") throw new ServiceError(409, `backlog item ${id} is ${item.status}`);
  const title = item.title.length <= TITLE_MAX ? item.title : `${item.title.slice(0, TITLE_MAX - 1)}…`;
  const res = await taskCreate(env, p, yardId, { title, brief: briefFor(item, item.thread), agents: input.agents, autopilot: input.autopilot });
  await env.DB.prepare("UPDATE backlog_items SET status = 'started', task_id = ? WHERE yard_id = ? AND id = ?").bind(res.task.id, yardId, id).run();
  return res;
}

export interface IssueImportParams {
  yardId: string;
  repo: string;
  /** Whose GitHub sign-in token to use (fetched inside the step, never stored in the instance); null: anonymous. */
  userId: string | null;
  origin: string;
}

/**
 * A yard started from a GitHub repo brings its open issues along. A Workflow, so the import
 * finishes even when the browser that created the yard is gone. Re-running is safe: imported
 * issues are skipped, so a retry after a rate limit picks up where it stopped.
 */
export class IssueImportWorkflow extends WorkflowEntrypoint<Env, IssueImportParams> {
  override async run(event: Readonly<WorkflowEvent<IssueImportParams>>, step: WorkflowStep) {
    const { yardId, repo, userId, origin } = event.payload;
    let result = { imported: 0, skipped: 0, error: null as string | null };
    try {
      // GitHub's rate limit resets hourly: 2, 4, 8, 16, 32 minutes covers it.
      const r = await step.do("import issues", { retries: { limit: 5, delay: "2 minutes", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
        const token = userId ? await githubAccessToken(this.env, origin, userId) : null;
        try {
          return await backlogImportGithub(this.env, { kind: "admin", via: "dev", label: "issue-import" }, yardId, repo, token);
        } catch (err) {
          if (err instanceof ServiceError && err.status !== 429 && err.status < 500) throw new NonRetryableError(err.message);
          throw err;
        }
      });
      result = { ...r, error: null };
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    await step.do("tell the yard", async () => {
      await this.env.DB.prepare("UPDATE yards SET importing_issues = NULL WHERE id = ?").bind(yardId).run();
      // The yard may have been deleted meanwhile.
      await (await yardStubById(this.env, yardId))?.stub.append({ type: "backlog.imported", taskId: null, agentId: null, data: { repo, ...result } });
      return true;
    });
    return result;
  }
}
