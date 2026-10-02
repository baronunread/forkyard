/**
 * Demo seed: one yard, one task, four scripted agents working concurrently.
 *
 *   pnpm seed                      # demo pacing (good for recording), decides at the end
 *   pnpm seed --pace=fast          # same story, no pauses (--pace=slow doubles the pauses)
 *   pnpm seed --no-decide          # leave the decision to you in the UI
 *   pnpm seed --yard=my-demo
 *
 * Each agent does what a real coding agent would: workspace_get over MCP,
 * claim_paths, intent_record, then plain `git clone` / `git push` with its
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
  await api("/yards", { body: { id: yardId, name: yardName, files: BASE_FILES } });
  log("seed", `created yard ${yardId}`);
  await beat(1500);

  const t0 = performance.now();
  const created = await api<{
    task: { id: string };
    agents: { id: string; name: string }[];
    credentials: { agentId: string; apiKey: string }[];
  }>(`/yards/${yardId}/tasks`, {
    body: { title: TASK.title, brief: TASK.brief, agents: AGENTS.map((a) => ({ name: a.name, harness: a.harness })) },
  });
  const taskId = created.task.id;
  log("seed", `task "${TASK.title}" fanned out to ${created.agents.length} agents in ${Math.round(performance.now() - t0)} ms`);
  console.log(`\n  Open ${BASE}/y/${yardId}/t/${taskId}  (or the Vite dev URL)\n`);
  await beat(2500);

  const work = join(tmpdir(), `forkyard-seed-${yardId}`);
  await rm(work, { recursive: true, force: true });

  await Promise.all(
    AGENTS.map(async (script, i) => {
      const agentId = created.agents[i]!.id;
      const key = created.credentials.find((c) => c.agentId === agentId)!.apiKey;
      const mcp = new Mcp(key);
      await beat(400 * i);
      const ws = await mcp.call<{ git: { remote: string; token: string } }>("workspace_get");
      log(script.name, `workspace ready → ${ws.data.git.remote}`);
      const git = await Git.clone(ws.data.git.remote, join(work, agentId), ws.data.git.token, {
        name: `${script.name} (${script.harness})`,
        email: `${agentId}@agents.forkyard.dev`,
      });
      await beat(600 + 500 * i);
      const claim = await mcp.call<{ overlaps: { path: string; agents: string[] }[] }>("claim_paths", { paths: script.claims });
      log(script.name, `claimed ${script.claims.join(", ")}${claim.data.overlaps.length ? `  ⚠ overlaps: ${claim.data.overlaps.map((o) => o.path).join(", ")}` : ""}`);
      await beat(700);
      if (script.intentVia === "git") {
        log(script.name, `intent travels in .forkyard/intent.md: ${script.intent.summary}`);
      } else {
        await mcp.call("intent_record", script.intent);
        log(script.name, `intent: ${script.intent.summary}`);
      }
      for (const step of script.steps) {
        await beat(step.wait);
        for (const [path, contents] of Object.entries(step.files)) await git.write(path, contents);
        const sha = await git.commitAndPush(step.message);
        log(script.name, `pushed ${sha.slice(0, 7)} ${step.message}`);
      }
    }),
  );

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
  console.log(`\nDone. ${BASE}/y/${yardId}/t/${taskId}\n`);
}

main().catch((err) => {
  console.error(err);
  if (!ADMIN_KEY && String(err).includes("401")) console.error("Hint: set FORKYARD_ADMIN_KEY for deployed instances.");
  process.exit(1);
});
