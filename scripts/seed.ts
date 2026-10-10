/**
 * Demo seed: the life of one feature in Forkyard, with four scripted agents.
 *
 *   1. A person files the work in the backlog and starts it: four agents, four forks.
 *   2. Plans before code: each agent says what it'll do and where; agents planning the
 *      same file hear about each other before either writes.
 *   3. One agent asks the person a product question and keeps working meanwhile.
 *   4. Pushes stream in and get reviewed; the person assembles the best parts.
 *   5. Every merged line traces back to its agent and intent.
 *
 *   bun run seed                      # demo pacing (good for recording), decides at the end
 *   bun run seed --pace=fast          # same story, no pauses (--pace=slow doubles the pauses)
 *   bun run seed --no-decide          # leave the decision to you in the UI
 *   bun run seed --yard=my-demo
 *   bun run seed --owner=<handle>     # on a deployment: the yard goes in that person's account
 *
 * Each agent does what a real coding agent would: workspace_get over MCP,
 * plan (what, why, files), then plain `git clone` / `git push` with its
 * scoped token — in small commits so the UI shows diffs streaming in. Ada and
 * Cyd both claim `src/todos.ts` (the deliberate overlap); Cyd and Dex both
 * touch README.md (a second, change-level overlap).
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_KEY, BASE, Git, Mcp, api, arg, log, sleep } from "./lib";

const pace = ({ fast: 0, demo: 1, slow: 2 } as Record<string, number>)[arg("pace", "demo")!] ?? 1;
const decide = arg("no-decide") !== "true";
const yardId = arg("yard", `demo-${Date.now().toString(36).slice(-4)}`)!;
const yardName = arg("name", "Todo service (demo)")!;
const beat = (ms: number) => sleep(ms * pace);

const BASE_FILES: Record<string, string> = {
  "README.md": `# Todo service

A tiny todo API used to demo Forkyard.

\`\`\`sh
npm test
\`\`\`
`,
  "package.json": JSON.stringify({ name: "todo-service", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/todos.ts": `export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const todos: Todo[] = [];
let nextId = 1;

export function addTodo(title: string): Todo {
  const todo = { id: nextId++, title, done: false };
  todos.push(todo);
  return todo;
}

export function listTodos(): Todo[] {
  return todos;
}

export function completeTodo(id: number): Todo | undefined {
  const todo = todos.find((t) => t.id === id);
  if (todo) todo.done = true;
  return todo;
}
`,
  "src/server.ts": `import { addTodo, completeTodo, listTodos } from "./todos";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/todos" && request.method === "GET") {
      return Response.json(listTodos());
    }
    if (url.pathname === "/todos" && request.method === "POST") {
      const body = (await request.json()) as { title: string };
      return Response.json(addTodo(body.title), { status: 201 });
    }
    const done = /^\\/todos\\/(\\d+)\\/done$/.exec(url.pathname);
    if (done && request.method === "POST") {
      return Response.json(completeTodo(Number(done[1])));
    }
    return new Response("not found", { status: 404 });
  },
};
`,
  "test/todos.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { addTodo, listTodos } from "../src/todos";

test("adds a todo", () => {
  addTodo("write tests");
  assert.equal(listTodos().length, 1);
});
`,
};

const chapter = (n: number, title: string) => console.log(`\n── ${n}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\n`);

const TASK = {
  title: "Validate todo titles",
  brief:
    "POST /todos accepts anything today: empty strings, 10k-character titles, missing bodies. Reject invalid titles with a clear 400 error, " +
    "keep the happy path unchanged, and cover it with tests. Keep the change small.",
};

interface Step {
  wait: number;
  files: Record<string, string>;
  message: string;
}

interface Script {
  name: string;
  harness: string;
  claims: string[];
  intent: { summary: string; why: string; details?: string };
  /** "mcp" (default): call intent_record. "git": only commit .forkyard/intent.md. */
  intentVia?: "mcp" | "git";
  steps: Step[];
}

const intentMd = (s: string, why: string) => `# ${s}\n\n## Why\n\n${why}\n`;

