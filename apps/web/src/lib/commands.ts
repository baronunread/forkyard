import { useEffect, useSyncExternalStore } from "react";

export interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  run: () => void;
}

const scopes = new Map<string, Command[]>();
const listeners = new Set<() => void>();
let snapshot: Command[] = [];

function emit() {
  snapshot = [...scopes.values()].flat();
  for (const l of listeners) l();
}

/** Register commands for the command palette while a component is mounted. */
export function useCommands(scope: string, commands: Command[], deps: unknown[]) {
  useEffect(() => {
    scopes.set(scope, commands);
    emit();
    return () => {
      scopes.delete(scope);
      emit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ...deps]);
}

export function useAllCommands(): Command[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
