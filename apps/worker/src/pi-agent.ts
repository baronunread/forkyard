import { AGENTS_MD_TEMPLATE } from "@forkyard/shared";
import type { AssistantMessage, Credential, CredentialStore, TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { disposeRepo, getArtifacts, treeReader } from "./artifacts";
import * as chatgpt from "./chatgpt";
import { getAgent, getTask, getYard } from "./db";
import { readPathAt, treeChanges, commitTree } from "./diff";
import type { Env } from "./env";
import { buildCommit, type FileChange } from "./git/build";
import { limits, spendWorkersAi } from "./limits";
import { yardStub } from "./yard";

/**
 * A cloud agent: Pi Durable running in its own Durable Object (Agents SDK `PiHarness`),
 * working one seat on one task. Its tools are Forkyard's: read and write files in its fork,
 * claim paths, record intent, push, and ask a person. Every step is committed before it's
 * shown, so an eviction mid-run resumes where it stopped.
 *
 * Models, first available:
 *  - the task owner's ChatGPT plan (Pi's Codex provider; they connect it in the account menu);
 *  - Workers AI (`PI_AGENT_MODEL`, default @cf/moonshotai/kimi-k2.7-code);
 *  - locally, a scripted model that does a small, real piece of work, so the loop runs offline.
 *
 * Local agents (Claude Code, Codex CLI, …) join the same task over MCP; both kinds compete.
 */

export interface PiAgentSeat {
  yardId: string;
  taskId: string;
  agentId: string;
  /** Whose model subscription the agent runs on. */
  ownerUserId: string | null;
}

const RUN = "task";
const CHECK_SECONDS = 15;
const WORKERS_AI_DEFAULT = "@cf/moonshotai/kimi-k2.7-code";

const Path = Type.Object({ path: Type.String({ description: "File path from the repo root, no leading slash" }) });
const Write = Type.Object({ path: Type.String(), content: Type.String({ description: "The whole new file content" }) });
const List = Type.Object({ prefix: Type.Optional(Type.String({ description: "Only paths starting with this" })) });
const Claim = Type.Object({ paths: Type.Array(Type.String(), { description: "Files or globs you will change" }) });
const Intent = Type.Object({ summary: Type.String(), why: Type.String() });
const Plan = Type.Object({ summary: Type.String(), why: Type.String(), files: Type.Array(Type.String(), { description: "Files or globs you expect to change" }) });
const Push = Type.Object({ message: Type.String({ description: "Commit message" }) });
const Ask = Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) });

export class PiAgent extends Agent<Env> {
  registry = createRegistry();
  scripted = fauxProvider({ provider: "scripted", models: [{ id: "demo" }] });

  harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.registry.install({ name: "forkyard", sections: [{ key: "forkyard", render: () => this.instructions(), tag: false }], tools: this.tools() });
      const models = createModels({ credentials: this.credentials() });
      models.setProvider(chatgpt.codexProviderSync());
      if (this.env.AI) models.setProvider(createAI({ binding: this.env.AI }).provider);
      models.setProvider(this.scripted.provider);
      this.scripted.setResponses(Array.from({ length: 12 }, () => scriptedStep));
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seat (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS staged (path TEXT PRIMARY KEY, content TEXT)");
  }

  // ── the seat ───────────────────────────────────────────────────────────────

  /** The seat's yard Durable Object, in the yard's own jurisdiction. */
  private async yardOf(seat: PiAgentSeat) {
    return yardStub(this.env, (await getYard(this.env.DB, seat.yardId)) ?? { id: seat.yardId, jurisdiction: "default" });
  }

  private seat(): PiAgentSeat {
    const row = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM seat WHERE k = 'seat'").toArray()[0];
    if (!row) throw new Error("this cloud agent has no seat yet");
    return JSON.parse(row.v) as PiAgentSeat;
  }