const AGENTS: Script[] = [
  {
    name: "Ada",
    harness: "claude-code",
    claims: ["src/todos.ts", "src/errors.ts", "test/**"],
    intent: {
      summary: "Validate in the domain layer",
      why: "Every caller of addTodo — HTTP today, a queue consumer tomorrow — should get the same guarantees, so the rule lives next to the data.",
    },
    steps: [
      {
        wait: 1800,
        message: "feat: ValidationError type",
        files: {
          "src/errors.ts": `export class ValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
`,
        },
      },
      {
        wait: 3200,
        message: "feat: validate titles in addTodo",
        files: {
          "src/todos.ts": BASE_FILES["src/todos.ts"]!.replace(
            `export function addTodo(title: string): Todo {
  const todo = { id: nextId++, title, done: false };`,
            `export const MAX_TITLE = 120;

export function addTodo(title: unknown): Todo {
  if (typeof title !== "string") throw new ValidationError("title", "title must be a string");
  const clean = title.trim();
  if (clean.length === 0) throw new ValidationError("title", "title cannot be empty");
  if (clean.length > MAX_TITLE) throw new ValidationError("title", \`title must be at most \${MAX_TITLE} characters\`);
  const todo = { id: nextId++, title: clean, done: false };`,
          ).replace(`export interface Todo {`, `import { ValidationError } from "./errors";\n\nexport interface Todo {`),
          ".forkyard/intent.md": intentMd("Validate in the domain layer", "Every caller of addTodo gets the same guarantees."),
        },
      },
      {
        wait: 2600,
        message: "test: title validation",
        files: {
          "test/todos.test.ts": `${BASE_FILES["test/todos.test.ts"]}
test("rejects empty and oversized titles", () => {
  assert.throws(() => addTodo("   "), /cannot be empty/);
  assert.throws(() => addTodo("x".repeat(500)), /at most 120/);
});
`,
        },
      },
    ],
  },
  {
    name: "Bash",
    harness: "codex",
    claims: ["src/server.ts"],
    intent: {
      summary: "Validate at the HTTP edge",
      why: "Bad input is an HTTP concern: answer 400 with a JSON error before touching the domain, and keep addTodo pure and fast.",
    },
    steps: [
      {
        wait: 2400,
        message: "feat: 400 on invalid todo titles",
        files: {
          "src/server.ts": BASE_FILES["src/server.ts"]!.replace(
            `      const body = (await request.json()) as { title: string };
      return Response.json(addTodo(body.title), { status: 201 });`,
            `      const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 120) {
        return Response.json({ error: "title must be 1-120 characters" }, { status: 400 });
      }
      return Response.json(addTodo(title), { status: 201 });`,
          ),
          ".forkyard/intent.md": intentMd("Validate at the HTTP edge", "Answer 400 before touching the domain."),
        },
      },
      {
        wait: 3000,
        message: "fix: 400 on malformed todo ids",
        files: {
          "src/server.ts": "",
        },
      },
    ],
  },
  {
    name: "Cyd",
    harness: "gemini-cli",
    claims: ["src/todos.ts", "README.md"],
    intent: {
      summary: "Normalize and de-duplicate titles",
      why: "Most 'invalid' titles in the wild are whitespace noise or accidental double submits; normalize them instead of rejecting, and document the rule.",
    },
    steps: [
      {
        wait: 3600,
        message: "feat: normalize whitespace and reject duplicates",
        files: {
          "src/todos.ts": BASE_FILES["src/todos.ts"]!.replace(
            `export function addTodo(title: string): Todo {
  const todo = { id: nextId++, title, done: false };`,
            `export function addTodo(title: string): Todo {
  const normalized = title.replace(/\\s+/g, " ").trim();
  const existing = todos.find((t) => t.title.toLowerCase() === normalized.toLowerCase() && !t.done);
  if (existing) return existing;
  const todo = { id: nextId++, title: normalized, done: false };`,
          ),
          ".forkyard/intent.md": intentMd("Normalize and de-duplicate titles", "Normalize instead of rejecting."),
        },
      },
      {
        wait: 2600,
        message: "docs: title rules",
        files: {
          "README.md": `${BASE_FILES["README.md"]}
## Titles

Whitespace is collapsed and trimmed. Adding a title that matches an open todo
returns the existing todo instead of creating a duplicate.
`,
        },
      },
    ],
  },
  {
    name: "Dex",
    harness: "aider",
    intentVia: "git",
    claims: ["docs/**", "README.md"],
    intent: {
      summary: "Document the API and its errors",
      why: "Whatever validation ships, clients need to know the contract: status codes, error shape and limits.",
    },
    steps: [
      {
        wait: 2900,
        message: "docs: API reference",
        files: {
          "docs/api.md": `# API

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | /todos | – | 200 \`Todo[]\` | – |
| POST | /todos | \`{ "title": string }\` | 201 \`Todo\` | 400 \`{ "error": string }\` |
| POST | /todos/:id/done | – | 200 \`Todo\` | 404 |

Titles are 1–120 characters after trimming.
`,
          ".forkyard/intent.md": intentMd(
            "Document the API and its errors",
            "Whatever validation ships, clients need to know the contract: status codes, error shape and limits.",
          ),
        },
      },
      {
        wait: 2400,
        message: "docs: link API reference from README",
        files: {
          "README.md": `${BASE_FILES["README.md"]}
See [docs/api.md](docs/api.md) for the API reference.
`,
        },
      },
    ],
  },
];

