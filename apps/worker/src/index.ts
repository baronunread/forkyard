import { AGENTS_MD_TEMPLATE, llmsTxt, MCP_TOOLS } from "@forkyard/shared";
import { gitProxy, isForkyardGitPath } from "./git-proxy";
import { Hono, type MiddlewareHandler } from "hono";
import { api, type HonoEnv } from "./api";
import { assertYard, authenticate, bearer, principalForToken } from "./auth";
import { AUTH_BASE_PATH, handleAuth, origin, socialProviders } from "./better-auth";
import { getYard } from "./db";
import { mapLimit } from "./diff";
import { num, type Env } from "./env";
import { handleMcp } from "./mcp";
import { routeArtifactsEvent, type ArtifactsPushEvent } from "./review";
import { cleanupForks, toServiceError } from "./service";
import { yardStub } from "./yard";

export { Yard } from "./yard";
export { LocalArtifacts } from "./artifacts/emulator";
export { ReviewWorkflow } from "./review";
export { IssueImportWorkflow } from "./backlog";
export { PiAgent } from "./pi-agent";

const app = new Hono<HonoEnv>();

app.onError((err, c) => {
  const e = toServiceError(err);
  if (e.status >= 500) console.error(err);
  return c.json({ error: e.message }, e.status);
});

// The UI is same-origin and agents are not browsers, so there is no CORS. Browsers always
// send Origin on WebSocket upgrades and cross-site POSTs: refuse any that is not this host,
// so the session cookie can't be ridden by another site (CSRF / socket hijacking).
const sameOrigin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== "null") {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed */
    }
    if (host !== new URL(c.req.url).host && host !== c.req.header("Host")) return c.json({ error: "cross-origin requests are not allowed" }, 403);
  }
  await next();
};
app.use("/api/*", sameOrigin);
app.use("/mcp", sameOrigin);

// Better Auth: GitHub / Google sign-in and sessions for people; the OAuth 2.1
// authorization server (registration, authorize, token, JWKS) for agents.
app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => handleAuth(c.env, origin(c.env, c.req.raw), c.req.raw));
// OAuth discovery: authorization-server and protected-resource metadata, served by the same plugin.
app.get("/.well-known/*", (c) => handleAuth(c.env, origin(c.env, c.req.raw), c.req.raw));
app.get("/api/providers", (c) => c.json({ providers: socialProviders(c.env), emulated: !!(c.env.EMULATE_GITHUB_URL || c.env.EMULATE_GOOGLE_URL) }));

// Live updates: UI and agents subscribe to a yard over a hibernatable WebSocket.
app.get("/api/yards/:yard/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "expected a websocket upgrade" }, 426);
  const p = await authenticate(c.env, c.req.raw);
  const yardId = c.req.param("yard");
  await assertYard(c.env, p, yardId);
  const yard = await getYard(c.env.DB, yardId);
  if (!yard) return c.json({ error: "yard not found" }, 404);
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Forkyard-Role", p.kind === "agent" ? "agent" : "ui");
  if (p.kind === "agent") {
    headers.set("X-Forkyard-Agent", p.agentId);
    headers.set("X-Forkyard-Task", p.taskId);
  }
  return yardStub(c.env, yard).fetch(new Request(c.req.url, { headers }));
});

app.get("/api/openapi.json", (c) => c.json(routeTable(new URL(c.req.url).origin)));
app.route("/api", api);

// MCP needs a bearer: an OAuth access token, a per-agent key or the admin key. Without one,
// answer the way MCP clients expect so they start OAuth discovery (RFC 9728).
app.all("/mcp", async (c) => {
  const o = origin(c.env, c.req.raw);
  const token = bearer(c.req.raw);
  const p = token ? await principalForToken(c.env, o, token) : null;
  if (!p) {
    const challenge = `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource/mcp"${token ? ', error="invalid_token"' : ""}`;
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "unauthorized" }, id: null }, 401, { "WWW-Authenticate": challenge });
  }
  c.set("principal", p);
  return handleMcp(c);
});

app.get("/llms.txt", (c) => c.text(llmsTxt(new URL(c.req.url).origin)));
app.get("/AGENTS.md", (c) => c.body(AGENTS_MD_TEMPLATE, 200, { "Content-Type": "text/markdown; charset=utf-8" }));
app.get("/healthz", (c) => c.json({ ok: true }));


