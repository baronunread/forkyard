import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AskInput, ClaimInput, CreateTaskInput, CreateYardInput, DecideInput, describeEvent, IntentInput, ListFilesInput, MCP_TOOLS, PlanInput, PushFilesInput, ReadFilesInput } from "@forkyard/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { Principal } from "./auth";
import type { Env } from "./env";
import * as code from "./code";
import * as svc from "./service";

/**
 * MCP server for agents: streamable HTTP via `@hono/mcp`, mounted as a plain
 * Hono route so it shares the API's auth middleware. Stateless — live state
 * is in the Yard Durable Object — so each request gets a fresh server and a
 * session-less transport.
 *
 * With an agent key, yard/task/agent ids default to the key's scope, so a
 * coding agent can call `workspace_get` with no arguments.
 */

const desc = Object.fromEntries(MCP_TOOLS) as Record<(typeof MCP_TOOLS)[number][0], string>;

type Scope = { yardId?: string; taskId?: string; agentId?: string };
const scope = {
  yardId: z.string().optional().describe("Yard id (defaults to your key's yard)"),
  taskId: z.string().optional().describe("Task id (defaults to your key's task)"),
};

function resolve(p: Principal, s: Scope, needTask = true): { yardId: string; taskId: string; agentId?: string } {
  const yardId = s.yardId ?? (p.kind === "agent" ? p.yardId : undefined);
  const taskId = s.taskId ?? (p.kind === "agent" ? p.taskId : undefined);
  if (!yardId) throw new svc.ServiceError(400, "yardId is required");
  if (needTask && !taskId) throw new svc.ServiceError(400, "taskId is required");
  return { yardId, taskId: taskId ?? "", agentId: s.agentId ?? (p.kind === "agent" ? p.agentId : undefined) };
}

