import { GithubLogo, GoogleLogo } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Logo } from "../components/TopBar";
import { Button } from "../components/ui";
import { authClient, oauthInFlight } from "../lib/auth-client";
import { safeNext } from "../lib/safe-next";

type Provider = "github" | "google";

/** Sign in with GitHub or Google (Better Auth). Locally both are emulate.dev. */
export function Login() {
  const info = useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`providers: HTTP ${res.status}`);
      return (await res.json()) as { providers: Provider[]; emulated: boolean };
    },
    staleTime: Infinity,
  }).data;
  const [busy, setBusy] = useState<Provider | null>(null);
  const [failed, setFailed] = useState(false);
  const q = new URLSearchParams(location.search);
  const next = q.get("next") ?? "/";
  const forAgent = oauthInFlight();

  const signIn = async (provider: Provider) => {
    setBusy(provider);
    setFailed(false);
    // During an agent's authorization the signed OAuth request rides along (oauthProviderClient)
    // and Better Auth resumes it after the callback; otherwise come back to `next`.
    const res = await authClient.signIn.social({
      provider,
      callbackURL: safeNext(next),
      errorCallbackURL: "/login?error=1",
    });
    if (res.error) {
      setBusy(null);
      setFailed(true);
    }
  };

  return (
    <div className="grid h-full place-items-center px-4">
      <div className="w-full max-w-[380px] rounded-lg bg-surface p-8 shadow-modal">
        <Logo size={32} />
        <h1 className="mt-5 text-h2">{forAgent ? "Sign in to connect your agent." : "Sign in to Forkyard."}</h1>
        <p className="mt-1 text-body">
          {forAgent ? "You'll choose what the agent can act as next." : "Watch your agents work, compare their forks, ship the best one."}
        </p>
        {(failed || q.has("error")) && <p className="mt-3 text-sm text-bad">Sign-in didn't complete. Try again.</p>}
        <div className="mt-6 flex flex-col gap-2">
          {info?.providers.includes("github") && (
            <Button size="lg" variant="primary" disabled={!!busy} onClick={() => void signIn("github")}>
              <GithubLogo size={18} weight="fill" /> {busy === "github" ? "Redirecting…" : "Continue with GitHub"}
            </Button>
          )}
          {info?.providers.includes("google") && (
            <Button size="lg" disabled={!!busy} onClick={() => void signIn("google")}>
              <GoogleLogo size={18} weight="bold" /> {busy === "google" ? "Redirecting…" : "Continue with Google"}
            </Button>
          )}
          {info && !info.providers.length && <p className="text-sm text-body">Sign-in isn't configured on this deployment.</p>}
        </div>
        {info?.emulated && <p className="mt-6 text-xs text-muted">Running locally. GitHub and Google are emulated by emulate.dev.</p>}
      </div>
    </div>
  );
}
