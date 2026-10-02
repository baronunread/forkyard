import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { call, client, type Me } from "./api";

type User = NonNullable<Me["user"]>;
type State = { status: "loading" } | { status: "signed-out"; dev: boolean } | { status: "signed-in"; user: User; dev: boolean };

const Ctx = createContext<{ state: State; signOut: () => Promise<void>; refresh: () => void } | null>(null);

/** Every screen except /login needs a signed-in person (GitHub, Google, or the dev user locally). */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    call(client.me.$get())
      .then((me) => setState(me.user ? { status: "signed-in", user: me.user, dev: me.devMode } : { status: "signed-out", dev: me.devMode }))
      .catch(() => setState({ status: "signed-out", dev: false }));
  }, [tick]);
  const signOut = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST" });
    setState({ status: "signed-out", dev: state.status !== "loading" && state.dev });
    location.href = "/login";
  }, [state]);
  return <Ctx.Provider value={{ state, signOut, refresh: () => setTick((t) => t + 1) }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
