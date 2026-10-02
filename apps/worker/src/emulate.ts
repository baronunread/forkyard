import type { Env } from "./env";

/**
 * Local development against emulate.dev (`npx emulate`): GitHub and Google
 * run on localhost with seeded users, so sign-in is the real OAuth flow with
 * no real apps or network. Better Auth's providers have the public endpoints
 * built in, so in emulate mode we point them at the emulators:
 *
 *  - server-side calls (token exchange, profile) go through a fetch that
 *    swaps the provider hosts for the emulator URLs;
 *  - the authorization URL handed to the browser is rewritten the same way.
 *
 * Off unless EMULATE_GITHUB_URL / EMULATE_GOOGLE_URL are set (local vars only).
 */

interface Emulated {
  rewrite(url: string): string;
  rewriteAuthResponse(req: Request, res: Response): Promise<Response>;
}

let cached: { key: string; value: Emulated | null } | null = null;

export function emulatedProviders(env: Env): Emulated | null {
  const key = `${env.EMULATE_GITHUB_URL ?? ""}|${env.EMULATE_GOOGLE_URL ?? ""}`;
  if (cached?.key === key) return cached.value;
  const value = build(env);
  cached = { key, value };
  return value;
}

function build(env: Env): Emulated | null {
  const gh = env.EMULATE_GITHUB_URL?.replace(/\/$/, "");
  const google = env.EMULATE_GOOGLE_URL?.replace(/\/$/, "");
  if (!gh && !google) return null;
  const map: [string, string][] = [];
  if (gh) map.push(["https://github.com/", `${gh}/`], ["https://api.github.com/", `${gh}/`]);
  if (google)
    map.push(
      ["https://accounts.google.com/", `${google}/`],
      ["https://oauth2.googleapis.com/token", `${google}/oauth2/token`],
      ["https://www.googleapis.com/", `${google}/`],
    );
  const rewrite = (url: string) => {
    for (const [from, to] of map) if (url.startsWith(from)) return to + url.slice(from.length);
    return url;
  };

  // Server-side provider calls.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const to = rewrite(url);
    if (to === url) return realFetch(input, init);
    return realFetch(input instanceof Request ? new Request(to, input) : to, init);
  }) as typeof fetch;

  return {
    rewrite,
    // The browser-facing authorization URL: JSON from /sign-in/social, or a redirect.
    async rewriteAuthResponse(req, res) {
      const headers = new Headers(res.headers);
      const loc = res.headers.get("Location");
      if (loc) headers.set("Location", rewrite(loc));
      if (!new URL(req.url).pathname.endsWith("/sign-in/social") || !res.headers.get("Content-Type")?.includes("json"))
        return loc ? new Response(res.body, { status: res.status, headers }) : res;
      const body = (await res.json()) as { url?: string };
      if (body.url) body.url = rewrite(body.url);
      headers.delete("Content-Length");
      return new Response(JSON.stringify(body), { status: res.status, headers });
    },
  };
}
