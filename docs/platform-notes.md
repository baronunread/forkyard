# Platform notes: what was verified, and where the brief differed

Several products Forkyard uses are in beta. The build environment could not reach `developers.cloudflare.com` or the blog, so APIs were verified against the **shipped type definitions and tooling** — which is what the code compiles and runs against — plus search excerpts of the docs:

- `@cloudflare/workers-types@5.20261002.1` — the `Artifacts` / `ArtifactsRepo` binding interfaces
- `wrangler@4.146.0` — config schema (`artifacts`, `k2`, `triggers.events`), queue event-subscription commands
- `miniflare` — which bindings have local simulators
- `agents@0.24.0`, `@modelcontextprotocol/server@2.0.0` — MCP server APIs
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

`agents/mcp` exposes `createMcpHandler(factory)`, a **stateless** streamable-HTTP handler built on `@modelcontextprotocol/server` v2. Forkyard's live state already lives in the Yard Durable Object, so a per-session `McpAgent` DO would only add a second source of truth; the stateless handler builds a fresh server per request with the caller's principal.

## Local development

There is no local simulator for Artifacts in `wrangler dev`, so `apps/worker/src/artifacts/emulator.ts` implements the binding surface Forkyard uses (plus git smart HTTP with real pack/delta handling, and `cf.artifacts.repo.pushed` events into the local Queue) on a Durable Object. It is selected by `ARTIFACTS_MODE=local` (the default in `wrangler.jsonc`) and is never used by `env.production`. Its git server is tested against the real `git` CLI (`apps/worker/test/git-protocol.test.ts`).

## UI libraries

- Kumo tokens use `light-dark()`; the app sets `data-mode` on `<html>` (Kumo's mechanism) and Tailwind's `dark:` variant is bound to it.
- `@pierre/diffs` follows `themeType` from the same mode.
- `@pierre/trees` renders in a shadow root with `color-scheme: light dark`, which would follow the OS instead of the toggle; Forkyard overrides its color variables with resolved values and pins `color-scheme` via `unsafeCSS`.
