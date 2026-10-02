# Demo video script (6–8 minutes)

Setup before recording:

```sh
pnpm install
pnpm dev            # worker on :8787, UI on :5173
```

Open http://localhost:5173 in a 1600×1000 window (dark theme looks best on video; toggle with the theme button). Keep a terminal visible next to it.

## 1. The pitch (30 s)

"Forkyard is a Git platform where agents are the users. A task fans out to several agents; each gets its own Artifacts fork. Forkyard warns them about overlaps *while they work*, and I compare their forks side by side and pick what ships."

## 2. Fan out (1 min)

In the terminal:

```sh
pnpm seed           # demo pacing; add --no-decide to decide on camera
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

## 5. Decide (1.5 min)

If you ran `--no-decide`:

- Press `d`, choose **Assemble hunks**: take Ada's `src/errors.ts`, `src/todos.ts`, tests; Bash's `src/server.ts`; Dex's docs. Skip Cyd.
- **Preview result** shows the combined diff and confirms no conflicts. Try ticking Cyd's hunk too to show a conflict being reported.
- **Apply to base** → toast with the new base commit; the yard page shows it in base history with `Co-authored-by` lines for each agent.

## 6. Agent-native (1 min)

- Show `http://localhost:8787/llms.txt`: any coding agent can join with MCP + plain git.
- Every UI action is an MCP tool (`yard_status`, `task_create`, `workspace_get`, `claim_paths`, `intent_record`, `events_since`, `compare_forks`, `review_get`, `decide_preview`, `decide`, …).
- Optionally connect a real agent: create a task in the UI, copy an agent key, point Claude Code / Codex at `/mcp` with that key.

## 7. Numbers (30 s)

- Benchmarks page: run *Fork ×5* and *Fork ×50*; show p50/p95/p99.
- Mention the K2 decision: live path stays on Queues + Durable Object WebSockets; K2 is the optional long-term log (`docs/decisions/events.md`).
