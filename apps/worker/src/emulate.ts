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

/** Provider URL prefixes → emulator URL prefixes. */
function hostMap(gh: string | undefined, google: string | undefined): [string, string][] {
  const map: [string, string][] = [];
  if (gh) map.push(["https://github.com/", `${gh}/`], ["https://api.github.com/", `${gh}/`]);
  if (google)
    map.push(
      ["https://accounts.google.com/", `${google}/`],
      ["https://oauth2.googleapis.com/token", `${google}/oauth2/token`],
      ["https://www.googleapis.com/", `${google}/`],
    );
  return map;
}

const rewriter = (map: [string, string][]) => (url: string) => {
  for (const [from, to] of map) if (url.startsWith(from)) return to + url.slice(from.length);
  return url;
};

function build(env: Env): Emulated | null {
  const strip = (u?: string) => u?.replace(/\/$/, "");
  const gh = strip(env.EMULATE_GITHUB_URL);
  const google = strip(env.EMULATE_GOOGLE_URL);
  if (!gh && !google) return null;
  // The browser goes to the public URLs (e.g. https://github.emulate.forkyard.localhost through
  // portless); the Worker can call the emulators directly when *_INTERNAL_URL is set.
  const rewrite = rewriter(hostMap(gh, google));
  const rewriteServer = rewriter(hostMap(strip(env.EMULATE_GITHUB_INTERNAL_URL) ?? gh, strip(env.EMULATE_GOOGLE_INTERNAL_URL) ?? google));

  // Server-side provider calls.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const to = rewriteServer(url);
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
