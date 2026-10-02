import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, OAuthProvider, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { isMember, propsForKey, sessionUser, type GrantProps } from "./auth";
import type { Env } from "./env";
import { origin } from "./social";

/**
 * OAuth 2.1 for agents (MCP authorization). Forkyard is both the
 * authorization server and the protected resource (`/mcp`):
 *
 *  1. An MCP client hits /mcp without a token → 401 pointing at
 *     /.well-known/oauth-protected-resource.
 *  2. It registers (dynamic registration or a Client ID Metadata Document)
 *     and sends the person to /authorize.
 *  3. The person signs in with GitHub/Google if needed, then the consent
 *     screen asks what the agent may act as: *you* (your yards; it can create
 *     tasks) or *one agent seat* on an open task.
 *  4. The token carries that choice as props; /mcp turns it into a Principal.
 *
 * Per-agent `fy_` keys and the admin key still work as bearer tokens
 * (resolveExternalToken), for scripts and headless agents.
 */

export const MCP_SCOPE = "mcp";

const providers = new Map<string, OAuthProvider<Env>>();

export function oauthProvider(
  base: string,
  handlers: { api: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> }; web: ExportedHandler<Env> },
): OAuthProvider<Env> {
  let p = providers.get(base);
  if (p) return p;
  const resource = `${base}/mcp`;
  p = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: handlers.api,
    defaultHandler: handlers.web,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [MCP_SCOPE, "offline_access"],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: { resource, resource_name: "Forkyard" },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    resolveExternalToken: async ({ token, env }) => {
      const props = await propsForKey(env, token);
      return props ? { props, audience: resource } : null;
    },
  });
  providers.set(base, p);
  return p;
}

interface Seat {
  value: string;
  yard: string;
  task: string;
  agentName: string;
  role: string;
}

