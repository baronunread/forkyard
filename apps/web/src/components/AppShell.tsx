import { useHotkey } from "@tanstack/react-hotkeys";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCommands } from "../lib/commands";
import { useTheme } from "../lib/theme";
import { CommandMenu } from "./CommandMenu";
import { TopBar } from "./TopBar";

/** Signed-in frame: top bar, the page, and the ⌘K palette. */
export function AppShell() {
  const [palette, setPalette] = useState(false);
  const { setPref } = useTheme();
  const navigate = useNavigate();
  useHotkey("Mod+K", () => setPalette((o) => !o), { preventDefault: true });
  useCommands(
    "global",
    [
      { id: "home", group: "Go to", title: "Home", run: () => void navigate({ to: "/" }) },
      { id: "bench", group: "Go to", title: "Benchmarks", run: () => void navigate({ to: "/bench" }) },
      { id: "theme-light", group: "Theme", title: "Light theme", run: () => setPref("light") },
      { id: "theme-dark", group: "Theme", title: "Dark theme", run: () => setPref("dark") },
      { id: "theme-system", group: "Theme", title: "System theme", run: () => setPref("system") },
      { id: "llms", group: "Agents", title: "Agent docs (llms.txt)", run: () => window.open("/llms.txt", "_blank") },
    ],
    [],
  );
  return (
    <div className="flex h-full flex-col">
      <TopBar onPalette={() => setPalette(true)} />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <CommandMenu open={palette} setOpen={setPalette} />
    </div>
  );
}
