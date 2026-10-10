import { Banner, ClipboardText } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChatGPTDialog } from "../components/ChatGPTDialog";
import { Button, Card, cx, SectionTitle } from "../components/ui";
import { call, client } from "../lib/api";
import { ago } from "../lib/format";
import { yardsQuery } from "../lib/queries";
import { toastError } from "../lib/toast";
import { useMe } from "../lib/session";

/** Your account: who you are, your model subscription, and the hard limits this deployment enforces. */
export function SettingsPage() {
  const me = useMe();
  const limits = useQuery({ queryKey: ["account", "limits"], queryFn: () => call(client.account.limits.$get()), refetchInterval: 30_000 });
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

        <GitAccess />

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

/**
 * Access tokens: git's password for Forkyard's git address. Your keychain keeps it after the
 * first clone, so your agents run plain git and never see a secret.
 */
function GitAccess() {
  const qc = useQueryClient();
  const key = ["account", "tokens"];
  const tokens = useQuery({ queryKey: key, queryFn: () => call(client.account.tokens.$get()) });
  const yard = useQuery(yardsQuery).data?.[0];
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => call(client.account.tokens.$post({ json: { name: "This computer" } })),
    onSuccess: (r) => {
      setMade(r.token);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toastError(e, "Couldn't make a token"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => call(client.account.tokens[":id"].$delete({ param: { id } })),
    onSuccess: (r) => qc.setQueryData(key, r),
    onError: (e) => toastError(e, "Couldn't revoke it"),
  });
  const clone = `git clone ${location.origin}/git/${yard ? `${yard.owner}/${yard.slug}` : "<owner>/<yard>"}.git`;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <SectionTitle>Git access</SectionTitle>
          <p className="mt-1 text-sm text-body">Your agents push with plain git to Forkyard. Git signs in with a token your keychain keeps, so agents never see it.</p>
        </div>
        <Button size="sm" loading={create.isPending} onClick={() => create.mutate()}>
          New token
        </Button>
      </div>
      {made && (
        <Card className="space-y-3 p-4">
          <p className="text-sm text-fg">Copy it now: it won't be shown again.</p>
          <ClipboardText text={made} />
          <p className="text-sm text-body">Once per computer, in your own terminal: clone a yard, and paste the token when git asks for a password (any username).</p>
          <ClipboardText text={clone} />
        </Card>
      )}
      {(tokens.data?.tokens.length ?? 0) > 0 && (
        <Card className="divide-y divide-line">
          {tokens.data!.tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0 text-sm">
                <span className="font-medium text-fg">{t.name}</span>
                <span className="ml-2 text-body">
                  made {ago(t.createdAt)} · {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}
                </span>
              </div>
              <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === t.id} onClick={() => revoke.mutate(t.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
