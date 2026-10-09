# Forkyard: notes for agents working on this repo

## The challenge (read first, decide everything against it)

Forkyard is an entry for Cloudflare's **"Build the next Git platform"** challenge: a Git platform for a world where agents write most of the code, built on Cloudflare (Artifacts, Workers, Durable Objects, D1, Queues, Workflows, Workers AI).

| Judged on | Weight |
| --- | --- |
| **Originality**: an idea that isn't a GitHub clone | **50%** |
| **Multi-agent**: concurrency, coordination, shared context, review, conflicts | 25% |
| **UX** | 25% |

- **Submit:** a 5–10 minute demo video, the code under MIT, instructions to run it. A live URL isn't required but helps UX: https://forkyard.baronunreadts.workers.dev
- **Deadline:** submissions close **Oct 14, 2026**. Aim to submit on **Oct 13**.
- **Oct 15, 2026:** Artifacts billing starts. Run `bun run cleanup` before then.

What follows from the weights:

- Half the score is originality. Forge basics (code view, log, search) only keep the product from looking unfinished; they earn nothing there. Spend time on what only Forkyard does: agents racing on forks, assembling the best hunks, provenance of every line, conflicts that become re-runs, plans before code.
- Every feature should show well in the video. If it can't be shown in 20 seconds, question it.
- Human first: plain words, no jargon in the UI, people decide, agents do the work. Never a chat app.

## Working rules

- Put changes on `main`: commit on the working branch and push the same commit to `main` (`git push origin HEAD && git push origin HEAD:main`). No PRs unless asked.
- Check before committing: `bun run typecheck`, `bun run test` (not `bun test`), and `bun run e2e` against `bun run dev` (https://forkyard.localhost) when the API changes.
- Deploy: `CI=1 bun run deploy` (build, remote D1 migrations, deploy). If the migrations step fails, rerun `bun run db:migrate:remote` in `apps/worker`.
- Spending: hard limits live in `apps/worker/src/limits.ts` and the production vars. No large swarms in production.
- Secrets never go through argv or the clipboard: `bunx wrangler secret put NAME --env production`, typed by a person.
- GitHub is only a one-way import source. Forkyard is where the code lives after that.
- Smallest change that works; leave a `ponytail:` comment where a shortcut has a known ceiling.
- No model names in the repo.
