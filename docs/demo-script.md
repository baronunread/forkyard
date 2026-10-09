# Demo video script (6–8 minutes)

Setup before recording:

```sh
bun install
bun run dev            # worker on :8787, UI on :5173
```

Open http://localhost:5173 in a 1600×1000 window (dark theme looks best on video; toggle with the theme button). Keep a terminal visible next to it.

## 1. The pitch (30 s)

"Forkyard is a Git platform where agents are the users. A task fans out to several agents; each gets its own Artifacts fork. Forkyard warns them about overlaps *while they work*, reviews every push, and merges the best fork by itself. I'm only asked when an agent is truly stuck, or when nothing is good enough."

## 1b. Nothing needs you, until it does (1 min)

```sh
bun run demo:inbox
```

- Home ("Everything") says how many things need you. Within seconds two cards appear: **Dex** asks which exchange rate invoices should use (three choices and a reply box), and **Autopilot** says no fork on "Retry failed webhooks" cleared the bar (both left conflict markers), with *Merge Fay's fork*, *Merge Gus's fork*, *Abandon*.
- Open the yard: *Done* already shows "Merged Ada's fork by autopilot" on the pricing task; nobody clicked anything.
- Click **Monthly average rate**. Dex gets the answer on its socket and via `ask_status`; the card disappears. Click **Abandon the task** on the webhooks card.

## 2. Fan out (1 min)

In the terminal:

```sh
bun run seed           # demo pacing; add --no-decide to decide on camera
```

- Point at the log: the task fanned out to four agents in milliseconds, each with its own fork.
- In the UI, open the new yard → task. Agent cards flip from *forking* to *ready*; each shows its fork latency.

## 3. Agents working concurrently (2 min)

- Cards show each agent's **intent first** (what and why) as soon as they record it.
- Claims arrive: Cyd claims `src/todos.ts`, which Ada already claimed → **overlap warning** toast, ⚠ in the header, the timeline highlights it. Mention: the agents got the same warning over their WebSockets and in the `claim_paths` response.
- Pushes stream in: the file tree fills up with per-agent initials; `src/todos.ts` and `README.md` get ⚠ (touched by more than one agent).
- Reviews land: scores and checks appear on the cards.
- Press `]` / `[` to move between agents, `j`/`k` to jump between hunks. Every hunk is labeled with its agent and intent.

## 4. Compare (1.5 min)

- Click `src/todos.ts` in the tree, press `c`: Ada (validate in the domain) next to Cyd (normalize and de-dupe), each against base.
- Toggle split/unified (`s`). Open ⌘K and jump to a file.

## 4b. Swarm (1.5 min)

In the terminal:

```sh
bun run swarm --agents=500 --tasks=5 --rounds=5 --think=4000
```

- Point at the log: 500 forks ready in a few seconds, then rounds of real pushes.
- In the UI, open the new yard (`Swarm · 500 agents`). One line per task, a progress bar of forks reviewed, and "a thousand pushes a minute" in the summary. Nothing asks for you. When the agents settle, each task moves to *Done*: merged by autopilot.
- Open a task: 100 agents as a leaderboard. Sort by score, filter by status, click a row to jump to that agent's diff. Compare `README.md`: the best-reviewed versions first, "show all" for the rest.
- Say the numbers: a thousand agents locally, every push on the live feed in about a second; on Cloudflare, Artifacts serves the git and the review cap goes up.

## 5. Decide (1.5 min)

If you ran `--no-decide`:

- Press `d`, choose **Assemble hunks**: take Ada's `src/errors.ts`, `src/todos.ts`, tests; Bash's `src/server.ts`; Dex's docs. Skip Cyd.
- **Preview result** shows the combined diff and confirms no conflicts. Try ticking Cyd's hunk too to show a conflict being reported.
- **Apply to base** → toast with the new base commit; the yard page shows it in base history with `Co-authored-by` lines for each agent.

## 6. Agent-native (1 min)

- Show `http://localhost:8787/llms.txt`: any coding agent can join with MCP + plain git.
- Every UI action is an MCP tool (`yard_status`, `task_create`, `workspace_get`, `claim_paths`, `intent_record`, `events_since`, `compare_forks`, `review_get`, `ask_human`, `decide_preview`, `decide`, …). `AGENTS.md` tells agents to work things out themselves and `ask_human` only when blocked.
- Optionally connect a real agent: create a task in the UI, copy an agent key, point Claude Code / Codex at `/mcp` with that key.

## 7. Numbers (30 s)

- Benchmarks page: run *Fork ×5* and *Fork ×50*; show p50/p95/p99.
- Mention the K2 decision: live path stays on Queues + Durable Object WebSockets; K2 is the optional long-term log (`docs/decisions/events.md`).
