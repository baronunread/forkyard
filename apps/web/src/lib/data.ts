import { useCallback, useEffect, useRef, useState } from "react";
import { call, taskRoute, type FileCompare } from "./api";

export interface Async<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount / deps change; `reload` refetches without clearing current data (no flicker on live updates). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef("");
  const key = JSON.stringify(deps);
  useEffect(() => {
    let alive = true;
    if (keyRef.current !== key) {
      setData(null);
      keyRef.current = key;
    }
    setLoading(true);
    fnRef
      .current()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Debounce a callback (coalesces bursts of live events into one refetch). */
export function useDebounced(fn: () => void, ms: number): () => void {
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  return useCallback(() => {
    clearTimeout(t.current);
    t.current = setTimeout(() => f.current(), ms);
  }, [ms]);
}

const fileCache = new Map<string, Promise<FileCompare>>();

/**
 * Per-file comparison (base + each agent's version + hunks). Keyed by the
 * agents' head commits, so a new push naturally misses the cache.
 */
export function fetchFileCompare(yard: string, task: string, path: string, heads: string, agents?: string[]): Promise<FileCompare> {
  const key = `${yard}/${task}/${path}/${agents?.join(",") ?? "*"}/${heads}`;
  const cached = fileCache.get(key);
  if (cached) return cached;
  const p: Promise<FileCompare> = call(taskRoute.compare.file.$get({ param: { yard, task }, query: { path, agents: agents?.join(",") } }));
  p.catch(() => fileCache.delete(key));
  fileCache.set(key, p);
  if (fileCache.size > 400) fileCache.delete(fileCache.keys().next().value!);
  return p;
}

export function usePersistent<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return (typeof initial === "boolean" ? raw === "true" : raw) as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, String(n));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
