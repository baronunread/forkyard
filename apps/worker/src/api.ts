import { zValidator } from "@hono/zod-validator";
import {
  AnswerInput,
  AskInput,
  ClaimInput,
  PlanInput,
  CreateTaskInput,
  FileBacklogInput,
  ImportIssuesInput,
  StartBacklogInput,
  CreateYardInput,
  Slug,
  DecideInput,
  IntentInput,
  type Workspace,
} from "@forkyard/shared";
import { Hono } from "hono";
import { z } from "zod";
import { assertPerson, AuthError, authenticate, devMode, isMember, type Principal } from "./auth";
import { githubAccessToken, ME, origin, recordSeatChoice, sessionFor } from "./better-auth";
import * as chatgpt from "./chatgpt";
import type { Env } from "./env";
import { routeArtifactsEvent, type ArtifactsPushEvent } from "./review";
import * as backlog from "./backlog";
import * as code from "./code";
import { limitsReport } from "./limits";
import * as svc from "./service";

export type HonoEnv = { Bindings: Env; Variables: { principal: Principal } };

const yardParam = z.object({ yard: z.string() });
const taskParam = z.object({ yard: z.string(), task: z.string() });
const agentParam = z.object({ yard: z.string(), task: z.string(), agent: z.string() });

/**
 * REST API. Every route maps 1:1 to a service function that the MCP server
 * also exposes, so the UI never has a capability agents lack.
 */
const githubTokenOf = (env: Env, p: Principal, req: Request) => (p.kind === "user" ? githubAccessToken(env, origin(env, req), p.userId) : Promise.resolve(null));

