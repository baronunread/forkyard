import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { useState } from "react";
import { CommandMenu } from "./components/CommandMenu";
import { TopBar } from "./components/TopBar";
import { useCommands } from "./lib/commands";
import { navigate, useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { toasts } from "./lib/toast";
import { BenchPage } from "./pages/BenchPage";
import { Home } from "./pages/Home";
import { TaskPage } from "./pages/TaskPage";
import { YardPage } from "./pages/YardPage";

export function App() {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  const { setPref } = useTheme();
  useCommands(
    "global",
    [
      { id: "home", group: "Go to", title: "All yards", run: () => navigate({ name: "home" }) },
      { id: "bench", group: "Go to", title: "Benchmarks", run: () => navigate({ name: "bench" }) },
      { id: "theme-light", group: "Theme", title: "Light theme", run: () => setPref("light") },
      { id: "theme-dark", group: "Theme", title: "Dark theme", run: () => setPref("dark") },
      { id: "theme-system", group: "Theme", title: "System theme", run: () => setPref("system") },
      { id: "llms", group: "Agents", title: "Open llms.txt (how agents join)", run: () => window.open("/llms.txt", "_blank") },
    ],
    [],
  );
  return (
    <Toasty toastManager={toasts}>
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <TopBar route={route} onPalette={() => setPalette(true)} />
          <div className="min-h-0 flex-1">
            {route.name === "home" && (
              <div className="fy-scroll h-full">
                <Home />
              </div>
            )}
            {route.name === "yard" && <YardPage key={route.yard} yard={route.yard} />}
            {route.name === "task" && <TaskPage key={`${route.yard}/${route.task}`} yard={route.yard} task={route.task} agentParam={route.agent} fileParam={route.file} />}
            {route.name === "bench" && <BenchPage />}
          </div>
        </div>
        <CommandMenu open={palette} setOpen={setPalette} />
      </TooltipProvider>
    </Toasty>
  );
}
