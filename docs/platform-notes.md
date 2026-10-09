# Platform notes: what was verified, and where the brief differed

Several products Forkyard uses are in beta. The build environment could not reach `developers.cloudflare.com` or the blog, so APIs were verified against the **shipped type definitions and tooling** — which is what the code compiles and runs against — plus search excerpts of the docs:

- `@cloudflare/workers-types@5.20261002.1` — the `Artifacts` / `ArtifactsRepo` binding interfaces
- `wrangler@4.146.0` — config schema (`artifacts`, `k2`, `triggers.events`), queue event-subscription commands
- `miniflare` — which bindings have local simulators
- `@hono/mcp@0.3.2`, `@modelcontextprotocol/sdk@1.31` — MCP server APIs
- `@cloudflare/kumo@2.14.0` (its `kumo doc` CLI), `@pierre/diffs@1.5.1`, `@pierre/trees@1.0.0-beta.6` (pinned)

## Artifacts binding

| Brief | Verified | Consequence in Forkyard |
| --- | --- | --- |
| `env.ARTIFACTS.get(name)`, `repo.info()`, `repo.fork(name)` → `{ name, remote, token }`, `repo.readFile({ ref, path })` | All present. `fork(name, { description, readOnly, defaultBranchOnly })` returns `{ id, name, description, defaultBranch, remote, token }`. Namespace: `create`, `get`, `import`, `list`, `delete`. Repo: `createToken(scope, ttl)`, `listTokens`, `revokeToken`, `readTree`, `readBlob`, `readCommit`, `log`. Errors carry `.code` (`ALREADY_EXISTS`, `FORK_IN_PROGRESS`, …). | Fan-out uses one base handle and N concurrent `fork()` calls; `ALREADY_EXISTS` is adopted for idempotent retries. Tokens after the first are minted with `createToken("write", TOKEN_TTL_SECONDS)`. |
| — | **The binding has no write API** (no commit/ref update). | Forkyard writes merges (and preview branches) with a small git smart-HTTP client (`apps/worker/src/git/`): it builds only the trees along changed paths, packs them, and `git-receive-pack`s with a 2-minute token it revokes afterwards. Ref updates are compare-and-swap, so concurrent decisions cannot clobber each other. |
| Diffs | `readTree` returns hashes, so identical subtrees are skipped without reading them. | `forkDiff` walks fork vs base trees by hash and only reads changed blobs. |
| Git auth | Bearer header (`http.extraHeader`) or token as the Basic password. | `workspace_get` returns a ready `cloneCommand`. |
| Jurisdiction | Per **namespace**, chosen by the binding's `namespace`. | EU yards use a second binding `ARTIFACTS_EU` and a DO in `env.YARD.jurisdiction("eu")`. |

## Events

See `docs/decisions/events.md`. Short version: Artifacts events can target **Queues and Workflows** (not only Queues); there is no K2 destination; K2 has a producer binding, pull-only HTTP consumers and no local simulator.

## Workers Builds and previews

Workers Builds connects **one** Artifacts repo per Worker, deploys `main` and builds a Preview for every other branch. Agent forks are separate repos, so Forkyard mirrors each agent's latest tree onto `fy/<task>/<agent>` **in the base repo** after every push (`apps/worker/src/preview.ts`), as a fast-forwarding synthetic commit. Agents still never get write access to the base repo. Set the yard's preview URL template, e.g. `https://{branch}-myapp.<subdomain>.workers.dev`, and connect the base repo in **Settings → Builds** with Preview builds enabled. Preview branches are deleted with their forks.

## MCP

