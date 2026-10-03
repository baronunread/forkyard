/**
 * Swarm: hundreds or thousands of agents working on one codebase at once.
 *
 *   pnpm swarm                                    # 200 agents, 4 tasks, 3 pushes each
 *   pnpm swarm --agents=1000 --tasks=10 --rounds=5 --concurrency=128
 *   FORKYARD_URL=https://… FORKYARD_ADMIN_KEY=… pnpm swarm --agents=2000
 *
 * Each agent is a real git client: it gets its own fork through task fan-out,
 * then builds commits in-process and pushes them over git smart HTTP with its
 * scoped token (the same wire protocol `git push` speaks, without spawning a
 * thousand git processes). Agents work in "lanes" of the codebase, some claim
 * their lane first, and a share of every round touches hot files, so overlap
 * detection has real collisions to find.
 *
 * Measured: fork fan-out (task create → each workspace ready), push latency,
 * push → `push.received` on the yard WebSocket (what the UI sees),
 * push → `diff.updated` (review pipeline: diff, footprint, overlaps), pushes/s,
 * overlaps raised. Results go to bench-results/ and the Benchmarks page.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { pushObjects } from "../apps/worker/src/git/client.ts";
import { makeObject, serializeCommit, serializeTree, signature, utf8, type HashedObject, type TreeEntry } from "../apps/worker/src/git/objects.ts";
import { api, arg, BASE, ADMIN_KEY, sleep, watchYard } from "./lib.ts";

const AGENTS = Number(arg("agents", "200"));
const TASKS = Math.max(1, Math.min(AGENTS, Number(arg("tasks", "4"))));
const ROUNDS = Number(arg("rounds", "3"));
const CONCURRENCY = Number(arg("concurrency", "64"));
const HOT = Number(arg("hot", "0.25"));
const THINK_MS = Number(arg("think", "0"));
const MODULES = Number(arg("modules", "120"));
/** How long to wait for each push's review to land after the last round (local reviews queue behind a cap). */
const REVIEW_WAIT_S = Number(arg("review-wait", "600"));
const yardId = arg("yard", `swarm-${Date.now().toString(36).slice(-5)}`)!;
const HARNESSES = ["claude-code", "codex", "cursor", "gemini-cli", "opencode", "aider"];
const HOT_FILES = ["README.md", "src/index.ts", "src/config.ts", "package.json"];

// ── a generated codebase ─────────────────────────────────────────────────────

function baseFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": "# Swarm service\n\nA service many agents improve at once.\n",
    "package.json": JSON.stringify({ name: "swarm-service", version: "0.0.0", type: "module" }, null, 2) + "\n",
    "src/index.ts": 'export * from "./config";\n',
    "src/config.ts": "export const config = { retries: 3, timeoutMs: 1000 };\n",
  };
  for (let i = 0; i < MODULES; i++) {
    const n = String(i).padStart(3, "0");
    const area = ["api", "db", "auth", "billing", "search", "ui"][i % 6];
    files[`src/${area}/mod-${n}.ts`] = `// ${area} module ${n}\nexport function f${n}(x: number): number {\n  return x + ${i};\n}\n`;
  }
  return files;
}

/** Nested git trees for a flat path → contents map. Returns the root tree hash and every object. */
function buildTree(files: Map<string, string>, objects: HashedObject[]): string {
  type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, contents] of files) {
    const parts = path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = { files: new Map(), dirs: new Map() }));
      d = next;
    }
    d.files.set(parts.at(-1)!, contents);
  }
  const write = (d: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, contents] of d.files) {
      const blob = makeObject("blob", utf8(contents));
      objects.push(blob);
      entries.push({ mode: "100644", name, hash: blob.hash });
    }
    for (const [name, sub] of d.dirs) entries.push({ mode: "40000", name, hash: write(sub) });
    const tree = makeObject("tree", serializeTree(entries));
    objects.push(tree);
    return tree.hash;
  };
  return write(root);
}

// ── stats ────────────────────────────────────────────────────────────────────

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
  const r = (n: number) => Math.round(n * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1) ?? 0) };
}

/** Agents retry transient failures (dropped connections, 5xx); a rejected push is not retried. */
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err);
      const transient = /fetch failed|connection|ECONNRESET|socket|→ 5\d\d|receive-pack 5\d\d|info\/refs 5\d\d/i.test(msg);
      if (!transient || i >= tries) throw err;
      retries++;
      await sleep(250 * 2 ** i);
    }
  }
}
let retries = 0;
/** Pushes whose review hadn't landed when the wait ended: still queued, not failed. */
let unreviewed = 0;

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

