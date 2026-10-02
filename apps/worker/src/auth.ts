import { createRemoteJWKSet, jwtVerify } from "jose";
import { sha256Hex } from "./db";
import type { Env } from "./env";

/**
 * Principals:
 * - `human`/`admin`: a person behind Cloudflare Access, or anyone holding
 *   FORKYARD_ADMIN_KEY (e.g. an orchestrator agent). Can do everything.
 * - `agent`: holds a per-agent key minted at fan-out. Scoped to one task;
 *   `judge` agents may also decide that task.
 *
 * With neither Access nor an admin key configured, Forkyard runs in open dev
 * mode: requests without a key are treated as admin. `wrangler.jsonc` keeps
 * that off for deploys by requiring one of the two.
 */

export type Principal =
  | { kind: "admin"; via: "access" | "admin-key" | "dev"; label: string }
  | { kind: "agent"; yardId: string; taskId: string; agentId: string; role: "agent" | "judge"; label: string };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function devMode(env: Env): boolean {
  return !env.FORKYARD_ADMIN_KEY && !(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN);
}

export async function authenticate(env: Env, req: Request): Promise<Principal> {
  const url = new URL(req.url);
  const header = req.headers.get("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : (url.searchParams.get("key") ?? "");

  if (key.startsWith("fy_")) {
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .bind(await sha256Hex(key))
      .first<{ yard_id: string; task_id: string; agent_id: string; role: string }>();
    if (!row) throw new AuthError("unknown or revoked agent key", 401);
    return {
      kind: "agent",
      yardId: row.yard_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      role: row.role === "judge" ? "judge" : "agent",
      label: `agent:${row.yard_id}/${row.task_id}/${row.agent_id}`,
    };
  }
  if (env.FORKYARD_ADMIN_KEY && key && timingSafeEqual(key, env.FORKYARD_ADMIN_KEY)) {
    return { kind: "admin", via: "admin-key", label: "admin-key" };
  }
  const accessJwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (accessJwt && env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    const domain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
    jwks ??= createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    try {
      const { payload } = await jwtVerify(accessJwt, jwks, { issuer: domain, audience: env.ACCESS_AUD });
      return { kind: "admin", via: "access", label: String(payload.email ?? payload.sub ?? "access-user") };
    } catch {
      throw new AuthError("invalid Cloudflare Access token", 401);
    }
  }
  if (devMode(env)) return { kind: "admin", via: "dev", label: "dev" };
  throw new AuthError("authentication required: Cloudflare Access, admin key, or agent key", 401);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function assertYard(p: Principal, yardId: string): void {
  if (p.kind === "agent" && p.yardId !== yardId) throw new AuthError("agent key is scoped to another yard", 403);
}

export function assertTask(p: Principal, yardId: string, taskId: string): void {
  assertYard(p, yardId);
  if (p.kind === "agent" && p.taskId !== taskId) throw new AuthError("agent key is scoped to another task", 403);
}

/** The agent the caller acts as: itself, or any agent if admin. */
export function actingAgent(p: Principal, yardId: string, taskId: string, agentId?: string): string {
  assertTask(p, yardId, taskId);
  if (p.kind === "agent") {
    if (agentId && agentId !== p.agentId) throw new AuthError(`this key acts as ${p.agentId}, not ${agentId}`, 403);
    return p.agentId;
  }
  if (!agentId) throw new AuthError("agentId is required when acting as admin", 403);
  return agentId;
}

export function assertCanDecide(p: Principal, yardId: string, taskId: string): void {
  assertTask(p, yardId, taskId);
  if (p.kind === "agent" && p.role !== "judge") throw new AuthError("only judges and humans can decide", 403);
}

export function assertAdmin(p: Principal): void {
  if (p.kind !== "admin") throw new AuthError("admin only", 403);
}
