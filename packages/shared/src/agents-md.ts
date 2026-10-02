/**
 * Text that teaches any coding agent how to work in a yard. Served as
 * `/llms.txt`, `/AGENTS.md`, and embedded in every `workspace_get` response.
 */

export const MCP_TOOLS = [
  ["yard_list", "List the yards you can see."],
  ["yard_create", "Create a yard: a base repo (from files or a public git URL) plus everything around it. Admin only."],
  ["yard_status", "Active tasks, agents, claims, overlaps and recent events."],
  ["task_create", "Create a task and fan it out to N agents, each with its own fork."],
  ["workspace_get", "Your fork's git remote + scoped token, AGENTS.md, the task brief, and a digest of the other agents."],
  ["claim_paths", "Declare files/globs you intend to touch. Returns current overlaps."],
  ["release_paths", "Drop claims you no longer need."],
  ["intent_record", "Record what you are doing and why. Attached to your next push."],
  ["events_since", "Replay the yard event log from an offset."],
  ["compare_forks", "Structured diff summary across all forks of a task (optionally one file in detail)."],
  ["review_get", "Review score, checks and comments for a fork."],
  ["decide_preview", "Dry-run a decision: pick a winner or assemble hunks; returns the combined result."],
  ["decide", "Apply a decision to the base repo (judge or admin only)."],
  ["task_abandon", "Abandon a task; its forks are cleaned up after the TTL."],
  ["bench_fork", "Fork the base repo N times concurrently and report p50/p95/p99 (forks are deleted right away). Admin only."],
] as const;

export function llmsTxt(origin: string): string {
  return `# Forkyard

> Agent-native Git on Cloudflare. A task fans out to several agents; each gets
> its own Artifacts fork. Forkyard detects overlaps while you work and humans
> (or a judge agent) compare forks side by side and pick what ships.

## Join a yard

1. You were given an API key (\`fy_...\`) for one agent on one task.
2. Connect to the MCP server: ${origin}/mcp (streamable HTTP),
   header \`Authorization: Bearer <api key>\`.
3. Call \`workspace_get\`. It returns your fork's git remote and a short-lived
   token. Clone with plain git:
   \`git -c http.extraHeader="Authorization: Bearer <token>" clone <remote>\`
4. Call \`claim_paths\` with the files you plan to touch *before* editing. Read
   the overlaps in the response; coordinate if another agent claimed them.
5. Call \`intent_record\` with what you are doing and why, and also write it to
   \`.forkyard/intent.md\` in your commit so the intent travels with the code.
6. Commit small and push often. Every push is reviewed automatically.
7. Watch for overlap warnings: \`events_since\` or the WebSocket at
   ${origin.replace(/^http/, "ws")}/api/yards/<yard>/ws?key=<api key>.

You can never push to the base repo. Merging is Forkyard's job.

## MCP tools

${MCP_TOOLS.map(([n, d]) => `- \`${n}\`: ${d}`).join("\n")}

## REST

Every MCP tool has a REST twin under ${origin}/api — see ${origin}/api/openapi.json.

## Docs

- [AGENTS.md template](${origin}/AGENTS.md)
`;
}

export const AGENTS_MD_TEMPLATE = `# AGENTS.md — working in a Forkyard yard

You are one of several agents working on the same task, each in your own fork.
Humans will compare your fork with the others and pick what ships, so make
your work easy to understand.

## Rules

- **Claim before you edit.** Call \`claim_paths\` with the files or globs you
  intend to change. If the response lists overlaps, prefer a different
  approach or narrow your claim; mention the overlap in your intent.
- **Say what and why.** Call \`intent_record\` before your first push and
  whenever your plan changes. Mirror it in \`.forkyard/intent.md\`:

  \`\`\`md
  # <one-line summary>

  ## Why
  <the reasoning a reviewer needs>
  \`\`\`

- **Small commits, frequent pushes.** Each push triggers a review and updates
  the live diff humans are watching.
- **Stay in scope.** Touch only what the task needs. Unrelated refactors
  make your fork harder to pick.
- **Never** commit secrets, generated bundles or lockfile churn you did not
  intend.

## Commands

\`\`\`sh
git -c http.extraHeader="Authorization: Bearer $FORKYARD_TOKEN" clone "$FORKYARD_REMOTE" work
cd work
# ...edit...
git add -A && git commit -m "feat: <what>"
git -c http.extraHeader="Authorization: Bearer $FORKYARD_TOKEN" push origin HEAD
\`\`\`

Tokens expire; call \`workspace_get\` again for a fresh one.
`;

export function intentMarkdown(summary: string, why: string, details?: string | null): string {
  return `# ${summary.trim()}\n\n## Why\n\n${why.trim()}\n${details ? `\n## Details\n\n${details.trim()}\n` : ""}`;
}

/** Parse `.forkyard/intent.md` written by an agent. Lenient: first heading is the summary. */
export function parseIntentMarkdown(md: string): { summary: string; why: string; details: string | null } | null {
  const text = md.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => /^#\s+/.test(l));
  const summary = headingIdx >= 0 ? lines[headingIdx]!.replace(/^#\s+/, "").trim() : lines[0]!.trim();
  const section = (name: string): string | null => {
    const i = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\b`, "i").test(l));
    if (i < 0) return null;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => /^##\s+/.test(l));
    return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim() || null;
  };
  const why =
    section("why") ??
    lines
      .slice(headingIdx + 1)
      .join("\n")
      .trim();
  return { summary: summary.slice(0, 200), why: why || summary, details: section("details") };
}
