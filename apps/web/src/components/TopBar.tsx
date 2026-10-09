import { DropdownMenu } from "@cloudflare/kumo";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { yardsQuery } from "../lib/queries";
import { useMe, useSignOut } from "../lib/session";
import { useTheme, type ThemePref } from "../lib/theme";
import { ChatGPTDialog } from "./ChatGPTDialog";
import { Kbd } from "./ui";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="text-ink">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <g className="text-on-ink">
        <path d="M11 8v16M11 14c0 4 10 2 10 8M21 8v6" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <circle cx="11" cy="8" r="2.2" fill="currentColor" />
        <circle cx="21" cy="8" r="2.2" fill="currentColor" />
        <circle cx="11" cy="24" r="2.2" fill="currentColor" />
      </g>
    </svg>
  );
}

function Slash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-line-strong">
      <path d="M11 2.5 5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) return <img src={url} alt="" onError={() => setBroken(true)} className="size-7 rounded-full ring-1 ring-line" />;
  return <span className="flex size-7 items-center justify-center rounded-full bg-ink text-xs font-medium text-on-ink">{name.slice(0, 1).toUpperCase()}</span>;
}

const crumb = "truncate rounded-md px-2 py-1 hover:bg-hover";

/** Logo, where you are, search, you. Everything else lives in the avatar menu or ⌘K. */
export function TopBar({ onPalette }: { onPalette: () => void }) {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { pref, setPref } = useTheme();
  const params = useParams({ strict: false });
  const onBench = useMatchRoute()({ to: "/bench" });
  const yards = useQuery(yardsQuery).data;
  const yardName = params.yard ? (yards?.find((y) => y.owner === params.owner && y.slug === params.yard)?.name ?? params.yard) : null;
  const user = me?.user;
  const [chatgpt, setChatgpt] = useState(false);
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 bg-surface px-6 shadow-[inset_0_-1px_0_var(--color-line)]">
      <Link to="/" className="flex items-center gap-2.5 py-1 pr-1" aria-label="Forkyard overview">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.3px] max-sm:hidden">Forkyard</span>
      </Link>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        {params.yard && (
          <span className="flex min-w-0 items-center gap-1">
            <Slash />
            <Link to="/$owner/$yard" params={{ owner: params.owner!, yard: params.yard }} className={`${crumb} ${params.task ? "text-body" : "font-medium text-fg"}`}>
              {yardName}
            </Link>
          </span>
        )}
        {params.yard && params.task && (
          <span className="flex min-w-0 items-center gap-1">
            <Slash />
            <Link to="/$owner/$yard/t/$task" params={{ owner: params.owner!, yard: params.yard, task: params.task }} className={`${crumb} font-medium text-fg`}>
              {params.task}
            </Link>
          </span>
        )}
        {onBench && (
          <span className="flex min-w-0 items-center gap-1">
            <Slash />
            <span className={`${crumb} font-medium text-fg`}>Benchmarks</span>
          </span>
        )}
      </nav>
      <span className="ml-auto flex items-center gap-3">
        <button onClick={onPalette} className="flex h-8 items-center gap-2 rounded-md px-2 text-body hover:bg-hover hover:text-fg" aria-label="Search (⌘K)" title="Search (⌘K)">
          <MagnifyingGlass size={16} />
          <Kbd className="max-sm:hidden">⌘K</Kbd>
        </button>
        {user && (
          <DropdownMenu>
            <DropdownMenu.Trigger render={<button aria-label="Account" className="rounded-full" />}>
              <Avatar name={user.name} url={user.image} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content sideOffset={8} className="min-w-56">
              {/* Who you are: plain text, not a menu label (labels must sit inside a group). */}
              <div className="px-2 py-1.5 text-sm">
                <div className="font-medium text-fg">{user.name}</div>
                {user.email && <div className="truncate text-xs text-body">{user.email}</div>}
              </div>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onClick={() => void navigate({ to: "/" })}>Overview</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => void navigate({ to: "/bench" })}>Benchmarks</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => void navigate({ to: "/settings" })}>Settings and limits</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => setChatgpt(true)}>ChatGPT for reviews…</DropdownMenu.Item>
              <DropdownMenu.LinkItem href="/llms.txt" target="_blank">
                Agent docs
              </DropdownMenu.LinkItem>
              <DropdownMenu.Separator />
              <DropdownMenu.RadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
                <DropdownMenu.Label>Theme</DropdownMenu.Label>
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
      <ChatGPTDialog open={chatgpt} setOpen={setChatgpt} />
    </header>
  );
}
