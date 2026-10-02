import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePref = "light" | "dark" | "system";
export type ThemeMode = "light" | "dark";

interface ThemeCtx {
  pref: ThemePref;
  mode: ThemeMode;
  setPref(p: ThemePref): void;
  cycle(): void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY = "forkyard.theme";

function systemMode(): ThemeMode {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

/** Light / dark / system, remembered across visits; drives Kumo, diffs and trees from one place. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [system, setSystem] = useState<ThemeMode>(systemMode);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const mode: ThemeMode = pref === "system" ? system : pref;
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  }, []);
  const cycle = useCallback(() => setPref(pref === "light" ? "dark" : pref === "dark" ? "system" : "light"), [pref, setPref]);
  const value = useMemo(() => ({ pref, mode, setPref, cycle }), [pref, mode, setPref, cycle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