async function seatsFor(env: Env, userId: string): Promise<Seat[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.yard_id, a.task_id, a.id, a.name, a.role, t.title, y.name AS yard_name FROM agents a
     JOIN tasks t ON t.yard_id = a.yard_id AND t.id = a.task_id
     JOIN yards y ON y.id = a.yard_id
     WHERE t.status = 'open' AND a.status NOT IN ('failed', 'retired')
     ORDER BY t.created_at DESC, a.created_at LIMIT 200`,
  ).all<{ yard_id: string; task_id: string; id: string; name: string; role: string; title: string; yard_name: string }>();
  const allowed = await Promise.all(results.map((r) => isMember(env, userId, r.yard_id)));
  return results
    .filter((_, i) => allowed[i])
    .map((r) => ({ value: `${r.yard_id}/${r.task_id}/${r.id}`, yard: r.yard_name, task: r.title, agentName: r.name, role: r.role }));
}

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Forkyard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#171717;--body:#4d4d4d;--mute:#888;--line:#ebebeb;--ink:#171717;--on-ink:#fff;--warn:#ab570a}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#0a0a0a;--fg:#ededed;--body:#a1a1a1;--mute:#707070;--line:#1f1f1f;--ink:#ededed;--on-ink:#0a0a0a;--warn:#f5a623}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/20px Geist,Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(440px,calc(100vw - 32px));background:var(--card);border-radius:12px;padding:32px;box-shadow:0 0 0 1px var(--line),0 8px 16px -4px #0000000a,0 24px 32px -8px #0000000f}
h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.6px;margin:16px 0 4px}p{margin:0 0 12px;color:var(--body)}
.mono{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute);text-transform:uppercase}
.opt{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:8px;box-shadow:0 0 0 1px var(--line);margin:8px 0;cursor:pointer}
.opt:has(input:checked){box-shadow:0 0 0 2px var(--ink)}.opt input{margin-top:3px;accent-color:var(--ink)}
.opt b{font-weight:500;display:block}.opt span{color:var(--body);font-size:13px}
.list{max-height:240px;overflow:auto;margin:0 -4px;padding:0 4px}
.warn{color:var(--warn)}.row{display:flex;gap:8px;margin-top:20px}
button{flex:1;height:40px;border-radius:6px;border:0;font:500 14px/20px inherit;font-family:inherit;cursor:pointer}
.primary{background:var(--ink);color:var(--on-ink)}.secondary{background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--line)}
</style></head><body><main>
<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor"/><path d="M11 8v16M11 14c0 4 10 2 10 8M21 8v6" stroke="var(--card)" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>
${body}</main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string, seats: Seat[]): string {
  const name = esc(d.clientName);
  const from = d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : "This app registered itself; its name is not verified.";
  const local = d.redirectIsLoopback
    ? `<p class="warn">Access goes to an app on this computer (${esc(d.redirectHost)}). Continue only if you just started connecting from it.</p>`
    : `<p>Access will be sent to <b>${esc(d.redirectHost)}</b>.</p>`;
  const seatOpts = seats
    .map(
      (s) =>
        `<label class="opt"><input type="radio" name="seat" value="${esc(s.value)}"><div><b>${esc(s.agentName)}${s.role === "judge" ? " · judge" : ""}</b><span>${esc(s.task)} — ${esc(s.yard)}</span></div></label>`,
    )
    .join("");
  return page(
    `Connect ${d.clientName}`,
    `<h1>Connect ${name} to Forkyard</h1>
<p>${from}</p>${local}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="mono" style="margin-top:20px">Act as</div>
<label class="opt"><input type="radio" name="seat" value="me" checked><div><b>You</b><span>Works in all your yards: creates tasks, compares forks, decides.</span></div></label>
${seats.length ? `<div class="list">${seatOpts}</div>` : `<p style="margin-top:8px">No open agent seats yet. Create a task to get one.</p>`}
<div class="row"><button class="secondary" name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="approve">Connect</button></div>
</form>`,
  );
}

function errorPage(message: string, status = 400): Response {
  return new Response(page("Can't connect", `<h1>Can't connect</h1><p>${esc(message)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** GET/POST /authorize — the consent screen. */
export const authorize = new Hono<{ Bindings: Env }>().all("/authorize", async (c) => {
  const env = c.env;
  const req = c.req.raw;
  const oauth = env.OAUTH_PROVIDER;
  try {
    const userId = await sessionUser(env, req);
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      if (!userId) {
        const url = new URL(req.url);
        return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle, await seatsFor(env, userId)), { headers: consent.headers });
    }
    if (req.method !== "POST") return c.text("method not allowed", 405);
    if (!userId) return errorPage("Your session expired. Start connecting again from your agent.", 401);
    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const seat = String(form.get("seat") ?? "me");
    let props: GrantProps = { kind: "user", userId };
    if (seat !== "me") {
      const [yardId, taskId, agentId] = seat.split("/");
      if (!yardId || !taskId || !agentId || !(await isMember(env, userId, yardId))) return errorPage("That agent seat is not yours to grant.", 403);
      const a = await env.DB.prepare("SELECT role FROM agents WHERE yard_id = ? AND task_id = ? AND id = ?").bind(yardId, taskId, agentId).first<{ role: string }>();
      if (!a) return errorPage("That agent seat no longer exists.", 404);
      props = { kind: "agent", userId, yardId, taskId, agentId, role: a.role === "judge" ? "judge" : "agent" };
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [MCP_SCOPE, "offline_access"] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: encodeURIComponent(userId),
      metadata: { seat },
      scope: approved.request.scope.length ? approved.request.scope : [MCP_SCOPE],
      props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectUri) {
      return Response.redirect(authorizationErrorRedirect({ redirectUri: err.redirectUri, state: err.state, issuer: err.issuer }, err.code, err.description), 302);
    }
    if (err instanceof AuthorizationError) return errorPage(err.description);
    if (err instanceof CimdFetchError) return errorPage("This app could not be verified.");
    throw err;
  }
});

export { origin };
