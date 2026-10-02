import { sha256Hex } from "./db";
import type { Env } from "./env";

/**
 * Who is calling.
 *
 * - `user`: a person signed in with GitHub or Google (session cookie), or an
 *   agent that a person authorized over OAuth to act *as them*. Sees and acts
 *   on the yards they are a member of.
 * - `agent`: one agent seat on one task — an OAuth token bound to that seat on
 *   the consent screen, or a per-agent `fy_` key minted at fan-out. `judge`
 *   seats may also decide their task.
 * - `admin`: the operator (`FORKYARD_ADMIN_KEY`) for scripts and benchmarks.
 *   In local dev with nothing configured, anonymous requests are admin.
 */
export type Principal =
  | { kind: "admin"; via: "admin-key" | "dev"; label: string }
  | { kind: "user"; userId: string; label: string; via: "session" | "oauth" }
  | { kind: "agent"; yardId: string; taskId: string; agentId: string; role: "agent" | "judge"; label: string; userId?: string };

/** What an OAuth grant (or a resolved external token) carries in `ctx.props`. */
export type GrantProps =
  | { kind: "user"; userId: string }
  | { kind: "agent"; userId?: string; yardId: string; taskId: string; agentId: string; role: "agent" | "judge" }
  | { kind: "admin" };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403,
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = "fy_session";

export function socialProviders(env: Env): ("github" | "google")[] {
  const out: ("github" | "google")[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  return out;
}

/** Local development with no sign-in configured: anonymous calls are admin and "continue as dev user" exists. */
export function devMode(env: Env): boolean {
  return env.FORKYARD_DEV === "true" || (!env.FORKYARD_ADMIN_KEY && socialProviders(env).length === 0);
}

export function principalFromProps(props: GrantProps | undefined | null): Principal | null {
  if (!props) return null;
  if (props.kind === "admin") return { kind: "admin", via: "admin-key", label: "admin-key" };
  if (props.kind === "user") return { kind: "user", userId: props.userId, label: `user:${props.userId}`, via: "oauth" };
  return {
    kind: "agent",
    yardId: props.yardId,
    taskId: props.taskId,
    agentId: props.agentId,
    role: props.role,
    userId: props.userId,
    label: `agent:${props.yardId}/${props.taskId}/${props.agentId}`,
  };
}

/** Resolve a bearer credential that is not an OAuth token: agent keys and the admin key. */
export async function propsForKey(env: Env, key: string): Promise<GrantProps | null> {
  if (key.startsWith("fy_")) {
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .bind(await sha256Hex(key))
      .first<{ yard_id: string; task_id: string; agent_id: string; role: string }>();
    if (!row) return null;
    return { kind: "agent", yardId: row.yard_id, taskId: row.task_id, agentId: row.agent_id, role: row.role === "judge" ? "judge" : "agent" };
  }
  if (env.FORKYARD_ADMIN_KEY && timingSafeEqual(key, env.FORKYARD_ADMIN_KEY)) return { kind: "admin" };
  return null;
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function sessionUser(env: Env, req: Request): Promise<string | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Authenticate a REST / WebSocket request: bearer key, then session cookie, then dev mode. */
export async function authenticate(env: Env, req: Request): Promise<Principal> {
  const url = new URL(req.url);
  const header = req.headers.get("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : (url.searchParams.get("key") ?? "");
  if (key) {
    const p = principalFromProps(await propsForKey(env, key));
    if (!p) throw new AuthError("unknown or revoked key", 401);
    return p;
  }
  const userId = await sessionUser(env, req);
  if (userId) return { kind: "user", userId, label: `user:${userId}`, via: "session" };
  if (devMode(env)) return { kind: "admin", via: "dev", label: "dev" };
  throw new AuthError("sign in required", 401);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── authorization ───────────────────────────────────────────────────────────

/**
 * Can this user see a yard? Members can. In dev mode, yards nobody owns (made
 * by the seed script or the admin key) are visible to every signed-in user.
 */
export async function isMember(env: Env, userId: string, yardId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT EXISTS(SELECT 1 FROM yard_members WHERE yard_id = ?1 AND user_id = ?2) AS m,
            EXISTS(SELECT 1 FROM yard_members WHERE yard_id = ?1) AS owned`,
  )
    .bind(yardId, userId)
    .first<{ m: number; owned: number }>();
  if (row?.m) return true;
  return devMode(env) && !row?.owned;
}

export async function assertYard(env: Env, p: Principal, yardId: string): Promise<void> {
  if (p.kind === "agent" && p.yardId !== yardId) throw new AuthError("this agent is scoped to another yard", 403);
  if (p.kind === "user" && !(await isMember(env, p.userId, yardId))) throw new AuthError("you are not a member of this yard", 403);
}

export async function assertTask(env: Env, p: Principal, yardId: string, taskId: string): Promise<void> {
  await assertYard(env, p, yardId);
  if (p.kind === "agent" && p.taskId !== taskId) throw new AuthError("this agent is scoped to another task", 403);
}

/** The agent the caller acts as: itself if it is an agent, or the named one for people and admins. */
export async function actingAgent(env: Env, p: Principal, yardId: string, taskId: string, agentId?: string): Promise<string> {
  await assertTask(env, p, yardId, taskId);
  if (p.kind === "agent") {
    if (agentId && agentId !== p.agentId) throw new AuthError(`you act as ${p.agentId}, not ${agentId}`, 403);
    return p.agentId;
  }
  if (!agentId) throw new AuthError("agentId is required", 400);
  return agentId;
}

export async function assertCanDecide(env: Env, p: Principal, yardId: string, taskId: string): Promise<void> {
  await assertTask(env, p, yardId, taskId);
  if (p.kind === "agent" && p.role !== "judge") throw new AuthError("only judges and people can decide", 403);
}

/** Creating tasks and running benchmarks: people who are members, and admins. Not agent seats. */
export async function assertMemberOrAdmin(env: Env, p: Principal, yardId: string): Promise<void> {
  if (p.kind === "agent") throw new AuthError("agent seats cannot do this; sign in as a person", 403);
  await assertYard(env, p, yardId);
}

export function assertPerson(p: Principal): void {
  if (p.kind === "agent") throw new AuthError("agent seats cannot do this; sign in as a person", 403);
}

export function assertAdmin(p: Principal): void {
  if (p.kind !== "admin") throw new AuthError("operators only", 403);
}
