import { useCallback, useState } from "react";

/** A per-viewer preference in localStorage (split/unified, wrap). */
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
