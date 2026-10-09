import { mcp } from "@better-auth/mcp";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { now } from "./db";
import { emulatedProviders } from "./emulate";
import type { Env } from "./env";

/**
 * Accounts, built on Better Auth:
 *
 * - People sign in with GitHub or Google (social providers). Sessions live in
 *   D1 behind Better Auth's cookie. Locally, emulate.dev stands in for both
 *   providers (see emulate.ts), so the real flow runs without real apps.
 * - Agents connect over MCP with OAuth 2.1: the @better-auth/mcp plugin is
 *   the authorization server (discovery, dynamic client registration, PKCE,
 *   JWT access tokens bound to `<origin>/mcp`).
 * - Between sign-in and consent the person picks what the agent acts as on
 *   /connect: *you*, or *one agent seat* on an open task. That choice becomes
 *   the grant's reference id and a `seat` claim on every access token.
 */

export const AUTH_BASE_PATH = "/api/auth";
export const MCP_SCOPE = "mcp";
const SCOPES = ["openid", "profile", "email", "offline_access", MCP_SCOPE];
/** How long a seat picked on /connect stays good for finishing that authorization. */
const SEAT_CHOICE_TTL_MS = 10 * 60_000;
export const ME = "me";

type Auth = ReturnType<typeof createAuth>;
const instances = new Map<string, Auth>();

/** One Better Auth instance per origin per isolate (bindings don't change within an isolate). */
export function getAuth(env: Env, origin: string): Auth {
  let a = instances.get(origin);
  if (!a) {
    a = createAuth(env, origin);
    instances.set(origin, a);
  }
  return a;
}

export function socialProviders(env: Env): ("github" | "google")[] {
  const out: ("github" | "google")[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  return out;
}

function createAuth(env: Env, origin: string) {
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set");
  const providers = socialProviders(env);
  return betterAuth({
    appName: "Forkyard",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    // The same verified email from GitHub and Google is the same person.
    account: { accountLinking: { enabled: true, trustedProviders: ["github", "google"] } },
    socialProviders: {
      ...(providers.includes("github") ? { github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! } } : {}),
      ...(providers.includes("google") ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, prompt: "select_account" as const } } : {}),
    },
    plugins: [
      // Signs MCP access tokens; the issuer is the bare origin so discovery sits at the root.
      jwt({ jwt: { issuer: origin } }),
      mcp({
        resource: mcpResource(origin),
        loginPage: "/login",
        consentPage: "/connect",
        scopes: SCOPES,
        // MCP clients (Claude Code, Cursor, …) register themselves.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 3600,
        postLogin: {
          page: "/connect",
          shouldRedirect: async ({ session }) => !(await seatChoice(env, session.id)),
          consentReferenceId: async ({ session }) => {
            const seat = await seatChoice(env, session.id);
            if (!seat) throw new Error("pick what the agent acts as first");
            return seat;
          },
        },
        customAccessTokenClaims: ({ referenceId }) => ({ seat: referenceId ?? ME }),
      }),
    ],
  });
}

/** Canonical origin: PUBLIC_ORIGIN in production, else the request's. It is the OAuth issuer. */
export function origin(env: Env, req: Request): string {
  return (env.PUBLIC_ORIGIN || new URL(req.url).origin).replace(/\/$/, "");
}

export function mcpResource(origin: string): string {
  return `${origin}/mcp`;
}

/** The client of the authorization in flight (Better Auth keeps it in request state). */
async function currentClientId(): Promise<string | null> {
  const state = await getOAuthProviderState().catch(() => null);
  return state?.query ? new URLSearchParams(state.query).get("client_id") : null;
}

async function seatChoice(env: Env, sessionId: string): Promise<string | null> {
  const clientId = await currentClientId();
  if (!clientId) return null;
  const row = await env.DB.prepare("SELECT seat, created_at FROM oauth_seat_choices WHERE session_id = ? AND client_id = ?")
    .bind(sessionId, clientId)
    .first<{ seat: string; created_at: string }>();
  if (!row || Date.now() - Date.parse(row.created_at) > SEAT_CHOICE_TTL_MS) return null;
  return row.seat;
}

export async function recordSeatChoice(env: Env, sessionId: string, clientId: string, seat: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauth_seat_choices (session_id, client_id, seat, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, client_id) DO UPDATE SET seat = excluded.seat, created_at = excluded.created_at`,
  )
    .bind(sessionId, clientId, seat, now())
    .run();
}

/** Better Auth handles /api/auth/*; in emulate mode it also points the providers at the emulators. */
export async function handleAuth(env: Env, origin: string, req: Request): Promise<Response> {
  const emulated = emulatedProviders(env);
  await forgetSeatOnNewAuthorization(env, origin, req);
  const res = await getAuth(env, origin).handler(await nativeLoopbackRegistration(req));
  return emulated ? emulated.rewriteAuthResponse(req, res) : res;
}

/** Every new authorization asks again: a seat picked earlier for this client doesn't carry over. */
async function forgetSeatOnNewAuthorization(env: Env, origin: string, req: Request): Promise<void> {
  const url = new URL(req.url);
  if (req.method !== "GET" || !url.pathname.endsWith("/oauth2/authorize")) return;
  const clientId = url.searchParams.get("client_id");
  const session = clientId ? await sessionFor(env, origin, req.headers) : null;
  if (session) await env.DB.prepare("DELETE FROM oauth_seat_choices WHERE session_id = ? AND client_id = ?").bind(session.session.id, clientId).run();
}

/**
 * MCP clients (Claude Code, Cursor, …) register loopback redirect URIs like
 * http://localhost:PORT/callback without saying `application_type`, and the
 * OIDC default is "web", which forbids them. Registrations whose redirects are
 * all loopback http are native apps by definition, so say so on their behalf.
 */
async function nativeLoopbackRegistration(req: Request): Promise<Request> {
  if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/oauth2/register")) return req;
  const body = (await req.clone().json().catch(() => null)) as { application_type?: string; redirect_uris?: unknown } | null;
  if (!body || body.application_type || !Array.isArray(body.redirect_uris) || !body.redirect_uris.length) return req;
  const loopback = body.redirect_uris.every((u) => {
    try {
      const url = new URL(String(u));
      return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
      return false;
    }
  });
  if (!loopback) return req;
  const headers = new Headers(req.headers);
  headers.delete("Content-Length");
  return new Request(req.url, { method: "POST", headers, body: JSON.stringify({ ...body, application_type: "native" }) });
}

export async function sessionFor(env: Env, origin: string, headers: Headers) {
  return getAuth(env, origin).api.getSession({ headers });
}

/** Verify an MCP access token locally against our own JWKS (no self-fetch). */
export async function verifyAccessToken(env: Env, origin: string, token: string): Promise<(JWTPayload & { seat?: string }) | null> {
  if (token.split(".").length !== 3) return null;
  try {
    const jwks = (await getAuth(env, origin).api.getJwks()) as { keys: JsonWebKey[] };
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]), {
      issuer: origin,
      audience: mcpResource(origin),
    });
    return payload as JWTPayload & { seat?: string };
  } catch {
    return null;
  }
}

/** A person's GitHub access token from their sign-in (refreshed when it has expired), or null. */
export async function githubAccessToken(env: Env, origin: string, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM "account" WHERE "userId" = ? AND "providerId" = 'github'`).bind(userId).first<{ id: string }>();
  if (!row) return null;
  try {
    return (await getAuth(env, origin).api.getAccessToken({ body: { accountId: row.id, userId } })).accessToken ?? null;
  } catch (err) {
    console.warn("github token unavailable", err);
    return null;
  }
}