// Bash's second step rewrites the file on top of its first step.
AGENTS[1]!.steps[1]!.files["src/server.ts"] = AGENTS[1]!.steps[0]!.files["src/server.ts"]!.replace(
  `    if (done && request.method === "POST") {
      return Response.json(completeTodo(Number(done[1])));
    }`,
  `    if (done && request.method === "POST") {
      const todo = completeTodo(Number(done[1]));
      return todo ? Response.json(todo) : Response.json({ error: "todo not found" }, { status: 404 });
    }`,
);

async function main() {
  console.log(`Forkyard seed → ${BASE}  (yard "${yardId}", pace ×${pace})\n`);
  await api("/yards", { body: { id: yardId, name: yardName, files: BASE_FILES, owner: arg("owner") } });
  log("seed", `created yard ${yardId}`);
  await beat(1500);

  chapter(1, "A person files the work and starts it");
  const item = await api<{ id: string }>(`/yards/${yardId}/backlog`, { body: { title: TASK.title, body: TASK.brief } });
  log("person", `filed backlog item #${item.id}: ${TASK.title}`);
  await beat(2000);
  const t0 = performance.now();
  const created = await api<{
    task: { id: string };
    agents: { id: string; name: string }[];
    credentials: { agentId: string; apiKey: string }[];
  }>(`/yards/${yardId}/backlog/${item.id}/start`, {
    // The scripted story ends with a person assembling hunks, so autopilot stays off.
    body: { autopilot: false, agents: AGENTS.map((a) => ({ name: a.name, harness: a.harness })) },
  });
  const taskId = created.task.id;
  log("person", `started it with ${created.agents.map((a) => a.name).join(", ")}: one fork each, in ${Math.round(performance.now() - t0)} ms`);
  console.log(`\n  Watch it live: ${BASE}/${arg("owner") ?? "forkyard"}/${yardId}/t/${taskId}\n`);
  await beat(2500);

  const work = join(tmpdir(), `forkyard-seed-${yardId}`);
  await rm(work, { recursive: true, force: true });

  chapter(2, "Plans before code");
  const mcps = new Map<string, Mcp>();
  let asked: { id: string; options: { id: string; label: string }[] } | null = null;
  await Promise.all(
    AGENTS.map(async (script, i) => {
      const agentId = created.agents[i]!.id;
      const key = created.credentials.find((c) => c.agentId === agentId)!.apiKey;
      const mcp = new Mcp(key);
      mcps.set(script.name, mcp);
      await beat(400 * i);
      const ws = await mcp.call<{ git: { remote: string } }>("workspace_get");
      log(script.name, `workspace ready → ${ws.data.git.remote}`);
      const git = await Git.clone(ws.data.git.remote, join(work, agentId), key, {
        name: `${script.name} (${script.harness})`,
        email: `${agentId}@agents.forkyard.dev`,
      });
      await beat(600 + 500 * i);
      const warnings = (text: string) => text.split("\n").filter((l) => l.startsWith("⚠"));
      if (script.intentVia === "git") {
        // Some harnesses only speak git: the claim goes over MCP, the intent rides in the commit.
        const claim = await mcp.call("claim_paths", { paths: script.claims });
        log(script.name, `claimed ${script.claims.join(", ")}; its intent travels in .forkyard/intent.md`);
        for (const w of warnings(claim.text)) log(script.name, `  ${w}`);
      } else {
        const plan = await mcp.call("plan", { ...script.intent, files: script.claims });
        log(script.name, `plans: ${script.intent.summary}  (${script.claims.join(", ")})`);
        for (const w of warnings(plan.text)) log(script.name, `  ${w}`);
      }
      await beat(2500);
      // Whoever planned first hears about later planners on their next call.
      const heard = await mcp.call("events_since", { since: 0, limit: 1 });
      for (const w of warnings(heard.text)) log(script.name, `  heard: ${w}`);
      if (script.name === "Bash") {
        await beat(800);
        const ask = await mcp.call<{ id: string; options: { id: string; label: string }[] }>("ask_human", {
          question: "Should a rejected title answer with a plain { error } body or RFC 9457 problem+json?",
          options: ["Plain { error }", "problem+json"],
        });
        asked = ask.data;
        log(script.name, `asked the person: plain { error } or problem+json? (keeps working meanwhile)`);
      }
      for (const step of script.steps) {
        await beat(step.wait);
        for (const [path, contents] of Object.entries(step.files)) await git.write(path, contents);
        const sha = await git.commitAndPush(step.message);
        log(script.name, `pushed ${sha.slice(0, 7)} ${step.message}`);
      }
    }),
  );

  if (asked && decide) {
    chapter(3, "The person answers the one question");
    const a = asked as { id: string; options: { id: string; label: string }[] };
    await api(`/yards/${yardId}/asks/${a.id}/answer`, { body: { optionId: a.options[0]!.id, text: "Keep it plain; we have no problem+json clients." } });
    log("person", `answered Bash: ${a.options[0]!.label}`);
    const status = await mcps.get("Bash")!.call<{ answer: string }>("ask_status", { askId: a.id });
    log("Bash", `read the answer: ${status.data.answer}`);
  }

  chapter(4, "Reviews, then the person decides");
  log("seed", "all agents pushed; waiting for reviews…");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const detail = await api<{ agents: { id: string; name: string; headCommit: string | null; review: { commit: string; score: number } | null }[] }>(
      `/yards/${yardId}/tasks/${taskId}`,
    );
    const pending = detail.agents.filter((a) => !a.review || a.review.commit !== a.headCommit);
    if (!pending.length) {
      for (const a of detail.agents) log(a.name, `review score ${a.review!.score}`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`reviews still pending for ${pending.map((a) => a.name).join(", ")}`);
    await sleep(500);
  }

  if (!decide) {
    console.log(`\nLeaving the decision to you: ${BASE}/y/${yardId}/t/${taskId}\n`);
    return;
  }
  await beat(4000);
  // Assemble: Ada's domain validation + tests, Bash's HTTP 400s, Dex's docs. Cyd's de-dupe is left out.
  const ids = Object.fromEntries(created.agents.map((a) => [a.name, a.id]));
  const selections = [
    { path: "src/errors.ts", agentId: ids.Ada },
    { path: "src/todos.ts", agentId: ids.Ada },
    { path: "test/todos.test.ts", agentId: ids.Ada },
    { path: "src/server.ts", agentId: ids.Bash },
    { path: "docs/api.md", agentId: ids.Dex },
    { path: "README.md", agentId: ids.Dex },
  ];
  const preview = await api<{ conflicts: unknown[]; files: { path: string }[] }>(`/yards/${yardId}/tasks/${taskId}/decide/preview`, {
    body: { mode: "assemble", selections },
  });
  if (preview.conflicts.length) throw new Error(`unexpected conflicts: ${JSON.stringify(preview.conflicts)}`);
  const res = await api<{ decision: { resultCommit: string } }>(`/yards/${yardId}/tasks/${taskId}/decide`, {
    body: { mode: "assemble", selections, message: "Validate todo titles (domain + HTTP) and document the API" },
  });
  log("seed", `decided: assembled ${preview.files.length} files from Ada, Bash and Dex → ${res.decision.resultCommit.slice(0, 7)}`);

  chapter(5, "Who wrote this, and why");
  for (const path of ["src/todos.ts", "src/server.ts"]) {
    const why = await api<{ lines: number; spans: { start: number; end: number; agent: string | null; intent: { summary: string } | null }[] }>(
      `/yards/${yardId}/code/why?path=${encodeURIComponent(path)}`,
    );
    const by = new Map<string, { n: number; intent: string | null }>();
    for (const sp of why.spans.filter((x) => x.agent)) {
      const e = by.get(sp.agent!) ?? { n: 0, intent: sp.intent?.summary ?? null };
      e.n += sp.end - sp.start;
      by.set(sp.agent!, e);
    }
    for (const [agent, e] of by) log("seed", `${path}: ${agent} wrote ${Math.round((e.n / why.lines) * 100)}%${e.intent ? ` (“${e.intent}”)` : ""}`);
  }
  console.log(`\nDone. ${BASE}/${arg("owner") ?? "forkyard"}/${yardId}/t/${taskId}\n`);
}

main().catch((err) => {
  console.error(err);
  if (!ADMIN_KEY && String(err).includes("401")) console.error("Hint: set FORKYARD_ADMIN_KEY for deployed instances.");
  process.exit(1);
});
