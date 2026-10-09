import { Banner } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChatGPTDialog } from "../components/ChatGPTDialog";
import { Button, Card, cx, SectionTitle } from "../components/ui";
import { call, client } from "../lib/api";
import { useMe } from "../lib/session";

/** Your account: who you are, your model subscription, and the hard limits this deployment enforces. */
export function SettingsPage() {
  const me = useMe();
  const limits = useQuery({ queryKey: ["me", "limits"], queryFn: () => call(client.me.limits.$get()), refetchInterval: 30_000 });
  const [chatgpt, setChatgpt] = useState(false);

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-3xl space-y-6 p-8 max-sm:p-4">
        <h1 className="text-h1">Settings</h1>

        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="truncate font-medium text-fg">{me?.user?.name ?? "—"}</div>
            <div className="truncate text-sm text-body">{me?.user?.email}</div>
          </div>
          <Button onClick={() => setChatgpt(true)}>ChatGPT for agents and reviews…</Button>
        </Card>

        <section className="space-y-3">
          <div>
            <SectionTitle>Limits</SectionTitle>
            <p className="mt-1 text-sm text-body">Hard caps that keep this deployment's cost bounded. Past one, Forkyard refuses the work instead of billing for it.</p>
          </div>
          {limits.data?.paused && <Banner variant="error">This Forkyard is paused by its operator: no new yards, tasks or model calls.</Banner>}
          <Card className="divide-y divide-line">
            {(limits.data?.limits ?? []).map((l) => (
              <LimitRow {...l} key={l.key} />
            ))}
            {limits.isPending && <div className="p-4 text-sm text-body">Loading…</div>}
          </Card>
        </section>
      </div>
      <ChatGPTDialog open={chatgpt} setOpen={setChatgpt} />
    </div>
  );
}

function LimitRow({ label, scope, limit, used, hint }: { label: string; scope: string; limit: number | null; used: number | null; hint: string }) {
  const ratio = limit && used !== null ? Math.min(1, used / limit) : 0;
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-fg">{label}</span>
          <span className="ml-2 text-xs text-muted">{scope === "account" ? "your account" : "whole deployment"}</span>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-fg">
          {limit === null ? "no limit" : used === null ? limit : `${used} / ${limit}`}
        </span>
      </div>
      {limit !== null && used !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
          <div className={cx("h-full rounded-full", ratio >= 0.8 ? "bg-overlap" : "bg-ink")} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <p className="text-xs text-body">{hint}</p>
    </div>
  );
}
