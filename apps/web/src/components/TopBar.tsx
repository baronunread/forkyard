import { DropdownMenu } from "@cloudflare/kumo";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { navigate, type Route } from "../lib/router";
import { useSession } from "../lib/session";
import { useTheme, type ThemePref } from "../lib/theme";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--fy-ink)" />
      <path d="M11 8v16M11 14c0 4 10 2 10 8M21 8v6" stroke="var(--fy-on-ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="11" cy="8" r="2.2" fill="var(--fy-on-ink)" />
      <circle cx="21" cy="8" r="2.2" fill="var(--fy-on-ink)" />
      <circle cx="11" cy="24" r="2.2" fill="var(--fy-on-ink)" />
    </svg>
  );
}

function Slash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0" style={{ color: "var(--fy-border-strong)" }}>
      <path d="M11 2.5 5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) return <img src={url} alt="" className="size-7 rounded-full" style={{ boxShadow: "0 0 0 1px var(--fy-border)" }} />;
  return (
    <span className="flex size-7 items-center justify-center rounded-full text-xs font-medium" style={{ background: "var(--fy-ink)", color: "var(--fy-on-ink)" }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Logo, where you are, search, you. Everything else lives in the avatar menu or ⌘K. */
export function TopBar({ route, onPalette }: { route: Route; onPalette: () => void }) {
  const { state, signOut } = useSession();
  const { pref, setPref } = useTheme();
  const crumbs: { label: string; to: Route }[] = [];
  if (route.name === "yard" || route.name === "task") crumbs.push({ label: route.yard, to: { name: "yard", yard: route.yard } });
  if (route.name === "task") crumbs.push({ label: route.task, to: { name: "task", yard: route.yard, task: route.task } });
  if (route.name === "bench") crumbs.push({ label: "Benchmarks", to: { name: "bench" } });
  const link = (to: Route) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };
  const user = state.status === "signed-in" ? state.user : null;
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-6" style={{ background: "var(--fy-surface)", boxShadow: "inset 0 -1px 0 var(--fy-border)" }}>
      <a href="/" onClick={link({ name: "home" })} className="flex items-center gap-2.5 py-1 pr-1" aria-label="Forkyard home">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.3px] max-sm:hidden">Forkyard</span>
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
      <span className="ml-auto flex items-center gap-3">
        <button onClick={onPalette} className="flex h-8 items-center gap-2 rounded-md px-2 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default" aria-label="Search (⌘K)" title="Search (⌘K)">
          <MagnifyingGlass size={16} />
          <kbd className="fy-kbd max-sm:hidden">⌘K</kbd>
        </button>
        {user && (
          <DropdownMenu>
            <DropdownMenu.Trigger render={<button aria-label="Account" className="rounded-full" />}>
              <Avatar name={user.name} url={user.avatarUrl} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content sideOffset={8} className="min-w-56">
              <DropdownMenu.Label>
                <div className="font-medium text-kumo-default">{user.name}</div>
                {user.email && <div className="truncate text-xs font-normal text-kumo-subtle">{user.email}</div>}
              </DropdownMenu.Label>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => navigate({ name: "home" })}>Yards</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => navigate({ name: "bench" })}>Benchmarks</DropdownMenu.Item>
              <DropdownMenu.LinkItem href="/llms.txt" target="_blank">
                Agent docs
              </DropdownMenu.LinkItem>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>Theme</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
                <DropdownMenu.RadioItem value="system">System</DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="light">Light</DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="dark">Dark</DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => void signOut()}>Sign out</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </span>
    </header>
  );
}
