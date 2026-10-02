import { Button } from "@cloudflare/kumo";
import { ChartBar, Desktop, MagnifyingGlass, Moon, Sun } from "@phosphor-icons/react";
import { useTheme } from "../lib/theme";
import { navigate, type Route } from "../lib/router";

export function TopBar({ route, onPalette }: { route: Route; onPalette: () => void }) {
  const { pref, cycle } = useTheme();
  const icon = pref === "light" ? <Sun /> : pref === "dark" ? <Moon /> : <Desktop />;
  const crumbs: { label: string; to: Route }[] = [];
  if (route.name === "yard" || route.name === "task") crumbs.push({ label: route.yard, to: { name: "yard", yard: route.yard } });
  if (route.name === "task") crumbs.push({ label: route.task, to: { name: "task", yard: route.yard, task: route.task } });
  if (route.name === "bench") crumbs.push({ label: "benchmarks", to: { name: "bench" } });
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-hairline bg-kumo-base px-3">
      <a
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate({ name: "home" });
        }}
        className="flex items-center gap-2 font-semibold"
      >
        <img src="/favicon.svg" alt="" className="size-6" />
        Forkyard
      </a>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-kumo-subtle">
        {crumbs.map((c) => (
          <span key={c.label} className="flex min-w-0 items-center gap-1">
            <span>/</span>
            <a
              href="#"
              className="truncate hover:text-kumo-default"
              onClick={(e) => {
                e.preventDefault();
                navigate(c.to);
              }}
            >
              {c.label}
            </a>
          </span>
        ))}
      </nav>
      <span className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" icon={<MagnifyingGlass />} onClick={onPalette}>
          <span className="hidden sm:inline">Search</span> <kbd className="fy-kbd ml-1">⌘K</kbd>
        </Button>
        <Button size="sm" variant="ghost" icon={<ChartBar />} onClick={() => navigate({ name: "bench" })}>
          <span className="hidden sm:inline">Benchmarks</span>
        </Button>
        <Button size="sm" variant="ghost" icon={icon} onClick={cycle} title={`Theme: ${pref} (click to change)`} aria-label={`Theme: ${pref}`}>
          <span className="hidden sm:inline">{pref}</span>
        </Button>
      </span>
    </div>
  );
}
