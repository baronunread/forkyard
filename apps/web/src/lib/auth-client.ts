import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth in the browser. `oauthProviderClient` carries the signed OAuth
 * request (the `sig`-ed query on /login and /connect) through sign-in, so an
 * agent's authorization picks up where it left off.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [oauthProviderClient()],
});

/** True on /login or /connect when an agent's OAuth authorization is in flight. */
export function oauthInFlight(search = location.search): boolean {
  const q = new URLSearchParams(search);
  return q.has("sig") && q.has("client_id");
}
