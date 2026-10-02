import { AGENTS_MD_TEMPLATE, llmsTxt, MCP_TOOLS } from "@forkyard/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api, type HonoEnv } from "./api";
import { assertYard, authenticate } from "./auth";
import { getYard } from "./db";
import { num, type Env } from "./env";
import { mcpFetch } from "./mcp";
import { routeArtifactsEvent, type ArtifactsPushEvent } from "./review";
import { cleanupForks, toServiceError } from "./service";
import { yardStub } from "./yard";

export { Yard } from "./yard";
export { LocalArtifacts } from "./artifacts/emulator";
export { ReviewWorkflow } from "./review";

const app = new Hono<HonoEnv>();

app.onError((err, c) => {
  const e = toServiceError(err);
  if (e.status >= 500) console.error(err);
  return c.json({ error: e.message }, e.status);
});

app.use("/api/*", cors({ origin: (o) => o, allowHeaders: ["Authorization", "Content-Type"], credentials: true }));

// Live updates: UI and agents subscribe to a yard over a hibernatable WebSocket.
app.get("/api/yards/:yard/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "expected a websocket upgrade" }, 426);
  const p = await authenticate(c.env, c.req.raw);
  const yardId = c.req.param("yard");
  assertYard(p, yardId);
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

app.all("/mcp", async (c) => {
  const p = await authenticate(c.env, c.req.raw);
  return mcpFetch(c.env, p, c.req.raw, c.executionCtx as ExecutionContext);
});

app.get("/llms.txt", (c) => c.text(llmsTxt(new URL(c.req.url).origin)));
app.get("/AGENTS.md", (c) => c.body(AGENTS_MD_TEMPLATE, 200, { "Content-Type": "text/markdown; charset=utf-8" }));
app.get("/healthz", (c) => c.json({ ok: true }));

// Local Artifacts emulator: git smart HTTP (dev only).
app.all("/git/*", async (c) => {
  if (c.env.ARTIFACTS_MODE !== "local" && c.env.ARTIFACTS) return c.json({ error: "git is served by Artifacts in this deployment" }, 404);
  const stub = c.env.ARTIFACTS_EMULATOR.get(c.env.ARTIFACTS_EMULATOR.idFromName("default"));
  return stub.fetch(c.req.raw);
});

// Everything else is the web app (SPA fallback handled by the assets binding).
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Forkyard API is running. Start the web app with `pnpm dev`.", 200);
});

function routeTable(origin: string) {
  return {
    openapi: "3.1.0",
    info: { title: "Forkyard", version: "0.1.0", description: "Every MCP tool has a REST twin. Auth: Bearer agent key (fy_...) or admin key." },
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

  /** Artifacts event subscription → Queue → here → Yard DO (live) + review Workflow. */
  async queue(batch: MessageBatch<ArtifactsPushEvent>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await routeArtifactsEvent(env, msg.body, msg.body.metadata && "emulator" in msg.body.metadata ? "local" : "queue", true);
        msg.ack();
      } catch (err) {
        console.error("failed to route artifacts event", err);
        msg.retry({ delaySeconds: Math.min(60, 2 ** msg.attempts) });
      }
    }
  },

  /** Delete forks of decided/abandoned tasks after the TTL so nothing lingers into billing. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const res = await cleanupForks(env, num(env.FORK_TTL_HOURS, 24));
    if (res.deleted.length || res.failed.length) console.log("fork cleanup", res);
  },
} satisfies ExportedHandler<Env, ArtifactsPushEvent>;

