import { Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AgentBadge } from "../components/AgentChip";
import { Logo } from "../components/TopBar";
import { Button, Eyebrow } from "../components/ui";
import { call, client } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { useMe } from "../lib/session";

type Seat = { value: string; yard: string; task: string; agent: { id: string; name: string; color: string; initials: string }; role: string };
type Redirect = { url?: string; redirect_uri?: string };

/**
 * An agent is connecting over OAuth. Better Auth sends the person here after
 * sign-in (postLogin) and again for consent; one screen does both: pick what
 * the agent acts as (you, or one agent seat), then Connect.
 */
export function Connect() {
  const me = useMe();
  const q = new URLSearchParams(location.search);
  const clientId = q.get("client_id") ?? "";
  const consentStep = q.has("ba_pl");
  const clientName = useQuery({
    queryKey: ["oauth-client", clientId],
    queryFn: async () => (await authClient.$fetch<{ client_name?: string }>("/oauth2/public-client", { query: { client_id: clientId } })).data?.client_name || "An app",
  }).data;
  const seats: Seat[] | null = useQuery({ queryKey: ["connect-seats"], queryFn: async () => (await call(client.connect.seats.$get())).seats }).data ?? null;
  const [seat, setSeat] = useState("me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const go = (r: Redirect) => location.assign(r.url ?? r.redirect_uri ?? "/");
  // Plain fetch, not authClient: its redirect plugin would follow `{redirect, url}` mid-sequence.
  const oauth = async (path: string, body: Record<string, unknown>, from = location.href): Promise<Redirect> => {
    const res = await fetch(`/api/auth/oauth2/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, oauth_query: new URL(from).search.slice(1) }),
    });
    const data = (await res.json().catch(() => ({}))) as Redirect & { error_description?: string; message?: string };
    if (!res.ok) throw new Error(data.error_description ?? data.message ?? `authorization failed (${res.status})`);
    return data;
  };
  const consent = (accept: boolean, from?: string) => oauth("consent", { accept }, from);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(client.connect.seat.$post({ json: { clientId, seat } }));
      if (consentStep) return go(await consent(true));
      // Seat picked: let the authorization continue. If it stops at consent (this page again),
      // the click above already was that consent.
      const cont = await oauth("continue", { postLogin: true });
      const next = new URL(cont.url ?? cont.redirect_uri ?? "/", location.origin);
      if (next.origin === location.origin && next.pathname === "/connect") return go(await consent(true, next.href));
      go({ url: next.href });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async () => {
    setBusy(true);
    go(await consent(false).catch(() => ({ url: "/" })));
  };

  const user = me?.user ?? null;
  const name = clientName ?? "…";
  return (
    <div className="grid h-full place-items-center px-4 py-8">
      <div className="w-full max-w-[460px] rounded-lg bg-surface p-8 shadow-modal">
        <Logo size={32} />
        <h1 className="mt-5 text-h2">Connect {name} to Forkyard</h1>
        <p className="mt-1 text-body">
          Choose whether it works as {user ? <b className="font-medium text-fg">{user.name}</b> : "you"} or as one agent seat.
        </p>

        <Eyebrow className="mt-6 mb-2">Act as</Eyebrow>
        {seats === null ? (
          <div className="py-6">
            <Loader />
          </div>
        ) : (
          <div role="radiogroup" className="flex max-h-[320px] flex-col gap-2 overflow-auto p-0.5">
            <Option checked={seat === "me"} onSelect={() => setSeat("me")} title="You" detail="Works in all your yards: creates tasks, compares forks, decides." />
            {seats.map((s) => (
              <Option
                key={s.value}
                checked={seat === s.value}
                onSelect={() => setSeat(s.value)}
                title={
                  <span className="flex items-center gap-2">
                    <AgentBadge agent={s.agent} size={18} />
                    {s.agent.name}
                    {s.role === "judge" && <span className="text-body">· judge</span>}
                  </span>
                }
                detail={`${s.task} — ${s.yard}`}
              />
            ))}
            {!seats.length && <p className="px-1 text-sm text-body">No open agent seats. Create a task to get some.</p>}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <div className="mt-6 flex gap-2">
          <Button size="lg" className="flex-1" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" className="flex-1" disabled={busy || seats === null} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Option({ checked, onSelect, title, detail }: { checked: boolean; onSelect: () => void; title: React.ReactNode; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left ${checked ? "ring-2 ring-ink" : "ring-1 ring-line hover:bg-hover"}`}
    >
      <span
        className={`mt-1 size-4 shrink-0 rounded-full ${checked ? "shadow-[inset_0_0_0_5px_var(--color-ink)]" : "shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]"}`}
        aria-hidden
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="line-clamp-2 block text-[13px] text-body">{detail}</span>
      </span>
    </button>
  );
}
