/**
 * `bun run dev`: the Worker, the UI and emulate.dev (GitHub + Google) on free ports, behind portless:
 *
 *   https://forkyard.localhost                   the app (Vite → Worker)
 *   https://github.emulate.forkyard.localhost    sign in with a seeded GitHub user
 *   https://google.emulate.forkyard.localhost    … or Google
 *
 * Without a running portless proxy (or with PORTLESS=0) it falls back to http://localhost:5173.
 * The Worker stays on :8787 when it's free, so the scripts (seed, e2e) find it as before.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

/** A workspace package's own binary (Bun installs them per package). */
const bin = (name: string, cwd = ".") => resolve(cwd, "node_modules/.bin", name);

const free = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = createServer()
      .once("error", () => ok(false))
      .once("listening", () => s.close(() => ok(true)))
      .listen(port, "127.0.0.1");
  });

async function pick(preferred: number, span = 1): Promise<number> {
  for (let p = preferred; p < preferred + 500; p++) {
    let ok = true;
    for (let i = 0; i < span && ok; i++) ok = await free(p + i);
    if (ok) return p;
  }
  throw new Error(`no free ports near ${preferred}`);
}

const portless = process.env.PORTLESS !== "0" && spawnSync(bin("portless"), ["list"], { encoding: "utf8" }).status === 0;
const worker = await pick(8787);
const web = await pick(5173);
const emulate = await pick(4101, 2); // GitHub on P, Google on P + 1

const app = portless ? "https://forkyard.localhost" : `http://localhost:${web}`;
const gh = portless ? "https://github.emulate.forkyard.localhost" : `http://localhost:${emulate}`;
const google = portless ? "https://google.emulate.forkyard.localhost" : `http://localhost:${emulate + 1}`;
const aliases: [string, number][] = [
  ["forkyard", web],
  ["github.emulate.forkyard", emulate],
  ["google.emulate.forkyard", emulate + 1],
];
if (portless) for (const [name, port] of aliases) spawnSync(bin("portless"), ["alias", name, String(port), "--force"], { stdio: "ignore" });

const vars = {
  PUBLIC_ORIGIN: app,
  LOCAL_GIT_ORIGIN: app,
  EMULATE_GITHUB_URL: gh,
  EMULATE_GOOGLE_URL: google,
  EMULATE_GITHUB_INTERNAL_URL: `http://127.0.0.1:${emulate}`,
  EMULATE_GOOGLE_INTERNAL_URL: `http://127.0.0.1:${emulate + 1}`,
};

const procs: ChildProcess[] = [];
const start = (label: string, color: number, cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, FORCE_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `\x1b[${color}m${label.padEnd(7)}\x1b[0m│ `;
  for (const s of [p.stdout, p.stderr]) s.on("data", (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, tag)));
  p.on("exit", (code) => {
    console.log(`${tag}exited (${code})`);
    stop();
  });
  procs.push(p);
};

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  if (portless) for (const [name] of aliases) spawnSync(bin("portless"), ["alias", "--remove", name], { stdio: "ignore" });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start("emulate", 35, bin("emulate"), ["start", "--service", "github,google", "--port", String(emulate), ...(portless ? ["--base-url", "https://{service}.emulate.forkyard.localhost"] : []), "--seed", "emulate.config.yaml"]);
start("worker", 33, bin("wrangler", "apps/worker"), [
  "dev",
  "--port", String(worker),
  "--ip", "127.0.0.1",
  // wrangler dev rewrites Origin and the request URL to the upstream protocol; keep them https.
  ...(portless ? ["--upstream-protocol", "https"] : []),
  "--persist-to", "../../.wrangler/state",
  ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
], { cwd: "apps/worker" });
start("web", 36, bin("vite", "apps/web"), ["--port", String(web), "--strictPort", "--host", "127.0.0.1"], { cwd: "apps/web", env: { FORKYARD_WORKER: `http://127.0.0.1:${worker}` } });

console.log(`\n  Forkyard  ${app}\n  GitHub    ${gh}  (ada, linus)\n  Google    ${google}  (grace, ada)\n  Worker    http://localhost:${worker}\n`);
