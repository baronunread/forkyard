# Decision: event transport — Queues on the live path, K2 as optional history

Status: **accepted** (2026-10-02). Revisit if K2 becomes an Artifacts event destination or gets push consumers.

## Question

Forkyard needs one event log for pushes, intents, claims, overlaps, reviews and decisions. Two requirements pull in different directions:

1. **Live**: anything humans or agents must see while work happens — a new push, an overlap warning, a review score — should be visible in **under ~1 s**.
2. **Replayable**: a new agent (or a reconnecting UI) must catch up from an offset with `events_since`, and the timeline must be durable.

Cloudflare K2 (public beta, Oct 2026) is an ordered, replayable stream on R2 and looks like the natural single log. Queues + Durable Objects is the boring path.

## What I verified (and how)

The developer docs and blog were not reachable from the build environment, so every claim below was checked against the shipped tooling instead (`wrangler@4.146.0`, `@cloudflare/workers-types@5.20261002.1`, `miniflare`) plus search-result excerpts of the docs.

| Claim in the brief | What the tooling says |
| --- | --- |
| Artifacts event subscriptions deliver to Queues | **True, and also to Workflows.** `wrangler queues subscription create` targets a queue (`destination.type = "queues.queue"`), and the Wrangler config has `triggers.events[]` with `type: "cf.artifacts.repo.pushed"` and `targets: [{ type: "workflow" }]`. There is **no K2 destination**. |
| Event types | `cf.artifacts.repo.{created,deleted,forked,imported,pushed,cloned,fetched,token.created,token.revoked}`. Push payload: `source.repoName`, `payload.{ref,before,after,commits[]}`. |
| K2 has a Workers producer binding | **True**: `"k2": [{ "binding", "stream" }]`, `send([{ content, headers }])` returning `{ success, error? }`. **No local simulator** (`remote: false` is rejected), so the spike cannot run under `wrangler dev`. |
| K2 consumers are pull-only | **True**: HTTP `POST /subscriptions/{id}/consume` → `{ batch_id, leased_until_ms, records[] }`, then `/batches/{id}/ack` or `/nack`; 5-minute leases. No Worker consumer binding in Wrangler. |
| ~1 s produce latency at p99 | Matches the published figure; launch coverage also reports end-to-end (produce + consumer polling) **p95 ≈ 2.5 s, p99 ≈ 7.5 s** in early beta. |

## What was built

Both paths are implemented, behind the transport-independent `YardEvent` schema in `packages/shared/src/events.ts`:

- **Live path (shipping):** Artifacts `repo.pushed` → **Queue** (`forkyard-artifact-events`, `max_batch_size: 1`) → Worker `queue()` → **Yard DO** `onPush` → appended to the DO's SQLite log with a gap-free `seq` → fanned out over **hibernatable WebSockets** to the UI and the agents on that task → review **Workflow** started.
- **K2 spike (optional):** every event the Yard DO appends is also `send()`-ed to a K2 stream (`EVENTS_K2` binding). `POST /api/yards/:yard/k2/poll` arms a DO **alarm** that pulls `/consume` every 250 ms, acks the batch, and records how long after append each record arrived (`GET /api/yards/:yard/latency`).
- `events_since` (MCP and REST) replays from the Yard DO log, which already has per-yard offsets.

## Measurements

`bun run bench:events` pushes N commits with plain `git` and times until the matching `push.received` arrives on a WebSocket — exactly what the UI sees.

| Path | Environment | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| git push → event on WebSocket (live path) | local (`wrangler dev`, Artifacts emulator, local Queue) | 42 ms | 48 ms | 76 ms |
| push returned → event on WebSocket | local | 8 ms | 12 ms | 13 ms |
| git push → WebSocket, **production** | Cloudflare (Artifacts beta) | _run `bun run bench:events` on a deployment_ | | |
| K2: DO append → pull consumer | Cloudflare | _run `bun run bench:events --k2`_ | | |
| K2 published (produce + polling) | Cloudflare docs / launch | — | ~2.5 s | ~7.5 s |

The local numbers prove the pipeline and its overhead (no extra hops beyond Queue → DO → socket); they are not a stand-in for production network latency. The production rows need an Artifacts beta account; the scripts write JSON to `bench-results/` and record runs that the Benchmarks page shows.

## Decision

Apply the rule from the brief: *anything live must stay under ~1 s.*

- K2's own published end-to-end figures (p95 ≈ 2.5 s, p99 ≈ 7.5 s with polling) are above the budget, its consumers are pull-only, and Artifacts cannot deliver to it directly — so a K2 live path would be **Artifacts → Queue → Worker → K2 → poll → DO**, strictly slower than stopping at the DO.
- **Keep Queues + Durable Object WebSockets for everything live.** The DO log is the source of truth for `events_since` and the timeline.
- **Use K2 only as an optional durable mirror** (long retention, multi-consumer analytics, cross-yard history) — the spike is in the code and off unless `EVENTS_K2` is bound.

Two follow-ups make the Queue less necessary, and both are cheap because producers and consumers only see `YardEvent`:

1. Artifacts `triggers.events → workflow` already exists. `ReviewWorkflow` accepts the raw Artifacts event (its first step routes it and notifies the yard), so the review pipeline can drop the Queue today. The Queue stays for the live notification, which needs one Worker hop either way.
2. If K2 ships as an Artifacts event destination **and** gets push (Worker) consumers with sub-second delivery, re-run `bun run bench:events --k2` and consider making K2 the single log, with the DO only fanning out.