The MCP endpoint uses [`@hono/mcp`](https://github.com/honojs/middleware/tree/main/packages/mcp)'s `StreamableHTTPTransport` with the MCP SDK's `McpServer`, mounted as an ordinary Hono route so it shares the API's auth. It runs stateless (no session ids): live state is in the Yard Durable Object, so each request builds a fresh server for the caller's principal. (Cloudflare's `agents` package was the other option; `McpAgent` adds a Durable Object per session, which would be a second source of truth here.)

## Sign-in and agent OAuth

Everything account-related is [Better Auth](https://www.better-auth.com) on D1 (its native D1 support; the tables are in `migrations/0001_init.sql`, generated with `better-auth/db/migration`), mounted at `/api/auth`:

- **People**: the `github` and `google` social providers, database sessions behind Better Auth's cookie, and account linking for the same verified email.
- **Agents**: [`@better-auth/mcp`](https://www.better-auth.com/docs/plugins/mcp), the OAuth 2.1 provider configured for MCP. It serves authorization-server and protected-resource metadata (Forkyard forwards `/.well-known/*` to it), dynamic client registration, PKCE, and issues JWT access tokens (`jwt` plugin, issuer = the origin) bound to `<origin>/mcp`. `/mcp` verifies them in-process against `auth.api.getJwks()` rather than fetching its own JWKS URL.
- **Choosing a seat**: the plugin's `postLogin` step sends the person to `/connect` before consent. They pick *you* or one agent seat; the choice (stored per session and client in `oauth_seat_choices`, cleared whenever a new authorization starts) becomes the grant's `referenceId`, and `customAccessTokenClaims` puts it on every token as `seat`. `/connect` also serves as the consent page, and one click covers both steps.
- **Two shims**: MCP clients register loopback redirects (`http://localhost:PORT/callback`) without `application_type`, and the OIDC default (`web`) forbids them, so registrations whose redirects are all loopback are marked `native`. And the Better Auth browser client follows any `{redirect, url}` response by itself, so `/connect` calls `continue` and `consent` with plain `fetch`.
- Per-agent `fy_` keys and the operator key are checked before OAuth tokens on `/mcp` and the API.

## Local development

**Sign-in** runs against [emulate.dev](https://emulate.dev): `bun run dev` (`scripts/dev.ts`) starts its GitHub and Google emulators at https://github.emulate.forkyard.localhost and https://google.emulate.forkyard.localhost through [portless](https://github.com/vercel-labs/portless) (seeded from `emulate.config.yaml` with strict OAuth apps whose credentials match `apps/worker/local.env`). Better Auth's providers have the public endpoints built in, so `src/emulate.ts` (on only when `EMULATE_GITHUB_URL` / `EMULATE_GOOGLE_URL` are set) swaps github.com, api.github.com and the Google hosts for the emulator URLs in the Worker's outbound `fetch` and in the authorization URL sent to the browser. `bun run e2e` drives that flow end to end: sign in as `ada`, then register an MCP client and get tokens for both kinds of seat.

**Artifacts**: there is no local simulator for Artifacts in `wrangler dev`, so `apps/worker/src/artifacts/emulator.ts` implements the binding surface Forkyard uses (plus git smart HTTP with real pack/delta handling, and `cf.artifacts.repo.pushed` events into the local Queue) on a Durable Object. It is selected by `ARTIFACTS_MODE=local` (the default in `wrangler.jsonc`) and is never used by `env.production`. Its git server is tested against the real `git` CLI (`apps/worker/test/git-protocol.test.ts`).

## UI libraries

- **Tailwind v4** carries all styling. Design tokens are `@theme` values pointing at per-mode CSS variables (`@theme static`, so inline styles and library variables such as `--diffs-*` / `--trees-*` can use `--color-*` too); there are no component classes left in CSS.
- **TanStack**: Router (code-based route tree, `beforeLoad` sign-in guard, zod-validated search params), Query (every read; keys nest under `["yard", id]` so one live event can invalidate a yard), Pacer (debounced invalidation from the WebSocket), Form (zod validators via Standard Schema), Table v9 (`useTable` + `tableFeatures`), Hotkeys and Virtual.
- The sign-in and `/connect` pages read the signed OAuth query from `window.location` (Better Auth's client plugin does too), not from router search state, so the router never re-serializes the signature.
- Kumo tokens use `light-dark()`; the app sets `data-mode` on `<html>` (Kumo's mechanism) and Tailwind's `dark:` variant is bound to it.
- `@pierre/diffs` follows `themeType` from the same mode.
- `@pierre/trees` renders in a shadow root with `color-scheme: light dark`, which would follow the OS instead of the toggle; Forkyard overrides its color variables with resolved values and pins `color-scheme` via `unsafeCSS`.
