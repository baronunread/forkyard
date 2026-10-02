/**
 * End-to-end check against a running Forkyard (local or deployed).
 *
 *   pnpm e2e                 # runs the seed (fast) and asserts the whole story
 *   pnpm e2e --cleanup       # also triggers the cron (wrangler dev --test-scheduled, FORK_TTL_HOURS=0)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MCP_TOOLS } from "../packages/shared/src/agents-md";
import { BASE, Git, Mcp, api, arg } from "./lib";

const run = promisify(execFile);
const yardId = `e2e-${Date.now().toString(36).slice(-5)}`;
let failures = 0;

function check(cond: unknown, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

async function expectStatus(p: Promise<unknown>, status: number, label: string) {
  try {
    await p;
    check(false, `${label} (expected ${status}, got success)`);
  } catch (e) {
    check(String(e).includes(`→ ${status}`), `${label} → ${status}`);
  }
}

type Ev = { type: string; agentId: string | null; data: Record<string, unknown> };

async function main() {
  console.log(`e2e → ${BASE}\n`);
  const seed = await run("npx", ["tsx", "scripts/seed.ts", "--pace=fast", `--yard=${yardId}`], { env: process.env, maxBuffer: 8 << 20 });
  check(seed.stdout.includes("decided: assembled"), "seed ran to a decision");

  const detail = await api<{
    task: { id: string; status: string };
    agents: { id: string; name: string; status: string; headCommit: string | null; review: { score: number } | null; intent: { summary: string } | null }[];
    decision: { mode: string; resultCommit: string } | null;
  }>(`/yards/${yardId}/tasks/validate-todo-titles`);
  check(detail.agents.length >= 3, `${detail.agents.length} agents on one task`);
  check(detail.agents.every((a) => a.headCommit), "every agent pushed");
  check(detail.agents.every((a) => a.review), "every agent was reviewed");
  check(detail.agents.every((a) => a.intent), "every agent recorded an intent");
  check(detail.task.status === "decided" && detail.decision?.mode === "assemble", "task decided by assembling hunks");

  // Event delivery is asynchronous and unordered; give stragglers a moment.
  let events: Ev[] = [];
  for (let i = 0; i < 20; i++) {
    events = (await api<{ events: Ev[] }>(`/yards/${yardId}/events?since=0&limit=1000`)).events;
    if (events.filter((e) => e.type === "push.received").length >= 9) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const types = events.map((e) => e.type);
  check(types.filter((t) => t === "agent.ready").length === detail.agents.length, "all forks became ready");
  check(types.includes("overlap.detected"), "an overlap warning was raised");
  check(events.some((e) => e.type === "overlap.detected" && (e.data.overlap as { kind: string }).kind === "change"), "a change-level overlap was detected");
  check(types.filter((t) => t === "push.received").length >= 9, "all pushes reached the yard");
  check(events.some((e) => e.type === "intent.recorded" && (e.data.intent as { source: string }).source === "git"), "intent picked up from .forkyard/intent.md");
  check(types.includes("decision.made"), "decision event emitted");

  const base = await api<{ commits: { hash: string; message: string }[] }>(`/yards/${yardId}/base`);
  check(base.commits[0]?.hash === detail.decision?.resultCommit, "base branch moved to the decision commit");
  check(base.commits[0]?.message.includes("Co-authored-by: Ada"), "merge commit credits the agents");

  // MCP parity and permissions, with a fresh task.
  const t2 = await api<{ task: { id: string }; agents: { id: string }[]; credentials: { agentId: string; apiKey: string }[] }>(`/yards/${yardId}/tasks`, {
    body: { title: "Permissions probe", agents: [{ name: "Eve", harness: "test" }, { name: "Judy", harness: "test", role: "judge" }] },
  });
  const eve = t2.credentials[0]!.apiKey;
  const judy = t2.credentials[1]!.apiKey;
  const mcp = new Mcp(eve);
  const list = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Authorization: `Bearer ${eve}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }).then((r) => r.text());
  check(MCP_TOOLS.every(([name]) => list.includes(`"${name}"`)), `MCP exposes all ${MCP_TOOLS.length} tools`);
  const ws = await mcp.call<{ git: { remote: string; token: string }; agent: { id: string } }>("workspace_get");
  check(ws.data.agent.id === "eve", "workspace_get infers the agent from its key");
  await expectStatus(api(`/yards/${yardId}/tasks/validate-todo-titles`, { key: eve }), 403, "agent key cannot read another task");
  await expectStatus(api(`/yards/${yardId}/tasks/${t2.task.id}/decide`, { key: eve, body: { mode: "winner", winnerAgentId: "eve" } }), 403, "plain agent cannot decide");
  await expectStatus(api(`/yards/${yardId}/tasks`, { key: eve, body: { title: "x", agents: [{ name: "x" }] } }), 403, "agent cannot create tasks");
  await expectStatus(api(`/yards/${yardId}/tasks/${t2.task.id}/agents/judy/intents`, { key: eve, body: { summary: "x", why: "y" } }), 403, "agent cannot act as another agent");
  const judge = await api<{ conflicts: unknown[] }>(`/yards/${yardId}/tasks/${t2.task.id}/decide/preview`, {
    key: judy,
    body: { mode: "winner", winnerAgentId: "eve" },
  }).catch((e) => String(e));
  check(String(judge).includes("has not pushed"), "judge can preview decisions (and gets a clear error with nothing pushed)");

  // The fork token must not grant access to the base repo.
  const baseRemote = ws.data.git.remote.replace(/[^/]+\.git$/, `${yardId}--base.git`);
  const probe = await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${ws.data.git.token}`, "ls-remote", baseRemote]).then(
    () => "ok",
    (e) => String(e),
  );
  check(probe !== "ok", "fork token is rejected by the base repo");

  // A push via plain git still works with only the token.
  const g = await Git.clone(ws.data.git.remote, `${process.env.TMPDIR ?? "/tmp"}/fy-e2e-${yardId}`, ws.data.git.token, { name: "Eve", email: "e@e" });
  await g.write("NOTES.md", "plain git works\n");
  const sha = await g.commitAndPush("notes");
  check(/^[0-9a-f]{40}$/.test(sha), "plain git push with the scoped token");

  await api(`/yards/${yardId}/tasks/${t2.task.id}/abandon`, { body: { reason: "e2e done" } });

  if (arg("cleanup") === "true") {
    // wrangler dev --test-scheduled: invoke the scheduled handler (fork cleanup cron).
    const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=forkyard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "17 * * * *" }),
    });
    check(res.ok, "cron trigger ran");
    const after = await api<{ events: Ev[] }>(`/yards/${yardId}/events?since=0&limit=1000&types=fork.deleted`);
    check(after.events.length >= detail.agents.length, `cleanup deleted ${after.events.length} forks of closed tasks`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
