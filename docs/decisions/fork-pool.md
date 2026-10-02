# Decision: no warm fork pool (yet)

Status: **deferred until production benchmarks say otherwise** (2026-10-02).

## Context

Every task forks the base repo once per agent, so fork latency is on the critical path of "agents start working". The brief asks to measure first and only build a pool of pre-created forks if forks are noticeably slow.

## What is in place

- Fan-out happens inside the Yard Durable Object: all N `repo.fork()` calls start concurrently from one base-repo handle, and each agent's workspace resolves as soon as **its own** fork is ready (`waitForAgent`). `POST /api/yards/:yard/tasks?stream=1` streams workspaces as NDJSON in completion order, so nobody waits for the slowest fork.
- Per-fork latency is recorded on every agent (`forkMs`, shown on the agent cards) and by `POST /api/bench/fork` / `pnpm bench:fork` (1, 5, 20, 50 concurrent forks, p50/p95/p99, forks deleted immediately).

## Numbers so far

| Concurrent forks | p50 | p95 | p99 | Environment |
| --- | --- | --- | --- | --- |
| 1 | 2 ms | 2 ms | 2 ms | local emulator |
| 5 | 4 ms | 7 ms | 7 ms | local emulator |
| 20 | 10 ms | 16 ms | 21 ms | local emulator |
| 50 | 20 ms | 36 ms | 45 ms | local emulator |
| 1 / 5 / 20 / 50 | _run `pnpm bench:fork` against a deployment_ | | | Cloudflare Artifacts |

The emulator forks by copying refs over content-addressed storage, which is the cost model Artifacts describes for forks, but its absolute numbers say nothing about the real service.

## Decision rule

Build the pool only if, on a deployment, **p95 at 5 concurrent forks exceeds ~1 s** (a five-agent task would feel slow). If it does:

- keep `k` pre-forked repos per yard named `<yard>--pool--<n>`, refilled by the Yard DO alarm;
- on claim, fast-forward the pooled fork's default branch to base HEAD with the existing push writer (`writeCommit` with the base commit — the objects already exist in the fork's history if the pool is refreshed on every base move), then rename by mapping `fork_name` in D1 (Artifacts has no rename);
- count pool forks against the yard's `maxActiveForks` budget and include them in `pnpm cleanup`.

Until then, a pool would only add standing storage cost (billing starts October 15) and a reset step that can be slower than a fresh fork.