// ── the swarm ────────────────────────────────────────────────────────────────

interface SwarmAgent {
  taskId: string;
  id: string;
  name: string;
  key: string;
  remote: string;
  token: string;
  head: string;
  /** Every commit this agent pushed, in order (reviews coalesce onto the newest). */
  commits: string[];
  files: Map<string, string>;
  lane: string[];
}

async function main() {
  const me = await api<{ artifactsMode: string }>("/me");
  const mode = me.artifactsMode;
  console.log(`Swarm → ${BASE} (Artifacts ${mode}): ${AGENTS} agents on ${TASKS} task(s), ${ROUNDS} push(es) each, ${CONCURRENCY} in flight\n`);

  const base = baseFiles();
  await api("/yards", { body: { id: yardId, name: `Swarm · ${AGENTS} agents`, files: base, budgets: { maxAgentsPerTask: 10_000, maxActiveForks: 100_000 } } });
  const live = await watchYard(yardId);
  const moduleNames = Object.keys(base).filter((p) => p.includes("/mod-"));

  // 1. Fan out: tasks are created concurrently; each streams workspaces as forks become ready.
  const agents: SwarmAgent[] = [];
  const forkReady: number[] = [];
  const t0 = performance.now();
  const perTask = Array.from({ length: TASKS }, (_, t) => Math.floor(AGENTS / TASKS) + (t < AGENTS % TASKS ? 1 : 0));
  let agentNo = 0;
  await Promise.all(
    perTask.map(async (n, t) => {
      const specs = Array.from({ length: n }, () => {
        const i = ++agentNo;
        return { name: `Agent ${String(i).padStart(4, "0")}`, harness: HARNESSES[i % HARNESSES.length]! };
      });
      const title = ["Harden input validation", "Cut p99 latency", "Add structured logging", "Raise test coverage", "Tidy the config", "Fix the flaky retries"][t % 6]!;
      const res = await fetch(`${BASE}/api/yards/${yardId}/tasks?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ADMIN_KEY ? { Authorization: `Bearer ${ADMIN_KEY}` } : {}) },
        body: JSON.stringify({ title: `${title} (${t + 1})`, brief: "Swarm run: many agents, one codebase.", agents: specs }),
      });
      if (!res.ok || !res.body) throw new Error(`task create → ${res.status}: ${await res.text()}`);
      const start = performance.now();
      let taskId = "";
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as {
            kind: string;
            task?: { id: string };
            agentId?: string;
            apiKey?: string;
            workspace?: { agent: { name: string; status: string }; git: { remote: string; token: string }; task: { baseCommit: string } };
            error?: string;
          };
          if (msg.kind === "task") taskId = msg.task!.id;
          if (msg.kind === "workspace" && msg.workspace && msg.workspace.agent.status !== "failed") {
            forkReady.push(performance.now() - start);
            const k = agents.length;
            agents.push({
              taskId,
              id: msg.agentId!,
              name: msg.workspace.agent.name,
              key: msg.apiKey!,
              remote: msg.workspace.git.remote,
              token: msg.workspace.git.token,
              head: msg.workspace.task.baseCommit,
              commits: [],
              files: new Map(Object.entries(base)),
              // Each agent works a lane of ~3 modules; neighbours share lanes, so some collide.
              lane: [0, 1, 2].map((d) => moduleNames[(k * 2 + d) % moduleNames.length]!),
            });
          }
        }
      }
    }),
  );
  const fanoutMs = performance.now() - t0;
  console.log(`fan-out: ${agents.length}/${AGENTS} forks ready in ${(fanoutMs / 1000).toFixed(1)}s · per-fork ready p50 ${stats(forkReady).p50}ms p95 ${stats(forkReady).p95}ms`);

  // 2. One in five agents claims its lane before touching it.
  await pool(
    agents.filter((_, i) => i % 5 === 0),
    CONCURRENCY,
    async (a) => {
      await retry(() => api(`/yards/${yardId}/tasks/${a.taskId}/agents/${a.id}/claims`, { body: { paths: [a.lane[0]!] }, key: a.key }));
    },
  );

  // 3. Rounds of real pushes.
  const pushMs: number[] = [];
  const visibleMs: number[] = [];
  const diffMs: number[] = [];
  const errors: string[] = [];
  const pending: Promise<void>[] = [];
  const tPush = performance.now();
  let pushes = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    const tr = performance.now();
    await pool(agents, CONCURRENCY, async (a, i) => {
      if (THINK_MS) await sleep(Math.random() * THINK_MS);
      const touched = [a.lane[(round - 1) % a.lane.length]!];
      if (Math.random() < HOT) touched.push(HOT_FILES[(i + round) % HOT_FILES.length]!);
      for (const p of touched) a.files.set(p, `${a.files.get(p) ?? ""}// ${a.name}, round ${round}\n`);
      if (round === 1)
        a.files.set(".forkyard/intent.md", `# ${a.name} works on ${a.lane[0]}\n\n## Why\nSwarm lane ${a.lane.join(", ")}.\n`);
      const objects: HashedObject[] = [];
      const tree = buildTree(a.files, objects);
      const who = signature(a.name, `${a.id}@swarm.forkyard.dev`);
      const commit = makeObject("commit", serializeCommit({ tree, parents: [a.head], author: who, committer: who, message: `${a.name}: round ${round} (${touched.join(", ")})\n` }));
      objects.push(commit);
      const s = performance.now();
      try {
        await retry(() => pushObjects({ remote: a.remote, token: a.token, ref: "refs/heads/main", newHash: commit.hash, objects, expectedOld: a.head }));
      } catch (err) {
        errors.push(`${a.name}: ${String(err).slice(0, 120)}`);
        return;
      }
      const done = performance.now();
      pushMs.push(done - s);
      a.head = commit.hash;
      a.commits.push(commit.hash);
      const mine = a.commits.length - 1;
      pushes++;
      pending.push(
        live
          .waitFor((e) => e.type === "push.received" && (e.data as { after?: string }).after === commit.hash, 120_000)
          .then((e) => void visibleMs.push(e.at - done))
          .catch(() => void errors.push(`${a.name}: push never became visible`)),
        live
          // Reviews coalesce: a quick second push is reviewed once, at the newer head, which covers this one too.
          .waitFor((e) => e.type === "diff.updated" && e.agentId === a.id && a.commits.indexOf((e.data as { commit?: string }).commit ?? "") >= mine, REVIEW_WAIT_S * 1000)
          .then((e) => void diffMs.push(e.at - done))
          .catch(() => void unreviewed++),
      );
    });
    console.log(`round ${round}: ${agents.length} pushes in ${((performance.now() - tr) / 1000).toFixed(1)}s`);
  }
  const pushWindow = (performance.now() - tPush) / 1000;
  console.log("waiting for events to land…");
  await Promise.all(pending);

  const overlaps = live.seen.filter((e) => e.type === "overlap.detected").length;
  const result = {
    at: new Date().toISOString(),
    target: BASE,
    mode,
    yardId,
    agents: agents.length,
    tasks: TASKS,
    rounds: ROUNDS,
    concurrency: CONCURRENCY,
    fanoutSeconds: Math.round(fanoutMs) / 1000,
    forkReadyMs: stats(forkReady),
    pushes,
    pushesPerSecond: Math.round((pushes / pushWindow) * 10) / 10,
    pushMs: stats(pushMs),
    pushToVisibleMs: stats(visibleMs),
    pushToDiffMs: stats(diffMs),
    eventsSeen: live.seen.length,
    overlapsDetected: overlaps,
    watcherReconnects: live.reconnects,
    retries,
    notYetReviewed: unreviewed,
    errors: errors.length,
    errorSamples: [...new Set(errors.map((e) => e.replace(/^Agent \d+: /, "")))].slice(0, 8),
  };
  live.close();
  console.log("\n" + JSON.stringify(result, null, 2));
  if (errors.length) console.log("first errors:\n  " + errors.slice(0, 5).join("\n  "));

  await mkdir("bench-results", { recursive: true });
  await writeFile(`bench-results/swarm-${mode}-${agents.length}-${result.at.slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify(result, null, 2));
  await api("/bench/record", {
    body: { kind: "swarm", label: `swarm ×${agents.length}: push → visible`, mode, concurrency: agents.length, stats: result.pushToVisibleMs },
  }).catch(() => undefined);
  process.exit(errors.length > agents.length * 0.05 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
