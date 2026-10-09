import type { Agent, AgentCredential, Task } from "@forkyard/shared";
import type { ApiType } from "@forkyard/worker/types";
import { hc } from "hono/client";

/** Optional key for deployments that are not behind Cloudflare Access. */
export function getKey(): string | null {
  try {
    return localStorage.getItem("forkyard.key");
  } catch {
    return null;
  }
}

export function setKey(key: string | null): void {
  try {
    if (key) localStorage.setItem("forkyard.key", key);
    else localStorage.removeItem("forkyard.key");
  } catch {
    /* ignore */
  }
}

function headers(): Record<string, string> {
  const k = getKey();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

export const client = hc<ApiType>("/api", { headers });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The JSON body type of the success responses in a hono/client response union. */
type SuccessJson<R> = R extends { ok: false } ? never : R extends { json(): Promise<infer T> } ? T : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res<F extends (...args: any[]) => Promise<unknown>> = SuccessJson<Awaited<ReturnType<F>>>;

/** Await a hono/client response, throwing the server's `{error}` on failure. */
export async function call<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(p: Promise<R>): Promise<SuccessJson<R>> {
  const res = await p;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as unknown as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<SuccessJson<R>>;
}

const y = client.yards[":yard"];
const t = y.tasks[":task"];

export type Me = Res<typeof client.me.$get>;
export type YardList = Res<typeof client.yards.$get>;
export type Inbox = Res<typeof client.inbox.$get>;
export type InboxAsk = Inbox["asks"][number];
export type YardStatus = Res<typeof y.$get>;
export type TaskDetail = Res<typeof t.$get>;
export type TaskAgent = TaskDetail["agents"][number];
export type Compare = Res<typeof t.compare.$get>;
export type FileCompare = Res<(typeof t.compare)["file"]["$get"]>;
export type DecidePreview = Res<(typeof t.decide)["preview"]["$post"]>;
/** The non-streaming task_create response (the route also streams NDJSON, which erases its type). */
export type CreatedTask = { task: Task; agents: (Agent & { previewUrl: string | null })[]; credentials: AgentCredential[] };
export type CodeTree = Res<(typeof y.code)["tree"]["$get"]>;
export type CodeFile = Res<(typeof y.code)["file"]["$get"]>;
export type CodeLog = Res<(typeof y.code)["log"]["$get"]>;
export type Change = CodeLog["changes"][number];
export type BenchRuns = Res<typeof client.bench.$get>;
export type Latency = Res<typeof y.latency.$get>;

export { y as yardRoute, t as taskRoute };
