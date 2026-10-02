import { Loader, Toasty, TooltipProvider } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { CommandMenu } from "./components/CommandMenu";
import { TopBar } from "./components/TopBar";
import { useCommands } from "./lib/commands";
import { navigate, useRoute } from "./lib/router";
import { useSession } from "./lib/session";
import { useTheme } from "./lib/theme";
import { toasts } from "./lib/toast";
import { BenchPage } from "./pages/BenchPage";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { TaskPage } from "./pages/TaskPage";
import { YardPage } from "./pages/YardPage";

export function App() {
  const route = useRoute();
  const { state } = useSession();
  const [palette, setPalette] = useState(false);
  const { setPref } = useTheme();
  useCommands(
    "global",
    [
      { id: "home", group: "Go to", title: "Yards", run: () => navigate({ name: "home" }) },
      { id: "bench", group: "Go to", title: "Benchmarks", run: () => navigate({ name: "bench" }) },
      { id: "theme-light", group: "Theme", title: "Light theme", run: () => setPref("light") },
      { id: "theme-dark", group: "Theme", title: "Dark theme", run: () => setPref("dark") },
      { id: "theme-system", group: "Theme", title: "System theme", run: () => setPref("system") },
      { id: "llms", group: "Agents", title: "Agent docs (llms.txt)", run: () => window.open("/llms.txt", "_blank") },
    ],
    [],
  );

  useEffect(() => {
    if (state.status === "signed-out" && route.name !== "login") navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, true);
    if (state.status === "signed-in" && route.name === "login") {
      const next = new URLSearchParams(location.search).get("next") ?? "/";
      // Server-rendered pages (the agent consent screen) need a real navigation.
      if (next.startsWith("/authorize")) location.replace(next);
      else navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/", true);
    }
  }, [state.status, route.name]);

  if (route.name === "login")
    return (
      <Toasty toastManager={toasts}>
        <Login />
      </Toasty>
    );
  if (state.status !== "signed-in")
    return (
      <div className="grid h-full place-items-center">
        <Loader />
      </div>
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
            {route.name === "yard" && (
              <div className="fy-scroll h-full">
                <YardPage key={route.yard} yard={route.yard} />
              </div>
            )}
            {route.name === "task" && <TaskPage key={`${route.yard}/${route.task}`} yard={route.yard} task={route.task} agentParam={route.agent} fileParam={route.file} />}
            {route.name === "bench" && <BenchPage />}
          </div>
        </div>
        <CommandMenu open={palette} setOpen={setPalette} />
      </TooltipProvider>
    </Toasty>
  );
}
