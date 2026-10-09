import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Small helpers shared by the seed, bench and e2e scripts. Node 22+, no deps. */

/** `bun run dev` behind portless serves the app at https://forkyard.localhost; plain wrangler dev at :8787. */
const DEV = "https://forkyard.localhost";
const devUp = await fetch(`${DEV}/api/me`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
export const BASE = (process.env.FORKYARD_URL ?? (devUp ? DEV : "http://localhost:8787")).replace(/\/$/, "");
export const ADMIN_KEY = process.env.FORKYARD_ADMIN_KEY ?? "";

const run = promisify(execFile);

export function arg(name: string, fallback?: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(pre));
  if (!hit) return fallback;
  return hit === `--${name}` ? "true" : hit.slice(pre.length);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const key = init.key ?? ADMIN_KEY;
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? (init.body ? "POST" : "GET")} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Minimal MCP client over streamable HTTP (stateless JSON-RPC). */
export class Mcp {
  private id = 0;
  constructor(private key: string) {}
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: T }> {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const raw = await res.text();
    const body = raw.trimStart().startsWith("{")
      ? raw
      : raw
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("");
    const msg = JSON.parse(body) as {
      result?: { content: { text: string }[]; structuredContent?: T; isError?: boolean };
      error?: { message: string };
    };
    if (msg.error) throw new Error(`${tool}: ${msg.error.message}`);
    const text = msg.result?.content?.map((c) => c.text).join("\n") ?? "";
    if (msg.result?.isError) throw new Error(`${tool}: ${text}`);
    return { text, data: msg.result?.structuredContent as T };
  }
}

export class Git {
  constructor(
    readonly dir: string,
    private token: string,
    private who: { name: string; email: string },
  ) {}
  async run(...args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${this.token}`, "-c", "push.negotiate=false", ...args], {
      cwd: this.dir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: this.who.name,
        GIT_AUTHOR_EMAIL: this.who.email,
        GIT_COMMITTER_NAME: this.who.name,
        GIT_COMMITTER_EMAIL: this.who.email,
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  }
  static async clone(remote: string, dir: string, token: string, who: { name: string; email: string }): Promise<Git> {
    await mkdir(dirname(dir), { recursive: true });
    const g = new Git(dirname(dir), token, who);
    await g.run("clone", "-q", remote, dir);
    return new Git(dir, token, who);
  }
  async write(path: string, contents: string): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  async commitAndPush(message: string): Promise<string> {
    await this.run("add", "-A");
    await this.run("commit", "-q", "-m", message);
    await this.run("push", "-q", "origin", "HEAD");
    return this.run("rev-parse", "HEAD");
  }
}

export function log(who: string, msg: string): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`${t} ${who.padEnd(6)} ${msg}`);
}

/**
 * Watch a yard's WebSocket; resolves `waitFor` promises on matching events.
 * Reconnects with `?since=<last seq>` if the socket drops, so a dev-server
 * restart doesn't lose events (they arrive late, and are timed when they arrive).
 */
export async function watchYard(yardId: string, key = ADMIN_KEY) {
  type Ev = { seq: number; type: string; agentId: string | null; taskId: string | null; data: Record<string, unknown> };
  const waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev & { at: number }) => void }[] = [];
  const seen: (Ev & { at: number })[] = [];
  let last = 0;
  let closed = false;
  let reconnects = 0;
  let current: WebSocket | null = null;
  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const q = new URLSearchParams();
      if (key) q.set("key", key);
      if (last) q.set("since", String(last));
      const url = `${BASE.replace(/^http/, "ws")}/api/yards/${yardId}/ws?${q}`;
      const ws = new WebSocket(url);
      ws.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as { kind: string; event?: Ev };
        if (msg.kind !== "event" || !msg.event || msg.event.seq <= last) return;
        last = msg.event.seq;
        const e = { ...msg.event, at: performance.now() };
        seen.push(e);
        for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
      });
      ws.addEventListener("open", () => resolve((current = ws)));
      ws.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)));
      ws.addEventListener("close", () => {
        if (closed) return;
        reconnects++;
        const retry = () => connect().catch(() => setTimeout(retry, 1000));
        setTimeout(retry, 500);
      });
    });
  await connect();
  return {
    seen,
    get reconnects() {
      return reconnects;
    },
    close() {
      closed = true;
      current?.close();
    },
    waitFor(pred: (e: Ev) => boolean, timeoutMs = 30_000): Promise<Ev & { at: number }> {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) (waiters.splice(i, 1), reject(new Error("timed out waiting for event")));
        }, timeoutMs);
      });
    },
  };
}
