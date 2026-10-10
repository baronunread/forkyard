import { actingAgent, AuthError, isMember, principalForToken, type Principal } from "./auth";
import { disposeRepo, getArtifacts } from "./artifacts";
import { origin } from "./better-auth";
import { getAgent, getTask, getYard, newId, now, sha256Hex } from "./db";
import type { Env } from "./env";
import type { Yard } from "@forkyard/shared";

/**
 * Git at Forkyard's own address: /git/<owner>/<yard>/<task>/<agent>.git for a seat's fork, and
 * /git/<owner>/<yard>.git for the yard's main (read-only: merging is Forkyard's job). Git signs in with
 * the person's access token (or a headless seat's fy_ key) as its password, kept by their
 * credential helper, so an agent runs plain `git clone` / `git push` and never holds a secret.
 * Forkyard checks the seat, mints a minutes-long Artifacts token for that one fork, and
 * streams the request through.
 */
const SEAT = /^\/git\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.git(\/.*)?$/;
const YARD = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export const isForkyardGitPath = (path: string) => SEAT.test(path) || YARD.test(path);

export async function gitProxy(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const seat = SEAT.exec(url.pathname);
  const m = seat ?? YARD.exec(url.pathname)!;
  const [owner, slug] = [m[1]!, m[2]!];
  const [taskId, agentId] = [seat?.[3] ?? "", seat?.[4] ?? ""];
  const rest = (seat ? seat[5] : m[3]) ?? "";
  const say = (status: number, text: string, headers: HeadersInit = {}) => new Response(`${text}\n`, { status, headers });
  const challenge = () =>
    say(401, "Forkyard: use your Forkyard access token as the git password (Settings → Git access).", { "WWW-Authenticate": 'Basic realm="Forkyard"' });

  const secret = passwordOf(req);
  if (!secret) return challenge();
  const p = await principalForToken(env, origin(env, req), secret);
  if (!p) return challenge();
  const row = await env.DB.prepare("SELECT id FROM yards WHERE owner = ? AND slug = ?").bind(owner, slug).first<{ id: string }>();
  const yard = row ? await getYard(env.DB, row.id) : null;
  if (!yard) return say(404, `Forkyard: no yard ${owner}/${slug}`);
  const pushing = rest === "/git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";

  if (!seat) {
    // The yard's main: anyone in the yard can clone it; nobody pushes to it.
    if (p.kind === "agent" ? p.yardId !== yard.id : p.kind === "user" && !(await isMember(env, p.userId, yard.id))) return say(403, "Forkyard: you are not in this yard");
    if (pushing) return say(403, "Forkyard: the yard's main takes no pushes. Push to your seat's fork; Forkyard merges.");
    return forward(env, req, yard.jurisdiction, yard.baseRepo, rest + url.search, "read");
  }
  try {
    await actingAgent(env, p, yard.id, taskId, agentId);
  } catch (err) {
    if (err instanceof AuthError) return say(403, `Forkyard: ${err.message}`);
    throw err;
  }
  const agent = await getAgent(env.DB, yard.id, taskId, agentId);
  if (!agent?.forkRemote) return say(404, `Forkyard: ${agentId} has no fork on ${taskId}`);

  if (pushing) {
    const task = await getTask(env.DB, yard.id, taskId);
    if (task?.status !== "open" || agent.status === "retired") return say(403, `Forkyard: ${taskId} is ${task?.status ?? "gone"}; its forks take no more pushes`);
  }
  return forward(env, req, yard.jurisdiction, agent.forkName, rest + url.search, pushing ? "write" : "read");
}

/** Stream one git request to an Artifacts repo with a minutes-long token minted for it. */
async function forward(env: Env, req: Request, jurisdiction: Yard["jurisdiction"], repoName: string, path: string, scope: "read" | "write"): Promise<Response> {
  const repo = await getArtifacts(env, jurisdiction).get(repoName);
  let token: string;
  let remote: string;
  try {
    token = (await repo.createToken(scope, 600)).plaintext;
    remote = (await repo.info()).remote;
  } finally {
    disposeRepo(repo);
  }
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${token}`);
  const out = new Request(remote + path, { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
  if (env.ARTIFACTS_MODE === "local" || !env.ARTIFACTS) return env.ARTIFACTS_EMULATOR.get(env.ARTIFACTS_EMULATOR.idFromName("default")).fetch(out);
  return fetch(out);
}

/** Git's password (Basic auth; the username is ignored) or a Bearer token. */
function passwordOf(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim() || null;
  if (!h.startsWith("Basic ")) return null;
  try {
    const decoded = atob(h.slice(6).trim());
    return decoded.slice(decoded.indexOf(":") + 1) || null;
  } catch {
    return null;
  }
}

// ── access tokens ───────────────────────────────────────────────────────────

function personOf(p: Principal): string {
  if (p.kind !== "user") throw new AuthError("access tokens belong to a person; sign in", 403);
  return p.userId;
}

export async function accessTokens(env: Env, p: Principal) {
  const rows = await env.DB.prepare("SELECT id, name, created_at, last_used_at FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .bind(personOf(p))
    .all<{ id: string; name: string; created_at: string; last_used_at: string | null }>();
  return { tokens: rows.results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })) };
}

/** A new token, shown once. */
export async function accessTokenCreate(env: Env, p: Principal, name: string) {
  const userId = personOf(p);
  const token = `fyp_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const id = newId("at_");
  await env.DB.prepare("INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, userId, name, await sha256Hex(token), now()).run();
  return { id, name, token };
}

export async function accessTokenRevoke(env: Env, p: Principal, id: string) {
  await env.DB.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(now(), id, personOf(p)).run();
  return accessTokens(env, p);
}
