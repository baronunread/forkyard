import { Desktop, MagnifyingGlass, Moon, Sun } from "@phosphor-icons/react";
import { navigate, type Route } from "../lib/router";
import { useTheme } from "../lib/theme";

function Slash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0" style={{ color: "var(--fy-border-strong)" }}>
      <path d="M11 2.5 5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--fy-ink)" />
      <path d="M11 8v16M11 14c0 4 10 2 10 8M21 8v6" stroke="var(--fy-on-ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="11" cy="8" r="2.2" fill="var(--fy-on-ink)" />
      <circle cx="21" cy="8" r="2.2" fill="var(--fy-on-ink)" />
      <circle cx="11" cy="24" r="2.2" fill="var(--fy-on-ink)" />
    </svg>
  );
}

/** 64px nav: logo, slash breadcrumbs, then search / benchmarks / theme on the right. */
export function TopBar({ route, onPalette }: { route: Route; onPalette: () => void }) {
  const { pref, cycle } = useTheme();
  const ThemeIcon = pref === "light" ? Sun : pref === "dark" ? Moon : Desktop;
  const crumbs: { label: string; to: Route }[] = [];
  if (route.name === "yard" || route.name === "task") crumbs.push({ label: route.yard, to: { name: "yard", yard: route.yard } });
  if (route.name === "task") crumbs.push({ label: route.task, to: { name: "task", yard: route.yard, task: route.task } });
  if (route.name === "bench") crumbs.push({ label: "Benchmarks", to: { name: "bench" } });
  const link = (to: Route) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };
  return (
    <header
      className="flex h-16 shrink-0 items-center gap-2 px-6"
      style={{ background: "var(--fy-surface)", boxShadow: "inset 0 -1px 0 var(--fy-border)" }}
    >
      <a href="/" onClick={link({ name: "home" })} className="flex items-center gap-2.5 rounded-md py-1 pr-1">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.3px]">Forkyard</span>
      </a>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <span key={c.label} className="flex min-w-0 items-center gap-1">
            <Slash />
            <a
              href="#"
              onClick={link(c.to)}
              className={`truncate rounded-md px-2 py-1 hover:bg-kumo-tint ${i === crumbs.length - 1 ? "font-medium text-kumo-default" : "text-kumo-subtle"}`}
            >
              {c.label}
            </a>
          </span>
        ))}
      </nav>
      <span className="ml-auto flex items-center gap-2">
        <button
          onClick={onPalette}
          className="flex h-8 w-56 items-center gap-2 rounded-md px-2.5 text-sm text-kumo-subtle hover:text-kumo-default max-md:w-8 max-md:justify-center"
          style={{ background: "var(--fy-surface)", boxShadow: "0 0 0 1px var(--fy-border)" }}
          aria-label="Search and commands"
        >
          <MagnifyingGlass size={14} />
          <span className="max-md:hidden">Search…</span>
          <kbd className="fy-kbd ml-auto max-md:hidden">⌘K</kbd>
        </button>
        <a
          href="/bench"
          onClick={link({ name: "bench" })}
          className={`rounded-md px-3 py-1.5 text-sm hover:bg-kumo-tint ${route.name === "bench" ? "text-kumo-default" : "text-kumo-subtle"}`}
        >
          Benchmarks
        </a>
        <a href="/llms.txt" target="_blank" rel="noreferrer" className="rounded-md px-3 py-1.5 text-sm text-kumo-subtle hover:bg-kumo-tint max-md:hidden">
          Docs
        </a>
        <button
          onClick={cycle}
          title={`Theme: ${pref} (click to change)`}
          aria-label={`Theme: ${pref}`}
          className="flex size-8 items-center justify-center rounded-full text-kumo-subtle hover:text-kumo-default"
          style={{ boxShadow: "0 0 0 1px var(--fy-border)" }}
        >
          <ThemeIcon size={15} />
        </button>
      </span>
    </header>
  );
}