function ok(data: unknown, text?: string) {
  return { content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function fail(err: unknown) {
  const e = svc.toServiceError(err);
  return { isError: true, content: [{ type: "text" as const, text: `${e.status}: ${e.message}` }] };
}

export function buildMcpServer(env: Env, p: Principal, origin: string): McpServer {
  /** Every answer to an agent seat also carries what changed around it since its last call. */
  const wrap =
    <A,>(fn: (args: A) => Promise<ReturnType<typeof ok>>) =>
    async (args: A) => {
      try {
        const res = await fn(args);
        if (p.kind !== "agent") return res;
        const notes = await svc.agentNotes(env, p.yardId, p.taskId, p.agentId).catch(() => []);
        if (notes.length) res.content.push({ type: "text", text: `Since your last call:\n${notes.map((n) => `⚠ ${n}`).join("\n")}` });
        return res;
      } catch (err) {
        return fail(err);
      }
    };
  const server = new McpServer(
    { name: "forkyard", version: "0.1.0" },
    {
      instructions: `Forkyard: agent-native Git on Cloudflare. Start with workspace_get, plan before editing, then read_files / push_files to work in your fork (no git credentials needed). Work on your own; ask_human only when truly blocked. Docs: ${origin}/llms.txt`,
    },
  );

  server.registerTool(
    "yard_list",
    { description: desc.yard_list, inputSchema: z.object({}) },
    wrap(async () => ok({ yards: await svc.yardsList(env, p) })),
  );

  server.registerTool(
    "yard_create",
    { description: desc.yard_create, inputSchema: CreateYardInput },
    wrap(async (a) => ok(await svc.yardCreate(env, p, a, origin))),
  );

  server.registerTool(
    "code_why",
    {
      description: desc.code_why,
      inputSchema: z.object({
        yardId: scope.yardId,
        path: z.string().min(1).describe("File path on the base, e.g. src/todos.ts"),
        from: z.number().int().min(1).optional().describe("First line (1-based)"),
        to: z.number().int().min(1).optional().describe("Last line (1-based)"),
      }),
    },
    wrap(async (a) => {
      const { yardId } = resolve(p, a, false);
      const r = await code.codeWhy(env, p, yardId, a.path.replace(/^\/+/, ""));
      const from = (a.from ?? 1) - 1;
      const to = a.to ?? r.lines;
      return ok({ ...r, spans: r.spans.filter((s) => s.end > from && s.start < to).map((s) => ({ ...s, lines: `${s.start + 1}-${s.end}` })) });
    }),
  );

  server.registerTool(
    "yard_status",
    { description: desc.yard_status, inputSchema: z.object({ yardId: scope.yardId, since: z.number().int().min(0).optional() }) },
    wrap(async (a) => {
      const { yardId } = resolve(p, a, false);
      const st = await svc.yardStatus(env, p, yardId);
      const lines = st.recent.map((e) => `#${e.seq} ${describeEvent(e, (id) => st.agents.find((x) => x.id === id)?.name ?? id ?? "?")}`);
      return ok(
        {
          yard: st.yard,
          head: st.head,
          tasks: st.tasks.filter((t) => t.status === "open"),
          agents: st.agents.map((x) => ({ id: x.id, taskId: x.taskId, name: x.name, harness: x.harness, status: x.status, headCommit: x.headCommit })),
          claims: st.claims,
          overlaps: st.overlaps,
          recent: lines,
        },
        undefined,
      );
    }),
  );

  server.registerTool(
    "task_create",
    {
      description: `${desc.task_create} Requires an admin key. Returns per-agent API keys once — hand each to its agent.`,
      inputSchema: CreateTaskInput.extend({ yardId: z.string() }),
    },
    wrap(async (a) => {
      const { yardId, ...input } = a;
      return ok(await svc.taskCreate(env, p, yardId, input));
    }),
  );

  server.registerTool(
    "workspace_get",
    { description: desc.workspace_get, inputSchema: z.object({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const ws = await svc.workspaceGet(env, p, s.yardId, s.taskId, s.agentId);
      return ok(
        ws,
        [
          `# Workspace for ${ws.agent.name} on "${ws.task.title}"`,
          `\n## Task brief\n${ws.task.brief || "(none)"}`,
          `\n## Git\nremote: ${ws.git.remote}\nbranch: ${ws.git.branch}\ntoken: ${ws.git.token}${ws.git.tokenExpiresAt ? ` (expires ${ws.git.tokenExpiresAt})` : ""}\nclone: ${ws.git.cloneCommand}`,
          `\n## What others are doing\n${ws.digest}`,
          `\n## AGENTS.md\n${ws.agentsMd}`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "claim_paths",
    { description: desc.claim_paths, inputSchema: ClaimInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const r = await svc.claimPaths(env, p, s.yardId, s.taskId, { paths: a.paths, agentId: s.agentId });
      const warn = r.notes.length ? `\n\n${r.notes.map((n) => `⚠ ${n}`).join("\n")}` : "\n\nNo overlaps.";
      return ok(r, `Claimed: ${r.claims.map((c) => c.pattern).join(", ")}${warn}`);
    }),
  );

  server.registerTool(
    "release_paths",
    { description: desc.release_paths, inputSchema: z.object({ ...scope, agentId: z.string().optional(), paths: z.array(z.string()).optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      return ok(await svc.releasePaths(env, p, s.yardId, s.taskId, { paths: a.paths, agentId: s.agentId }));
    }),
  );

  server.registerTool(
    "plan",
    { description: desc.plan, inputSchema: PlanInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const r = await svc.planRecord(env, p, s.yardId, s.taskId, { summary: a.summary, why: a.why, details: a.details, files: a.files, agentId: s.agentId });
      const warn = r.notes.length ? `${r.notes.map((n) => `⚠ ${n}`).join("\n")}` : "Nobody else plans to touch these files.";
      return ok(r, `Plan recorded: ${r.intent.summary}\nFiles: ${r.claims.map((c) => c.pattern).join(", ")}\n\n${warn}`);
    }),
  );

  server.registerTool(
    "intent_record",
    { description: desc.intent_record, inputSchema: IntentInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const intent = await svc.intentRecord(env, p, s.yardId, s.taskId, { summary: a.summary, why: a.why, details: a.details, agentId: s.agentId });
      return ok(intent, `Recorded intent ${intent.id}. It will be attached to your next push. Also commit it as .forkyard/intent.md.`);
    }),
  );

  server.registerTool(
    "list_files",
    { description: desc.list_files, inputSchema: ListFilesInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      return ok(await svc.forkList(env, p, s.yardId, s.taskId, { prefix: a.prefix, agentId: s.agentId }));
    }),
  );

  server.registerTool(
    "read_files",
    { description: desc.read_files, inputSchema: ReadFilesInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      return ok(await svc.forkRead(env, p, s.yardId, s.taskId, { paths: a.paths, agentId: s.agentId }));
    }),
  );

  server.registerTool(
    "push_files",
    { description: desc.push_files, inputSchema: PushFilesInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const r = await svc.forkPush(env, p, s.yardId, s.taskId, { message: a.message, files: a.files, agentId: s.agentId });
      return ok(r, `Pushed ${r.commit.slice(0, 7)} (${r.files} file${r.files === 1 ? "" : "s"}). It will be reviewed.`);
    }),
  );

  server.registerTool(
    "events_since",
    {
      description: desc.events_since,
      inputSchema: z.object({
        yardId: scope.yardId,
        since: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        taskId: z.string().optional(),
        agentId: z.string().optional(),
        types: z.array(z.string()).optional(),
      }),
    },
    wrap(async (a) => {
      const { yardId } = resolve(p, a, false);
      const r = await svc.eventsSince(env, p, yardId, a.since, a.limit, { taskId: a.taskId, agentId: a.agentId, types: a.types });
      return ok(r, `${r.events.map((e) => `#${e.seq} ${describeEvent(e)}`).join("\n")}\n\nnext: ${r.next} head: ${r.head}`);
    }),
  );

  server.registerTool(
    "compare_forks",
    { description: desc.compare_forks, inputSchema: z.object({ ...scope, path: z.string().optional().describe("Return per-agent versions and hunks of this file") }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      if (a.path) return ok(await svc.compareFile(env, p, s.yardId, s.taskId, a.path));
      const r = await svc.compareForks(env, p, s.yardId, s.taskId);
      const text = [
        `Task ${r.task.title} (base ${r.baseCommit.slice(0, 7)})`,
        ...r.agents.map(
          (x) =>
            `- ${x.agent.name} [${x.agent.status}] score=${x.review?.score ?? "–"} +${x.additions} −${x.deletions} files=${x.files.length}` +
            (x.intent ? ` — ${x.intent.summary}` : ""),
        ),
        "Files:",
        ...r.files.map((f) => `  ${f.overlap ? "⚠" : " "} ${f.path}: ${f.agents.map((g) => `${g.agentId}(${g.status[0]} +${g.additions}/−${g.deletions})`).join(", ")}`),
      ].join("\n");
      return ok(r, text);
    }),
  );

  server.registerTool(
    "review_get",
    { description: desc.review_get, inputSchema: z.object({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      if (!s.agentId) throw new svc.ServiceError(400, "agentId is required");
      return ok({ reviews: await svc.reviewGet(env, p, s.yardId, s.taskId, s.agentId) });
    }),
  );

  server.registerTool(
    "ask_human",
    { description: desc.ask_human, inputSchema: AskInput.extend({ ...scope, agentId: z.string().optional() }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      const ask = await svc.askCreate(env, p, s.yardId, s.taskId, { question: a.question, context: a.context, options: a.options, agentId: s.agentId });
      return ok(ask, `Asked a person (${ask.id}). Keep working on anything that doesn't depend on the answer; it arrives as an ask.answered event, or call ask_status.`);
    }),
  );

  server.registerTool(
    "ask_status",
    { description: desc.ask_status, inputSchema: z.object({ yardId: scope.yardId, askId: z.string() }) },
    wrap(async (a) => {
      const { yardId } = resolve(p, a, false);
      const ask = await svc.askGet(env, p, yardId, a.askId);
      return ok(ask, ask.status === "open" ? "Not answered yet." : `Answered by ${ask.answeredBy}: ${ask.answer}`);
    }),
  );

  const decideSchema = z.object({
    ...scope,
    mode: z.enum(["winner", "assemble"]),
    winnerAgentId: z.string().optional(),
    selections: z.array(z.object({ path: z.string(), agentId: z.string(), hunkIds: z.array(z.string()).optional() })).optional(),
    message: z.string().optional(),
  });
  const toDecide = (a: z.infer<typeof decideSchema>) =>
    DecideInput.parse(a.mode === "winner" ? { mode: "winner", winnerAgentId: a.winnerAgentId, message: a.message } : { mode: "assemble", selections: a.selections, message: a.message });

  server.registerTool(
    "decide_preview",
    { description: desc.decide_preview, inputSchema: decideSchema },
    wrap(async (a) => {
      const s = resolve(p, a);
      return ok(await svc.decidePreview(env, p, s.yardId, s.taskId, toDecide(a)));
    }),
  );

  server.registerTool(
    "decide",
    { description: `${desc.decide} Pick a winner (mode=winner) or assemble hunks from several forks (mode=assemble).`, inputSchema: decideSchema },
    wrap(async (a) => {
      const s = resolve(p, a);
      const r = await svc.decide(env, p, s.yardId, s.taskId, toDecide(a));
      return ok(r, `Applied → ${r.decision.resultCommit}. ${r.preview.files.length} file(s) changed on the base branch.`);
    }),
  );

  server.registerTool(
    "task_abandon",
    { description: desc.task_abandon, inputSchema: z.object({ ...scope, reason: z.string().default("abandoned") }) },
    wrap(async (a) => {
      const s = resolve(p, a);
      return ok(await svc.taskAbandon(env, p, s.yardId, s.taskId, a.reason));
    }),
  );

  server.registerTool(
    "bench_fork",
    {
      description: desc.bench_fork,
      inputSchema: z.object({ yardId: scope.yardId, concurrency: z.number().int().min(1).max(100).default(5), label: z.string().optional() }),
    },
    wrap(async (a) => {
      const { yardId } = resolve(p, a, false);
      const r = await svc.benchFork(env, p, yardId, a.concurrency, a.label);
      return ok(r, `forked ×${r.concurrency}: p50 ${r.stats.p50} ms, p95 ${r.stats.p95} ms, p99 ${r.stats.p99} ms (${r.stats.failures} failures)`);
    }),
  );

  return server;
}

export async function handleMcp(c: Context<{ Bindings: Env; Variables: { principal: Principal } }>): Promise<Response> {
  const server = buildMcpServer(c.env, c.get("principal"), new URL(c.req.url).origin);
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 202);
}
