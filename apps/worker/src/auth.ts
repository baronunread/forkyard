import { ME, origin, sessionFor, verifyAccessToken } from "./better-auth";
import { sha256Hex } from "./db";
import type { Env } from "./env";

/**
 * Who is calling.
 *
 * - `user`: a person signed in with GitHub or Google (Better Auth session),
 *   or an agent they authorized over OAuth to act *as them*. Sees and acts on
 *   the yards they are a member of.
 * - `agent`: one agent seat on one task: an OAuth token bound to that seat on
 *   /connect, or a per-agent `fy_` key minted at fan-out. `judge` seats may
 *   also decide their task.
 * - `admin`: the operator (`FORKYARD_ADMIN_KEY`) for scripts and benchmarks.
 *   With FORKYARD_DEV=true (local only), anonymous requests are admin too.
 */
export type Principal =
  | { kind: "admin"; via: "admin-key" | "dev"; label: string }
  | { kind: "user"; userId: string; label: string; via: "session" | "oauth" }
  | { kind: "agent"; yardId: string; taskId: string; agentId: string; role: "agent" | "judge"; label: string; userId?: string };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403,
  ) {
    super(message);
  }
}

/** Local development: anonymous calls (the seed, bench and e2e scripts) act as admin. */
export function devMode(env: Env): boolean {
  return env.FORKYARD_DEV === "true";
}

const agentPrincipal = (yardId: string, taskId: string, agentId: string, role: string, userId?: string): Principal => ({
  kind: "agent",
  yardId,
  taskId,
  agentId,
  role: role === "judge" ? "judge" : "agent",
  userId,
  label: `agent:${yardId}/${taskId}/${agentId}`,
});

/**
 * A bearer credential: a per-agent `fy_` key, the admin key, or an OAuth
 * access token issued by the MCP authorization server (its `seat` claim says
 * whether it acts as the person or as one agent seat).
 */
export async function principalForToken(env: Env, origin: string, token: string): Promise<Principal | null> {
  if (token.startsWith("fy_")) {
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .bind(await sha256Hex(token))
      .first<{ yard_id: string; task_id: string; agent_id: string; role: string }>();
    return row ? agentPrincipal(row.yard_id, row.task_id, row.agent_id, row.role) : null;
  }
  if (env.FORKYARD_ADMIN_KEY && timingSafeEqual(token, env.FORKYARD_ADMIN_KEY)) return { kind: "admin", via: "admin-key", label: "admin-key" };

  const claims = await verifyAccessToken(env, origin, token);
  if (!claims?.sub) return null;
  const seat = claims.seat ?? ME;
  if (seat === ME) return { kind: "user", userId: claims.sub, label: `user:${claims.sub}`, via: "oauth" };
  const [yardId, taskId, agentId] = seat.split("/");
  if (!yardId || !taskId || !agentId || !(await isMember(env, claims.sub, yardId))) return null;
  const a = await env.DB.prepare("SELECT role FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?").bind(yardId, taskId, agentId).first<{ role: string }>();
  return a ? agentPrincipal(yardId, taskId, agentId, a.role, claims.sub) : null;
}

export function bearer(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return new URL(req.url).searchParams.get("key");
}

/** Authenticate a REST / WebSocket / MCP request: bearer credential, then session cookie, then dev mode. */
export async function authenticate(env: Env, req: Request): Promise<Principal> {
  const o = origin(env, req);
  const token = bearer(req);
  if (token) {
    const p = await principalForToken(env, o, token);
    if (!p) throw new AuthError("unknown, expired or revoked token", 401);
    return p;
  }
  const session = await sessionFor(env, o, req.headers);
  if (session) return { kind: "user", userId: session.user.id, label: `user:${session.user.id}`, via: "session" };
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
