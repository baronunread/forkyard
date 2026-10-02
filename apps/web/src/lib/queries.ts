import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, call, client, taskRoute, yardRoute } from "./api";

/**
 * Every server read is a TanStack Query. Keys nest under the yard, so a live
 * event for a yard can invalidate everything about it in one call:
 *
 *   ["yards"]                              the list (with summaries)
 *   ["yard", y]                            status (tasks, agents, overlaps, recent events)
 *   ["yard", y, "base"]                    base branch log
 *   ["yard", y, "latency"]
 *   ["yard", y, "task", t]                 task detail
 *   ["yard", y, "task", t, "compare"]
 *   ["yard", y, "task", t, "events"]
 *   ["file", y, t, path, agents, heads]    per-file comparison, immutable per heads
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    try {
      return await call(client.me.$get());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: 60_000,
});

export const yardsQuery = queryOptions({ queryKey: ["yards"], queryFn: () => call(client.yards.$get()) });

export const yardQuery = (yard: string) => queryOptions({ queryKey: ["yard", yard], queryFn: () => call(yardRoute.$get({ param: { yard } })) });

export const baseLogQuery = (yard: string) =>
  queryOptions({ queryKey: ["yard", yard, "base"], queryFn: () => call(yardRoute.base.$get({ param: { yard } })) });

export const latencyQuery = (yard: string) =>
  queryOptions({ queryKey: ["yard", yard, "latency"], queryFn: () => call(yardRoute.latency.$get({ param: { yard } })) });

export const taskQuery = (yard: string, task: string) =>
  queryOptions({ queryKey: ["yard", yard, "task", task], queryFn: () => call(taskRoute.$get({ param: { yard, task } })) });

export const compareQuery = (yard: string, task: string) =>
  queryOptions({ queryKey: ["yard", yard, "task", task, "compare"], queryFn: () => call(taskRoute.compare.$get({ param: { yard, task } })) });

export const taskEventsQuery = (yard: string, task: string) =>
  queryOptions({
    queryKey: ["yard", yard, "task", task, "events"],
    queryFn: async () => {
      const r = await call(yardRoute.events.$get({ param: { yard }, query: { since: "0", limit: "1000", taskId: task } }));
      return r.events.filter((e) => e.taskId === task || e.taskId === null);
    },
    // Kept current by the live socket (appended in place), not by refetching.
    staleTime: Infinity,
  });

/**
 * Base + each agent's version of one file, with hunks. Keyed by the agents'
 * head commits, so a new push is a new key and old results never go stale.
 */
export const fileCompareQuery = (yard: string, task: string, path: string, heads: string, agents?: string[]) =>
  queryOptions({
    queryKey: ["file", yard, task, path, agents?.join(",") ?? "*", heads],
    queryFn: () => call(taskRoute.compare.file.$get({ param: { yard, task }, query: { path, agents: agents?.join(",") } })),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

export const benchRunsQuery = queryOptions({ queryKey: ["bench"], queryFn: () => call(client.bench.$get()) });

/** Heads of every agent on a task, the cache key for file comparisons. */
export function headsOf(agents: { headCommit: string | null }[]): string {
  return agents.map((a) => a.headCommit ?? "-").join(",");
}