// Git at Forkyard's address (/git/<owner>/<yard>/<task>/<agent>.git), signed in with an access token.
app.all("/git/*", async (c, next) => (isForkyardGitPath(new URL(c.req.url).pathname) ? gitProxy(c.env, c.req.raw) : next()));

// Local Artifacts emulator: git smart HTTP (dev only).
app.all("/git/*", async (c) => {
  if (c.env.ARTIFACTS_MODE !== "local" && c.env.ARTIFACTS) return c.json({ error: "git is served by Artifacts in this deployment" }, 404);
  const stub = c.env.ARTIFACTS_EMULATOR.get(c.env.ARTIFACTS_EMULATOR.idFromName("default"));
  return stub.fetch(c.req.raw);
});

// Everything else is the web app (SPA fallback handled by the assets binding).
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Forkyard API is running. Start the web app with `bun run dev`.", 200);
});

function routeTable(origin: string) {
  return {
    openapi: "3.1.0",
    info: { title: "Forkyard", version: "0.1.0", description: "Every MCP tool has a REST twin. Auth: a session cookie, an OAuth access token, an agent key (fy_...) or the admin key." },
    servers: [{ url: `${origin}/api` }],
    "x-mcp-tools": MCP_TOOLS.map(([name, description]) => ({ name, description })),
    paths: {
      "/yards": { get: { summary: "List yards" }, post: { summary: "Create a yard (base repo from files or importUrl)" } },
      "/yards/{yard}": { get: { summary: "yard_status" } },
      "/yards/{yard}/events": { get: { summary: "events_since (?since=&limit=&taskId=&agentId=&types=)" } },
      "/yards/{yard}/ws": { get: { summary: "WebSocket: live events and overlap warnings (?key=&since=)" } },
      "/yards/{yard}/tasks": { get: { summary: "List tasks" }, post: { summary: "task_create (?stream=1 for NDJSON workspaces as forks become ready)" } },
      "/yards/{yard}/tasks/{task}": { get: { summary: "Task with agents, intents, reviews, overlaps, decision" } },
      "/yards/{yard}/tasks/{task}/compare": { get: { summary: "compare_forks" } },
      "/yards/{yard}/tasks/{task}/compare/file": { get: { summary: "compare_forks for one file (?path=)" } },
      "/yards/{yard}/tasks/{task}/decide/preview": { post: { summary: "decide_preview" } },
      "/yards/{yard}/tasks/{task}/decide": { post: { summary: "decide" } },
      "/yards/{yard}/tasks/{task}/abandon": { post: { summary: "task_abandon" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/workspace": { get: { summary: "workspace_get" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/claims": { post: { summary: "claim_paths" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/claims/release": { post: { summary: "release_paths" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/intents": { post: { summary: "intent_record" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/diff": { get: { summary: "Fork diff summary" } },
      "/yards/{yard}/tasks/{task}/agents/{agent}/reviews": { get: { summary: "review_get" } },
      "/bench": { get: { summary: "Benchmark runs" } },
      "/bench/fork": { post: { summary: "Fork N times concurrently and report p50/p95/p99" } },
      "/admin/cleanup": { post: { summary: "Delete forks of closed tasks past a TTL; optionally abandon stale tasks and sweep bench forks" } },
    },
  };
}

export default {
  fetch: app.fetch,

  /**
   * Artifacts event subscription → Queue → here → Yard DO (live) + review Workflow.
   * Messages in a batch are routed concurrently (each acked or retried on its own):
   * a swarm pushes hundreds of times a second, and one-at-a-time delivery is a queue
   * behind a queue. Order doesn't matter — onPush reads the fork's real head.
   */
  async queue(batch: MessageBatch<ArtifactsPushEvent>, env: Env): Promise<void> {
    await mapLimit(batch.messages, num(env.QUEUE_CONCURRENCY, 8), async (msg) => {
      try {
        await routeArtifactsEvent(env, msg.body, msg.body.metadata && "emulator" in msg.body.metadata ? "local" : "queue", true);
        msg.ack();
      } catch (err) {
        console.error("failed to route artifacts event", err);
        msg.retry({ delaySeconds: Math.min(60, 2 ** msg.attempts) });
      }
    });
  },

  /** Delete forks of decided/abandoned tasks after the TTL so nothing lingers into billing. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const res = await cleanupForks(env, num(env.FORK_TTL_HOURS, 24));
    if (res.deleted.length || res.failed.length) console.log("fork cleanup", res);
  },
} satisfies ExportedHandler<Env, ArtifactsPushEvent>;

