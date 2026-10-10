/**
 * Event latency benchmark: git push → event visible to a WebSocket client
 * (exactly what the UI and agents see).
 *
 *   bun run bench:events --pushes=30
 *   bun run bench:events --k2          # also poll the K2 spike consumer and report its added latency
 *
 * Live path: Artifacts event subscription → Queue → Worker → Yard DO → WebSocket.
 * K2 path (spike): the same events forwarded into a K2 stream and pulled by the
 * Yard DO on an alarm; the server reports how long after append each record
 * was consumed, which is added on top of the live path's ingest.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "../packages/shared/src/stats";
import { BASE, Git, api, arg, sleep, watchYard } from "./lib";

const pushes = Number(arg("pushes", "20"));
const useK2 = arg("k2") === "true";
const yardId = arg("yard", `evbench-${Date.now().toString(36).slice(-5)}`)!;

async function main() {
  const me = await api<{ artifactsMode: string }>("/account");
  await api("/yards", { body: { id: yardId, name: "Event benchmark", files: { "README.md": "# events\n" } } });
  const task = await api<{ task: { id: string }; agents: { id: string }[]; credentials: { apiKey: string }[] }>(`/yards/${yardId}/tasks`, {
    body: { title: "event bench", agents: [{ name: "Pusher", harness: "bench" }] },
  });
  const agentId = task.agents[0]!.id;
  const ws = await api<{ git: { remote: string } }>(`/yards/${yardId}/tasks/${task.task.id}/agents/${agentId}/workspace`);
  const git = await Git.clone(ws.git.remote, join(tmpdir(), `fy-evbench-${yardId}`), task.credentials[0]!.apiKey, { name: "Pusher", email: "p@bench" });
  if (useK2) {
    const k = await api<{ configured: boolean }>(`/yards/${yardId}/k2/poll`, { body: { seconds: 300 } });
    if (!k.configured) console.warn("K2 is not configured on this deployment; reporting the live path only.");
  }
  const watch = await watchYard(yardId);
  console.log(`Event benchmark → ${BASE} (Artifacts ${me.artifactsMode}), ${pushes} pushes\n`);

  const e2e: number[] = [];
  const afterPush: number[] = [];
  const pushMs: number[] = [];
  for (let i = 0; i < pushes; i++) {
    await git.write("counter.txt", `${i}\n`);
    await git.run("add", "-A");
    await git.run("commit", "-q", "-m", `push ${i}`);
    const sha = await git.run("rev-parse", "HEAD");
    const t0 = performance.now();
    await git.run("push", "-q", "origin", "HEAD");
    const t1 = performance.now();
    const ev = await watch.waitFor((e) => e.type === "push.received" && (e.data as { after?: string }).after === sha, 60_000);
    e2e.push(ev.at - t0);
    afterPush.push(Math.max(0, ev.at - t1));
    pushMs.push(t1 - t0);
    process.stdout.write(".");
    await sleep(150);
  }
  watch.close();
  const s = { e2e: summarize(e2e), afterPush: summarize(afterPush), push: summarize(pushMs) };
  console.log(`\n\n| Measure | p50 | p95 | p99 |\n| --- | --- | --- | --- |`);
  console.log(`| git push → event on WebSocket (end to end) | ${s.e2e.p50} ms | ${s.e2e.p95} ms | ${s.e2e.p99} ms |`);
  console.log(`| push returned → event on WebSocket | ${s.afterPush.p50} ms | ${s.afterPush.p95} ms | ${s.afterPush.p99} ms |`);
  console.log(`| git push itself | ${s.push.p50} ms | ${s.push.p95} ms | ${s.push.p99} ms |`);

  let k2: unknown = null;
  if (useK2) {
    await sleep(5000);
    const lat = await api<{ k2: { configured: boolean; stats: ReturnType<typeof summarize> } }>(`/yards/${yardId}/latency`);
    k2 = lat.k2;
    if (lat.k2.configured && lat.k2.stats.n) {
      console.log(`| K2: DO append → consumed by pull consumer | ${lat.k2.stats.p50} ms | ${lat.k2.stats.p95} ms | ${lat.k2.stats.p99} ms |`);
      console.log(
        `| K2 path estimate (live ingest + K2) | ${Math.round(s.e2e.p50 + lat.k2.stats.p50)} ms | ${Math.round(s.e2e.p95 + lat.k2.stats.p95)} ms | ${Math.round(s.e2e.p99 + lat.k2.stats.p99)} ms |`,
      );
    }
  }
  await api("/bench/record", { body: { kind: "event", label: "git push → WebSocket (live path)", mode: me.artifactsMode, concurrency: 1, stats: s.e2e } });
  await mkdir("bench-results", { recursive: true });
  const out = `bench-results/events-${me.artifactsMode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ base: BASE, mode: me.artifactsMode, pushes, ...s, k2 }, null, 2));
  console.log(`\nSaved ${out}`);
  await api(`/yards/${yardId}/tasks/${task.task.id}/abandon`, { body: { reason: "benchmark finished" } });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
