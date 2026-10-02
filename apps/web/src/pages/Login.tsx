import { GithubLogo, GoogleLogo, Terminal } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Logo } from "../components/TopBar";

/** Sign in with GitHub or Google. Locally, with no provider configured, a dev user stands in. */
export function Login() {
  const [info, setInfo] = useState<{ providers: string[]; dev: boolean } | null>(null);
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  const error = new URLSearchParams(location.search).get("error");
  useEffect(() => {
    fetch("/auth/providers").then((r) => r.json()).then(setInfo, () => setInfo({ providers: [], dev: false }));
  }, []);
  const q = `?next=${encodeURIComponent(next)}`;
  const forAgent = next.startsWith("/authorize");
  return (
    <div className="grid h-full place-items-center px-4">
      <div className="fy-card w-full max-w-[380px] p-8" style={{ boxShadow: "var(--fy-shadow-modal)" }}>
        <Logo size={32} />
        <h1 className="fy-h2 mt-5">{forAgent ? "Sign in to connect your agent." : "Sign in to Forkyard."}</h1>
        <p className="mt-1 text-kumo-subtle">
          {forAgent ? "You'll choose what the agent can act as next." : "Watch your agents work, compare their forks, ship the best one."}
        </p>
        {error && <p className="mt-3 text-sm text-kumo-danger">Sign-in didn't complete. Try again.</p>}
        <div className="mt-6 flex flex-col gap-2">
          {info?.providers.includes("github") && (
            <a className="fy-btn fy-btn-primary" href={`/auth/github${q}`}>
              <GithubLogo size={18} weight="fill" /> Continue with GitHub
            </a>
          )}
          {info?.providers.includes("google") && (
            <a className="fy-btn fy-btn-secondary" href={`/auth/google${q}`}>
              <GoogleLogo size={18} weight="bold" /> Continue with Google
            </a>
          )}
          {info?.dev && (
            <form method="post" action={`/auth/dev${q}`}>
              <button className={`fy-btn w-full ${info.providers.length ? "fy-btn-secondary" : "fy-btn-primary"}`}>
                <Terminal size={18} /> Continue as dev user
              </button>
            </form>
          )}
          {info && !info.providers.length && !info.dev && <p className="text-sm text-kumo-subtle">Sign-in isn't configured on this deployment.</p>}
        </div>
      </div>
    </div>
  );
}
