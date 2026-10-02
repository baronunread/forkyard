import { GitHub, Google, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { Hono } from "hono";
import { devMode, readCookie, SESSION_COOKIE, sessionUser, socialProviders } from "./auth";
import { newId, now, sha256Hex } from "./db";
import type { Env } from "./env";

/**
 * Sign-in for people: GitHub and Google (OAuth 2.0 via arctic), sessions in
 * D1 behind an HttpOnly cookie. In local dev with no provider configured,
 * "Continue as dev user" stands in.
 *
 *   GET  /auth/providers             which buttons to show
 *   GET  /auth/github|google?next=   start
 *   GET  /auth/github|google/callback
 *   POST /auth/dev                   dev only
 *   POST /auth/logout
 */

const SESSION_DAYS = 30;
const FLOW_COOKIE = "fy_oauth_flow";

export function origin(env: Env, req: Request): string {
  return (env.PUBLIC_ORIGIN || new URL(req.url).origin).replace(/\/$/, "");
}

function secure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

function cookie(name: string, value: string, req: Request, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure(req) ? ["Secure"] : []),
  ].join("; ");
}

/** Only same-site relative paths, so `next` can't be used as an open redirect. */
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

function clients(env: Env, req: Request) {
  const base = origin(env, req);
  return {
    github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? new GitHub(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, `${base}/auth/github/callback`) : null,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${base}/auth/google/callback`) : null,
  };
}

interface Profile {
  provider: "github" | "google" | "dev";
  providerUserId: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
}

/** Find or create the user behind a provider account, and link it. */
async function upsertUser(env: Env, p: Profile): Promise<string> {
  const linked = await env.DB.prepare("SELECT user_id FROM accounts WHERE provider = ? AND provider_user_id = ?")
    .bind(p.provider, p.providerUserId)
    .first<{ user_id: string }>();
  if (linked) {
    await env.DB.prepare("UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), email = COALESCE(?, email) WHERE id = ?")
      .bind(p.name, p.avatarUrl, p.email, linked.user_id)
      .run();
    return linked.user_id;
  }
  // Same verified email from another provider → same person.
  const byEmail = p.email ? await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(p.email).first<{ id: string }>() : null;
  const userId = byEmail?.id ?? newId("u_");
  const stmts = [];
  if (!byEmail)
    stmts.push(
      env.DB.prepare("INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, p.email, p.name, p.avatarUrl, now()),
    );
  stmts.push(
    env.DB.prepare("INSERT INTO accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)").bind(p.provider, p.providerUserId, userId, now()),
  );
  await env.DB.batch(stmts);
  return userId;
}

async function startSession(env: Env, req: Request, userId: string, next: string): Promise<Response> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now(), expires.toISOString())
    .run();
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, token, req, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie(FLOW_COOKIE, "", req, 0));
  return new Response(null, { status: 302, headers });
}

async function githubProfile(accessToken: string): Promise<Profile> {
  const h = { Authorization: `Bearer ${accessToken}`, "User-Agent": "forkyard", Accept: "application/vnd.github+json" };
  const user = (await (await fetch("https://api.github.com/user", { headers: h })).json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
    email: string | null;
  };
  let email = user.email;
  if (!email) {
    const emails = (await (await fetch("https://api.github.com/user/emails", { headers: h })).json()) as { email: string; primary: boolean; verified: boolean }[];
    email = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified)?.email ?? null) : null;
  }
  return { provider: "github", providerUserId: String(user.id), email, name: user.name || user.login, avatarUrl: user.avatar_url };
}

export const social = new Hono<{ Bindings: Env }>()
  .get("/providers", (c) => c.json({ providers: socialProviders(c.env), dev: devMode(c.env) }))

  .get("/github", (c) => {
    const gh = clients(c.env, c.req.raw).github;
    if (!gh) return c.text("GitHub sign-in is not configured", 404);
    const state = generateState();
    const url = gh.createAuthorizationURL(state, ["read:user", "user:email"]);
    const flow = JSON.stringify({ state, next: safeNext(c.req.query("next")) });
    return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookie(FLOW_COOKIE, flow, c.req.raw, 600) } });
  })
  .get("/github/callback", async (c) => {
    const gh = clients(c.env, c.req.raw).github;
    const flow = JSON.parse(readCookie(c.req.raw, FLOW_COOKIE) || "{}") as { state?: string; next?: string };
    if (!gh || !flow.state || flow.state !== c.req.query("state") || !c.req.query("code")) return c.redirect("/login?error=state");
    const tokens = await gh.validateAuthorizationCode(c.req.query("code")!);
    const userId = await upsertUser(c.env, await githubProfile(tokens.accessToken()));
    return startSession(c.env, c.req.raw, userId, flow.next ?? "/");
  })

  .get("/google", (c) => {
    const g = clients(c.env, c.req.raw).google;
    if (!g) return c.text("Google sign-in is not configured", 404);
    const state = generateState();
    const verifier = generateCodeVerifier();
    const url = g.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]);
    const flow = JSON.stringify({ state, verifier, next: safeNext(c.req.query("next")) });
    return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookie(FLOW_COOKIE, flow, c.req.raw, 600) } });
  })
  .get("/google/callback", async (c) => {
    const g = clients(c.env, c.req.raw).google;
    const flow = JSON.parse(readCookie(c.req.raw, FLOW_COOKIE) || "{}") as { state?: string; verifier?: string; next?: string };
    if (!g || !flow.state || !flow.verifier || flow.state !== c.req.query("state") || !c.req.query("code")) return c.redirect("/login?error=state");
    const tokens = await g.validateAuthorizationCode(c.req.query("code")!, flow.verifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    const userId = await upsertUser(c.env, {
      provider: "google",
      providerUserId: claims.sub,
      email: claims.email_verified ? (claims.email ?? null) : null,
      name: claims.name || claims.email || "Google user",
      avatarUrl: claims.picture ?? null,
    });
    return startSession(c.env, c.req.raw, userId, flow.next ?? "/");
  })

  .post("/dev", async (c) => {
    if (!devMode(c.env)) return c.text("not available", 404);
    const form = await c.req.formData().catch(() => null);
    const userId = await upsertUser(c.env, { provider: "dev", providerUserId: "dev", email: "dev@localhost", name: "Dev User", avatarUrl: null });
    return startSession(c.env, c.req.raw, userId, String(form?.get("next") ?? c.req.query("next") ?? "/"));
  })

  .post("/logout", async (c) => {
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(SESSION_COOKIE, "", c.req.raw, 0) } });
  });

export async function currentUser(env: Env, req: Request) {
  const userId = await sessionUser(env, req);
  if (!userId) return null;
  return env.DB.prepare("SELECT id, email, name, avatar_url AS avatarUrl FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string | null; name: string; avatarUrl: string | null }>();
}