export const api = new Hono<HonoEnv>()
  .use("*", async (c, next) => {
    c.set("principal", await authenticate(c.env, c.req.raw));
    await next();
  })
  .get("/me", async (c) => {
    const session = await sessionFor(c.env, origin(c.env, c.req.raw), c.req.raw.headers);
    const u = session?.user;
    return c.json({
      principal: c.get("principal"),
      user: u ? { id: u.id, name: u.name, email: u.email, image: u.image ?? null } : null,
      devMode: devMode(c.env),
      artifactsMode: c.env.ARTIFACTS_MODE === "local" || !c.env.ARTIFACTS ? "local" : "remote",
    });
  })

  // Your public GitHub repos, for "import a repo" when creating a yard. ponytail: public only until
  // sign-in asks for the repo scope (#14).
  .get("/me/github/repos", async (c) => {
    const token = await githubTokenOf(c.env, c.get("principal"), c.req.raw);
    if (!token) return c.json({ connected: false, repos: [] });
    const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=pushed&visibility=public", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "forkyard", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) return c.json({ connected: true, repos: [] });
    const repos = (await res.json()) as { full_name: string; name: string; clone_url: string; description: string | null; pushed_at: string; private: boolean }[];
    return c.json({
      connected: true,
      repos: repos.filter((r) => !r.private).map((r) => ({ fullName: r.full_name, name: r.name, cloneUrl: r.clone_url, description: r.description, pushedAt: r.pushed_at })),
    });
  })
  // Is this yard name free? (The create call checks again.)
  .get("/yard-names", zValidator("query", z.object({ name: z.string().max(80).default("") })), async (c) =>
    c.json(await svc.yardNameCheck(c.env, c.get("principal"), origin(c.env, c.req.raw), c.req.valid("query").name)),
  )
  .get("/me/limits", async (c) => c.json(await limitsReport(c.env, c.get("principal"))))

  // ── your own model subscription (ChatGPT, through pi-ai), used for reviews in yards you own ──
  .get("/me/models/chatgpt", async (c) => c.json(await chatgpt.status(c.env, await personOf(c.env, c.req.raw))))
  .post("/me/models/chatgpt/device", async (c) => c.json(await chatgpt.startDeviceLogin(c.env, await personOf(c.env, c.req.raw))))
  .post("/me/models/chatgpt/device/poll", async (c) => c.json(await chatgpt.pollDeviceLogin(c.env, await personOf(c.env, c.req.raw))))
  .post("/me/models/chatgpt/paste", zValidator("json", z.object({ credential: z.string().min(2).max(20_000) })), async (c) => {
    const user = await personOf(c.env, c.req.raw);
    await chatgpt.save(c.env, user, chatgpt.parsePastedCredential(c.req.valid("json").credential));
    return c.json(await chatgpt.status(c.env, user));
  })
  .put("/me/models/chatgpt", zValidator("json", z.object({ useForReviews: z.boolean().optional(), model: z.string().max(100).optional(), reviewModel: z.string().max(100).optional() })), async (c) => {
    const user = await personOf(c.env, c.req.raw);
    await chatgpt.setPrefs(c.env, user, c.req.valid("json"));
    return c.json(await chatgpt.status(c.env, user));
  })
  .delete("/me/models/chatgpt", async (c) => {
    const user = await personOf(c.env, c.req.raw);
    await chatgpt.disconnect(c.env, user);
    return c.json(await chatgpt.status(c.env, user));
  })

  // ── /connect: what an agent being authorized over OAuth will act as ──
  .get("/connect/seats", async (c) => c.json({ seats: await seatsFor(c.env, await personOf(c.env, c.req.raw)) }))
  .post("/connect/seat", zValidator("json", z.object({ clientId: z.string().min(1), seat: z.string().min(1) })), async (c) => {
    const { clientId, seat } = c.req.valid("json");
    const session = await sessionFor(c.env, origin(c.env, c.req.raw), c.req.raw.headers);
    if (!session) throw new AuthError("sign in required", 401);
    if (seat !== ME && !(await seatsFor(c.env, session.user.id)).some((s) => s.value === seat)) throw new AuthError("that agent seat is not yours to grant", 403);
    await recordSeatChoice(c.env, session.session.id, clientId, seat);
    return c.json({ ok: true });
  })

  // ── yards ──
  .get("/inbox", async (c) => c.json(await svc.inbox(c.env, c.get("principal"))))
  .get("/yards", async (c) => c.json(await svc.yardsList(c.env, c.get("principal"))))
  .post("/yards", zValidator("json", CreateYardInput), async (c) => c.json(await svc.yardCreate(c.env, c.get("principal"), c.req.valid("json"), origin(c.env, c.req.raw)), 201))
  .get("/yards/:yard", zValidator("param", yardParam), async (c) => c.json(await svc.yardStatus(c.env, c.get("principal"), c.req.valid("param").yard)))
  .delete("/yards/:yard", zValidator("param", yardParam), async (c) => c.json(await svc.yardDelete(c.env, c.get("principal"), c.req.valid("param").yard)))
  // The base repo as people read it: folders, files, and the log with each change's task.
  .get("/yards/:yard/code/tree", zValidator("param", yardParam), zValidator("query", z.object({ path: z.string().max(1000).default("") })), async (c) =>
    c.json(await code.codeTree(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("query").path.replace(/^\/+|\/+$/g, ""))),
  )
  .get("/yards/:yard/code/file", zValidator("param", yardParam), zValidator("query", z.object({ path: z.string().min(1).max(1000) })), async (c) =>
    c.json(await code.codeFile(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("query").path.replace(/^\/+/, ""))),
  )
  .get("/yards/:yard/code/why", zValidator("param", yardParam), zValidator("query", z.object({ path: z.string().min(1).max(1000) })), async (c) =>
    c.json(await code.codeWhy(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("query").path.replace(/^\/+/, ""))),
  )
  .get("/yards/:yard/code/log", zValidator("param", yardParam), async (c) => c.json(await code.codeLog(c.env, c.get("principal"), c.req.valid("param").yard)))
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

  // ── backlog: tasks that haven't started ──
  .get("/yards/:yard/backlog", zValidator("param", yardParam), async (c) => c.json(await backlog.backlogList(c.env, c.get("principal"), c.req.valid("param").yard)))
  .post("/yards/:yard/backlog", zValidator("param", yardParam), zValidator("json", FileBacklogInput), async (c) =>
    c.json(await backlog.backlogFile(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("json")), 201),
  )
  .post("/yards/:yard/backlog/import/github", zValidator("param", yardParam), zValidator("json", ImportIssuesInput), async (c) =>
    c.json(
      await backlog.backlogImportGithub(c.env, c.get("principal"), c.req.valid("param").yard, c.req.valid("json").repo, await githubTokenOf(c.env, c.get("principal"), c.req.raw)),
    ),
  )
  .get("/yards/:yard/backlog/:item", zValidator("param", z.object({ yard: z.string(), item: z.string() })), async (c) => {
    const { yard, item } = c.req.valid("param");
    return c.json(await backlog.backlogGet(c.env, c.get("principal"), yard, item));
  })
  .post("/yards/:yard/backlog/:item/start", zValidator("param", z.object({ yard: z.string(), item: z.string() })), zValidator("json", StartBacklogInput), async (c) => {
    const { yard, item } = c.req.valid("param");
    return c.json(await backlog.backlogStart(c.env, c.get("principal"), yard, item, c.req.valid("json")), 201);
  })

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
  .post("/yards/:yard/asks/:ask/answer", zValidator("param", z.object({ yard: z.string(), ask: z.string() })), zValidator("json", AnswerInput), async (c) => {
    const { yard, ask } = c.req.valid("param");
    return c.json(await svc.askAnswer(c.env, c.get("principal"), yard, ask, c.req.valid("json")));
  })
  .post("/yards/:yard/tasks/:task/autopilot", zValidator("param", taskParam), zValidator("json", z.object({ on: z.boolean() })), async (c) => {
    const { yard, task } = c.req.valid("param");
    return c.json(await svc.setAutopilot(c.env, c.get("principal"), yard, task, c.req.valid("json").on));
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
  .post("/yards/:yard/tasks/:task/agents/:agent/plan", zValidator("param", agentParam), zValidator("json", PlanInput), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.planRecord(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }), 201);
  })
  .post("/yards/:yard/tasks/:task/agents/:agent/intents", zValidator("param", agentParam), zValidator("json", IntentInput), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.intentRecord(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }), 201);
  })
  .post("/yards/:yard/tasks/:task/agents/:agent/asks", zValidator("param", agentParam), zValidator("json", AskInput), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.askCreate(c.env, c.get("principal"), yard, task, { ...c.req.valid("json"), agentId: agent }), 201);
  })
  .get("/yards/:yard/asks/:ask", zValidator("param", z.object({ yard: z.string(), ask: z.string() })), async (c) => {
    const { yard, ask } = c.req.valid("param");
    return c.json(await svc.askGet(c.env, c.get("principal"), yard, ask));
  })
  .get("/yards/:yard/tasks/:task/agents/:agent/transcript", zValidator("param", agentParam), async (c) => {
    const { yard, task, agent } = c.req.valid("param");
    return c.json(await svc.agentTranscript(c.env, c.get("principal"), yard, task, agent));
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

async function personOf(env: Env, req: Request): Promise<string> {
  const session = await sessionFor(env, origin(env, req), req.headers);
  if (!session) throw new AuthError("sign in required", 401);
  return session.user.id;
}

export interface Seat {
  value: string;
  yard: string;
  task: string;
  agent: { id: string; name: string; color: string; initials: string };
  role: string;
}

/** Open agent seats in the person's yards, newest task first. */
async function seatsFor(env: Env, userId: string): Promise<Seat[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.yard_id, a.task_id, a.id, a.name, a.role, a.color, a.initials, t.title, y.name AS yard_name FROM agents a
     JOIN tasks t ON t.yard_id = a.yard_id AND t.id = a.task_id
     JOIN yards y ON y.id = a.yard_id
     WHERE t.status = 'open' AND a.status NOT IN ('failed', 'retired')
     ORDER BY t.created_at DESC, a.created_at LIMIT 200`,
  ).all<{ yard_id: string; task_id: string; id: string; name: string; role: string; color: string; initials: string; title: string; yard_name: string }>();
  const allowed = await Promise.all(results.map((r) => isMember(env, userId, r.yard_id)));
  return results
    .filter((_, i) => allowed[i])
    .map((r) => ({
      value: `${r.yard_id}/${r.task_id}/${r.id}`,
      yard: r.yard_name,
      task: r.title,
      agent: { id: r.id, name: r.name, color: r.color, initials: r.initials },
      role: r.role,
    }));
}
