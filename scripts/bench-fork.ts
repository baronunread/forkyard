/**
 * Fork latency benchmark.
 *
 *   bun run bench:fork                         # 1, 5, 20, 50 concurrent forks × 3 rounds
 *   bun run bench:fork --levels=1,5,20,50 --rounds=5 --files=500 --yard=bench
 *
 * Each round calls POST /api/bench/fork, which forks the yard's base repo N
 * times concurrently *inside the Worker* (so client network latency is not
 * measured), records per-fork latency, and deletes the forks immediately.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { summarize } from "../packages/shared/src/stats";
import { BASE, api, arg } from "./lib";

const levels = (arg("levels", "1,5,20,50") ?? "").split(",").map(Number).filter(Boolean);
const rounds = Number(arg("rounds", "3"));
const files = Number(arg("files", "200"));
const yardId = arg("yard", `bench-${Date.now().toString(36).slice(-5)}`)!;

async function ensureYard() {
  const yards = await api<{ id: string }[]>("/yards");
  if (yards.some((y) => y.id === yardId)) return;
  // A base repo with some weight: `files` source files across nested folders.
  const tree: Record<string, string> = { "README.md": "# bench\n" };
  for (let i = 0; i < files; i++) tree[`src/m${i % 10}/f${i}.ts`] = `export const v${i} = ${i};\n${"// filler\n".repeat(20)}`;
  await api("/yards", { body: { id: yardId, name: "Fork benchmark", files: tree, budgets: { maxAgentsPerTask: 50, maxActiveForks: 500 } } });
}

async function main() {
  await ensureYard();
  const me = await api<{ artifactsMode: string }>("/account");
  console.log(`Fork benchmark → ${BASE} (Artifacts ${me.artifactsMode}), yard ${yardId}, ${files} files, ${rounds} rounds\n`);
  const results: { concurrency: number; stats: ReturnType<typeof summarize>; wallMs: number[]; failures: number }[] = [];
  for (const n of levels) {
    const samples: number[] = [];
    const wall: number[] = [];
    let failures = 0;
    for (let r = 0; r < rounds; r++) {
      const res = await api<{ samples: number[]; stats: { wallMs: number; failures: number }; errors: string[] }>("/bench/fork", {
        body: { yardId, concurrency: n, label: `fork x${n} (round ${r + 1})` },
      });
      samples.push(...res.samples);
      wall.push(res.stats.wallMs);
      failures += res.stats.failures;
      if (res.errors.length) console.warn(`  errors: ${res.errors.join("; ")}`);
    }
    const stats = summarize(samples);
    results.push({ concurrency: n, stats, wallMs: wall, failures });
    console.log(`  ×${String(n).padEnd(3)} p50 ${stats.p50} ms  p95 ${stats.p95} ms  p99 ${stats.p99} ms  (n=${stats.n}, failures=${failures})`);
  }
  console.log("\n| Concurrent forks | p50 | p95 | p99 | samples | wall (median) |\n| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const wall = [...r.wallMs].sort((a, b) => a - b)[Math.floor(r.wallMs.length / 2)];
    console.log(`| ${r.concurrency} | ${r.stats.p50} ms | ${r.stats.p95} ms | ${r.stats.p99} ms | ${r.stats.n} | ${wall} ms |`);
  }
  await mkdir("bench-results", { recursive: true });
  const out = `bench-results/fork-${me.artifactsMode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ base: BASE, mode: me.artifactsMode, files, rounds, results }, null, 2));
  console.log(`\nSaved ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