  /** Take the seat and start working. Idempotent: a second call doesn't start a second run. */
  async start(seat: PiAgentSeat): Promise<{ model: string }> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO seat (k, v) VALUES ('seat', ?)", JSON.stringify(seat));
    const model = await this.pickModel(seat);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO seat (k, v) VALUES ('provider', ?)", model.provider);
    await this.harness.session().setModel(model);
    const task = await getTask(this.env.DB, seat.yardId, seat.taskId);
    await this.harness.submit(
      `Your task: ${task?.title ?? seat.taskId}\n\n${task?.brief || "(no brief)"}\n\nLook around the repo, claim what you'll change, record your intent, make the change, and push. Then say in one line what you did.`,
      { operationId: RUN },
    );
    await this.schedule(CHECK_SECONDS, "checkRun");
    await (await this.yardOf(seat)).agentNote(seat.taskId, seat.agentId, null, `cloud agent started on ${model.provider}/${model.id}`);
    return { model: `${model.provider}/${model.id}` };
  }

  private async pickModel(seat: PiAgentSeat): Promise<{ provider: string; id: string }> {
    if (seat.ownerUserId && (await chatgpt.status(this.env, seat.ownerUserId)).connected) return { provider: chatgpt.CHATGPT, id: chatgpt.chatgptModel(this.env) };
    if (this.env.AI) return { provider: "cloudflare", id: this.env.PI_AGENT_MODEL || WORKERS_AI_DEFAULT };
    return { provider: "scripted", id: "demo" };
  }

  /** The owner's ChatGPT credential, fresh, for Pi's Codex provider. Refresh is serialized in D1. */
  private credentials(): CredentialStore {
    const read = async (id: string): Promise<Credential | undefined> => {
      if (id !== chatgpt.CHATGPT) return undefined;
      const owner = this.seat().ownerUserId;
      return owner ? ((await chatgpt.freshCredential(this.env, owner)) ?? undefined) : undefined;
    };
    return {
      read,
      list: async () => [],
      modify: async (id, fn) => fn(await read(id)),
      delete: async () => undefined,
    };
  }

  /** Report how the run ended; keep checking while it's going. */
  async checkRun() {
    if ((await this.harness.pending()).length) {
      await this.schedule(CHECK_SECONDS, "checkRun");
      return;
    }
    const r = await this.harness.wait(RUN);
    const seat = this.seat();
    const yard = await this.yardOf(seat);
    if (r.status === "done") await yard.agentNote(seat.taskId, seat.agentId, null, `cloud agent finished: ${(r.text ?? "").slice(0, 200) || "done"}`);
    else await yard.agentNote(seat.taskId, seat.agentId, "failed", `cloud agent stopped: ${r.reason ?? "unknown"}`);
  }

  /** A person answered this agent's question: hand it to the running work, or start a follow-up. */
  async deliver(question: string, answer: string) {
    await this.harness.submit(`A person answered your question "${question}": ${answer}`, { whenBusy: "steer" });
    await this.schedule(CHECK_SECONDS, "checkRun");
  }

  /** The agent's transcript, compact, for the UI. */
  async transcript(): Promise<{ kind: string; text: string }[]> {
    const entries = (await this.harness.messages()) as unknown as { kind: string; model?: { role: string; content?: unknown; toolName?: string }[] }[];
    return entries.flatMap((e) =>
      (e.model ?? []).map((m) => ({
        kind: e.kind,
        text:
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((c: { type: string; text?: string; name?: string; arguments?: unknown }) => (c.type === "text" ? c.text : c.type === "toolCall" ? `→ ${c.name}(${JSON.stringify(c.arguments).slice(0, 160)})` : "")).join(" ")
              : "",
      })),
    );
  }

  // ── what the agent is told ────────────────────────────────────────────────

  private instructions(): string {
    return [
      "You are a cloud agent in Forkyard, working alone in your own fork of the repo. Other agents attempt the same task in their forks; the best-reviewed fork is merged automatically.",
      "You have no shell: use the tools to list, read and write files, then push. Writes are staged until you push.",
      "Plan before you edit: call plan with what you'll do, why, and the files you expect to touch. If another agent plans the same files, adjust. Keep the change focused, and push when it's done.",
      "Only call ask_human when you are truly blocked on something a person must decide; otherwise decide yourself.",
      AGENTS_MD_TEMPLATE,
    ].join("\n\n");
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  /**
   * Hard limits per turn: LIMIT_AGENT_TURNS tool calls per agent, and each turn on Workers AI
   * spends one call of today's LIMIT_WORKERS_AI_PER_DAY. Past either, the run is aborted.
   * ponytail: counts tool calls, not model calls; a reply with no tool call ends the run anyway.
   */
  private metered<A extends unknown[], R>(execute: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      this.ctx.storage.sql.exec("INSERT INTO seat (k, v) VALUES ('turns', '1') ON CONFLICT (k) DO UPDATE SET v = CAST(v AS INTEGER) + 1");
      const turns = Number(this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM seat WHERE k = 'turns'").one().v);
      const provider = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM seat WHERE k = 'provider'").toArray()[0]?.v;
      const over =
        turns > limits(this.env).agentTurns
          ? `turn limit reached (${limits(this.env).agentTurns})`
          : provider === "cloudflare" && !(await spendWorkersAi(this.env))
            ? "today's Workers AI budget is spent"
            : limits(this.env).paused
              ? "Forkyard is paused"
              : null;
      if (over) {
        this.ctx.waitUntil(this.harness.session().abort());
        throw new Error(`Stopped: ${over}.`);
      }
      const res = await execute(...args);
      // Overlaps other agents started since the last call arrive with the next tool result.
      const out = res as { content?: { type: string; text: string }[] };
      const seat = this.seat();
      const notes = Array.isArray(out?.content) ? await (await this.yardOf(seat)).takeNotes(seat.taskId, seat.agentId) : [];
      if (notes.length) out.content!.push({ type: "text", text: `Since your last call:\n${notes.join("\n")}` });
      return res;
    };
  }

  private async fork() {
    const seat = this.seat();
    const [yard, agent] = await Promise.all([getYard(this.env.DB, seat.yardId), getAgent(this.env.DB, seat.yardId, seat.taskId, seat.agentId)]);
    if (!yard || !agent) throw new Error("seat not found");
    const artifacts = getArtifacts(this.env, yard.jurisdiction);
    const repo = await artifacts.get(agent.forkName);
    const [head] = await repo.log({ ref: yard.defaultBranch, limit: 1 });
    if (!head) throw new Error("fork has no commits");
    return { seat, yard, agent, artifacts, repo, head };
  }

  private staged(): Map<string, string | null> {
    return new Map(this.ctx.storage.sql.exec<{ path: string; content: string | null }>("SELECT path, content FROM staged").toArray().map((r) => [r.path, r.content]));
  }

  private tools(): ToolRegistration[] {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    const list: ToolRegistration<typeof List> = {
      name: "list_files",
      description: "List the files in your fork (including your staged, unpushed writes).",
      parameters: List,
      replay: "safe",
      execute: async ({ prefix }) => {
        const { repo, head } = await this.fork();
        try {
          const files = new Set((await treeChanges(repo, null, await commitTree(repo, head.hash))).map((c) => c.path));
          for (const [p, c] of this.staged()) c === null ? files.delete(p) : files.add(p);
          const shown = [...files].filter((p) => !prefix || p.startsWith(prefix)).sort();
          return text(shown.slice(0, 500).join("\n") + (shown.length > 500 ? `\n… ${shown.length - 500} more` : ""));
        } finally {
          disposeRepo(repo);
        }
      },
    };
    const read: ToolRegistration<typeof Path> = {
      name: "read_file",
      description: "Read a file from your fork (your staged version if you wrote one).",
      parameters: Path,
      replay: "safe",
      execute: async ({ path }) => {
        const s = this.staged();
        if (s.has(path)) return text(s.get(path) ?? `${path} is deleted in your staged changes`);
        const { repo, head } = await this.fork();
        try {
          const f = await readPathAt(repo, head.hash, path);
          if (!f.exists) throw new Error(`${path} does not exist`);
          return text(f.binary ? `${path} is binary` : (f.text ?? ""));
        } finally {
          disposeRepo(repo);
        }
      },
    };
    const write: ToolRegistration<typeof Write> = {
      name: "write_file",
      description: "Write a whole file (staged until you push).",
      parameters: Write,
      replay: "safe",
      execute: async ({ path, content }) => {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO staged (path, content) VALUES (?, ?)", path.replace(/^\/+/, ""), content);
        return text(`staged ${path} (${content.length} chars)`);
      },
    };
    const del: ToolRegistration<typeof Path> = {
      name: "delete_file",
      description: "Delete a file (staged until you push).",
      parameters: Path,
      replay: "safe",
      execute: async ({ path }) => {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO staged (path, content) VALUES (?, NULL)", path.replace(/^\/+/, ""));
        return text(`staged deletion of ${path}`);
      },
    };
    const claim: ToolRegistration<typeof Claim> = {
      name: "claim_paths",
      description: "Declare the files or globs you will change. Returns overlaps with other agents.",
      parameters: Claim,
      replay: "safe",
      execute: async ({ paths }) => {
        const seat = this.seat();
        const r = await (await this.yardOf(seat)).claim(seat.taskId, seat.agentId, paths);
        return text(r.notes.length ? `Claimed.\n${r.notes.join("\n")}` : "Claimed. No overlaps.");
      },
    };
    const plan: ToolRegistration<typeof Plan> = {
      name: "plan",
      description: "Before you edit: what you'll do, why, and the files you expect to touch. Tells you (and them) about other agents planning the same files.",
      parameters: Plan,
      execute: async ({ summary, why, files }) => {
        const seat = this.seat();
        const r = await (await this.yardOf(seat)).plan(seat.taskId, seat.agentId, { summary, why, files });
        return text(r.notes.length ? `Plan recorded.\n${r.notes.join("\n")}` : "Plan recorded. Nobody else plans to touch these files.");
      },
    };
    const intent: ToolRegistration<typeof Intent> = {
      name: "record_intent",
      description: "Record what you are changing and why. It's attached to your next push.",
      parameters: Intent,
      execute: async ({ summary, why }) => {
        const seat = this.seat();
        await (await this.yardOf(seat)).recordIntent(seat.taskId, seat.agentId, { summary, why }, "mcp");
        return text("Intent recorded.");
      },
    };
    const push: ToolRegistration<typeof Push> = {
      name: "push",
      description: "Commit your staged changes to your fork. Forkyard reviews every push.",
      parameters: Push,
      execute: async ({ message }) => {
        const changes = this.staged();
        if (!changes.size) return text("Nothing staged.");
        const { yard, agent, artifacts, repo, head } = await this.fork();
        try {
          const built = await buildCommit({
            reader: treeReader(repo),
            baseTree: head.treeHash,
            parents: [head.hash],
            changes: new Map<string, FileChange>([...changes].map(([p, c]) => [p, c === null ? null : { contents: new TextEncoder().encode(c) }])),
            message,
            author: { name: agent.name, email: `${agent.id}@agents.forkyard.dev` },
          });
          await artifacts.writeCommit(agent.forkName, built, `refs/heads/${yard.defaultBranch}`, head.hash);
          this.ctx.storage.sql.exec("DELETE FROM staged");
          return text(`Pushed ${built.commit.slice(0, 7)} (${changes.size} file(s)). It will be reviewed.`);
        } finally {
          disposeRepo(repo);
        }
      },
    };
    const ask: ToolRegistration<typeof Ask> = {
      name: "ask_human",
      description: "Ask a person, only when truly blocked. Keep working on anything else; the answer arrives as a message.",
      parameters: Ask,
      execute: async ({ question, options }) => {
        const seat = this.seat();
        await (await this.yardOf(seat)).openAsk(
          seat.taskId,
          seat.agentId,
          "question",
          question,
          null,
          (options ?? []).slice(0, 6).map((label, i) => ({ id: `o${i + 1}`, label })),
        );
        return text("Asked. Carry on with anything that doesn't depend on the answer.");
      },
    };
    return ([list, read, write, del, plan, claim, intent, push, ask] as ToolRegistration[]).map((t) => ({ ...t, execute: this.metered(t.execute) }));
  }
}

export function piAgentStub(env: Env, yardId: string, taskId: string, agentId: string) {
  return env.PI_AGENT.get(env.PI_AGENT.idFromName(`${yardId}/${taskId}/${agentId}`));
}

/**
 * The scripted model (local dev and tests, when there's no real model): one step per tool round,
 * a small genuine change. Each call looks at how many tool results it has seen so far.
 */
function scriptedStep(context: TranscriptContext): AssistantMessage {
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const note = `notes/cloud-agent-${Math.abs(hash(JSON.stringify(context.messages[0] ?? ""))) % 1000}.md`;
  switch (results) {
    case 0:
      return call("list_files", {});
    case 1:
      return call("claim_paths", { paths: [note] });
    case 2:
      return call("record_intent", { summary: "Leave a short note on the task", why: "A scripted demo model: it shows the cloud agent loop without a real model." });
    case 3:
      return call("write_file", { path: note, content: "# Notes\n\nA cloud agent (Pi Durable on Cloudflare) worked here.\n" });
    case 4:
      return call("push", { message: "docs: cloud agent notes" });
    default:
      return fauxAssistantMessage(fauxText("Pushed a short note."));
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
