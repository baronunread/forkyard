import { zValidator } from "@hono/zod-validator";
import {
  ClaimInput,
  CreateTaskInput,
  CreateYardInput,
  DecideInput,
  IntentInput,
  type Workspace,
} from "@forkyard/shared";
import { Hono } from "hono";
import { z } from "zod";
import { authenticate, devMode, type Principal } from "./auth";
import type { Env } from "./env";
import { currentUser } from "./social";
import { routeArtifactsEvent, type ArtifactsPushEvent } from "./review";
import * as svc from "./service";

export type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };

const yardParam = z.object({ yard: z.string() });
const taskParam = z.object({ yard: z.string(), task: z.string() });
const agentParam = z.object({ yard: z.string(), task: z.string(), agent: z.string() });

/**
 * REST API. Every route maps 1:1 to a service function that the MCP server
 * also exposes, so the UI never has a capability agents lack.
 */
export const api = new Hono<HonoEnv>()
  .use("*", async (c, next) => {
    c.set("principal", await authenticate(c.env, c.req.raw));
    await next();
  })
  .get("/me", async (c) => {
    const p = c.get("principal");
    return c.json({
      principal: p,
      user: await currentUser(c.env, c.req.raw),
      devMode: devMode(c.env),
      artifactsMode: c.env.ARTIFACTS_MODE === "local" || !c.env.ARTIFACTS ? "local" : "remote",
    });
  })

  // ── yards ──
  .get("/yards", async (c) => c.json(await svc.yardsList(c.env, c.get("principal"))))
  .post("/yards", zValidator("json", CreateYardInput), async (c) => c.json(await svc.yardCreate(c.env, c.get("principal"), c.req.valid("json")), 201))
  .get("/yards/:yard", zValidator("param", yardParam), async (c) => c.json(await svc.yardStatus(c.env, c.get("principal"), c.req.valid("param").yard)))
  .get("/yards/:yard/base", zValidator("param", yardParam), async (c) =>
    c.json(await svc.yardBaseLog(c.env, c.get("principal"), c.req.valid("param").yard)),
  )
  .get(
    "/yards/:yard/events",
    zValidator("param", yardParam),
    zValidator(
      "query",
      z.object({
        since: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        taskId: z.string().optional(),
        agentId: z.string().optional(),
        types: z.string().optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await svc.eventsSince(c.env, c.get("principal"), c.req.valid("param").yard, q.since, q.limit, {
          taskId: q.taskId,
          agentId: q.agentId,
          types: q.types?.split(",").filter(Boolean),
        }),
      );
    },
  )
  .get("/yards/:yard/latency", zValidator("param", yardParam), async (c) => c.json(await svc.latency(c.env, c.get("principal"), c.req.valid("param").yard)))
  .post("/yards/:yard/k2/poll", zValidator("param", yardParam), zValidator("json", z.object({ seconds: z.number().default(60) })), async (c) =>
    c.json(await svc.startK2Poll(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("json").seconds)),
  )

  // ── tasks ──
  .get("/yards/:yard/tasks", zValidator("param", yardParam), async (c) => c.json(await svc.taskList(c.env, c.get("principal"), c.req.valid("param").yard)))
  .post(
    "/yards/:yard/tasks",
    zValidator("param", yardParam),
    zValidator("query", z.object({ stream: z.string().optional() })),
    zValidator("json", CreateTaskInput),
    async (c) => {
      const p = c.get("principal");
      const yard = c.req.valid("param").yard;
      const res = await svc.taskCreate(c.env, p, yard, c.req.valid("json"));
      if (!c.req.valid("query").stream) return c.json(res, 201);
      // NDJSON: the task first, then each agent's workspace the moment its own fork is ready.
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const line = (o: unknown) => w.write(enc.encode(`${JSON.stringify(o)}\n`));
      c.executionCtx.waitUntil(
        (async () => {
          await line({ kind: "task", task: res.task, agents: res.agents, credentials: res.credentials });
          await Promise.all(
            res.agents.map(async (a) => {
              try {
                const ws: Workspace = await svc.workspaceGet(c.env, p, yard, res.task.id, a.id);
                await line({ kind: "workspace", agentId: a.id, workspace: ws, apiKey: res.credentials.find((k) => k.agentId === a.id)?.apiKey });
              } catch (err) {
                await line({ kind: "error", agentId: a.id, error: err instanceof Error ? err.message : String(err) });
              }
            }),
          );
          await w.close();
        })(),
      );
      return new Response(readable, { status: 201, headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
    },
  )
  .get("/yards/:yard/tasks/:task", zValidator("param", taskParam), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.taskGet(c.env, c.get("principal"), yard, task));
  })
  .post("/yards/:yard/tasks/:task/abandon", zValidator("param", taskParam), zValidator("json", z.object({ reason: z.string().default("abandoned") })), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.taskAbandon(c.env, c.get("principal"), yard, task, c.req.valid("json").reason));
  })
  .get("/yards/:yard/tasks/:task/compare", zValidator("param", taskParam), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.compareForks(c.env, c.get("principal"), yard, task));
  })
  .get(
    "/yards/:yard/tasks/:task/compare/file",
    zValidator("param", taskParam),
    zValidator("query", z.object({ path: z.string().min(1), agents: z.string().optional() })),
    async (c) => {
      const { yard, task } = c.req.valid("param");
      const q = c.req.valid("query");
      return c.json(await svc.compareFile(c.env, c.get("principal"), yard, task, q.path, q.agents?.split(",").filter(Boolean)));
    },
  )
  .get("/yards/:yard/tasks/:task/intents", zValidator("param", taskParam), zValidator("query", z.object({ agent: z.string().optional() })), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.intentsList(c.env, c.get("principal"), yard, task, c.req.valid("query").agent));
  })
  .post("/yards/:yard/tasks/:task/decide/preview", zValidator("param", taskParam), zValidator("json", DecideInput), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.decidePreview(c.env, c.get("principal"), yard, task, c.req.valid("json")));
  })
  .post("/yards/:yard/tasks/:task/decide", zValidator("param", taskParam), zValidator("json", DecideInput), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.decide(c.env, c.get("principal"), yard, task, c.req.valid("json")));
  })

  // ── agents ──
  .get("/yards/:yard/tasks/:task/agents/:agent/workspace", zValidator("param", agentParam), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.workspaceGet(c.env, c.get("principal"), yard, task, agent));
  })
  .post("/yards/:yard/tasks/:task/agents/:agent/claims", zValidator("param", agentParam), zValidator("json", ClaimInput), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.claimPaths(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }));
  })
  .post(
    "/yards/:yard/tasks/:task/agents/:agent/claims/release",
    zValidator("param", agentParam),
    zValidator("json", z.object({ paths: z.array(z.string()).optional() })),
    async (c) => {
      const { yard, task, agent } = c.req.valid("param");
      return c.json(await svc.releasePaths(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }));
    },
  )
  .post("/yards/:yard/tasks/:task/agents/:agent/intents", zValidator("param", agentParam), zValidator("json", IntentInput), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.intentRecord(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }), 201);
  })
  .get("/yards/:yard/tasks/:task/agents/:agent/diff", zValidator("param", agentParam), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.agentDiff(c.env, c.get("principal"), yard, task, agent));
  })
  .get("/yards/:yard/tasks/:task/agents/:agent/reviews", zValidator("param", agentParam), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.reviewGet(c.env, c.get("principal"), yard, task, agent));
  })

  // ── benchmarks ──
  .get("/bench", async (c) => c.json(await svc.benchList(c.env)))
  .post(
    "/bench/fork",
    zValidator("json", z.object({ yardId: z.string(), concurrency: z.number().int().min(1).max(100), label: z.string().optional() })),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(await svc.benchFork(c.env, c.get("principal"), b.yardId, b.concurrency, b.label));
    },
  )
  .post(
    "/bench/record",
    zValidator(
      "json",
      z.object({ kind: z.string(), label: z.string(), mode: z.string(), concurrency: z.number().int(), stats: z.record(z.string(), z.unknown()) }),
    ),
    async (c) => c.json(await svc.benchRecord(c.env, c.get("principal"), c.req.valid("json"))),
  )

  .post(
    "/admin/cleanup",
    zValidator(
      "json",
      z.object({
        ttlHours: z.number().min(0).default(24),
        abandonOpenOlderThanHours: z.number().min(0).optional(),
        sweepBench: z.boolean().default(true),
      }),
    ),
    async (c) => c.json(await svc.adminCleanup(c.env, c.get("principal"), c.req.valid("json"))),
  )

  // ── ingest: Artifacts events delivered over HTTP (manual replay / alternative transports) ──
  .post("/ingest/artifacts", async (c) => {
    if (c.get("principal").kind !== "admin") return c.json({ error: "admin only" }, 403);
    const ev = (await c.req.json()) as ArtifactsPushEvent;
    const params = await routeArtifactsEvent(c.env, ev, "queue", true);
    return c.json({ routed: !!params });
  });

export type ApiType = typeof api;
