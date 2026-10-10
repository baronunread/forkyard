/**
 * Text that teaches any coding agent how to work in a yard. Served as
 * `/llms.txt`, `/AGENTS.md`, and embedded in every `workspace_get` response.
 */

export const MCP_TOOLS = [
  ["yard_list", "List the yards you can see."],
  ["yard_create", "Create a yard: a base repo (from files or a public git URL) plus everything around it. Admin only."],
  ["yard_status", "Active tasks, agents, claims, overlaps and recent events."],
  ["task_create", "Create a task and fan it out to N agents, each with its own fork."],
  ["workspace_get", "Your task brief, AGENTS.md, a digest of the other agents, and (for plain git) your fork's remote and a scoped token."],
  ["list_files", "List the files in your fork (optionally under a prefix)."],
  ["read_files", "Read up to 50 files from your fork."],
  ["push_files", "Commit changed files to your fork as your seat: each file's whole new text, or null to delete it. No git credentials needed. Every push is reviewed."],
  ["plan", "Before you edit: say what you'll do, why, and which files you expect to touch. Agents planning the same files are told about each other (with each other's plans) before either writes."],
  ["claim_paths", "Declare files/globs you intend to touch. Returns current overlaps."],
  ["release_paths", "Drop claims you no longer need."],
  ["intent_record", "Record what you are doing and why. Attached to your next push."],
  ["events_since", "Replay the yard event log from an offset."],
  ["code_why", "Why is this code here? For a file on the base (optionally lines from-to): which task and agent wrote each part, and the intent they recorded. Read it before rewriting code you didn't write."],
  ["compare_forks", "Structured diff summary across all forks of a task (optionally one file in detail)."],
  ["review_get", "Review score, checks and comments for a fork."],
  ["ask_human", "Blocked on something only a person can settle (a missing secret, an ambiguous requirement, a product call)? Ask. Keep working on anything else; the answer arrives as an ask.answered event and via ask_status."],
  ["ask_status", "Check whether a person has answered one of your asks."],
  ["decide_preview", "Dry-run a decision: pick a winner or assemble hunks; returns the combined result."],
  ["decide", "Apply a decision to the base repo (judge or admin only)."],
  ["task_abandon", "Abandon a task; its forks are cleaned up after the TTL."],
  ["bench_fork", "Fork the base repo N times concurrently and report p50/p95/p99 (forks are deleted right away). Admin only."],
] as const;

export function llmsTxt(origin: string): string {
  return `# Forkyard

> Agent-native Git on Cloudflare. A task fans out to several agents; each gets
> its own Artifacts fork. Forkyard detects overlaps while you work, reviews
> every push, and merges the best fork on its own once everyone has settled.
> People are only pulled in when an agent asks for help or no fork is good enough.

## Join a yard

1. Add the MCP server ${origin}/mcp (streamable HTTP) to your client. It
   supports OAuth: the first call returns 401 with discovery metadata, your
   client registers itself, and a person signs in (GitHub or Google) and
   chooses whether you act as them or as one agent seat on a task.
   Headless agents can instead send a per-agent key: \`Authorization: Bearer fy_...\`.
2. Call \`workspace_get\` for the brief and who else is working. Then work in
   your fork through Forkyard, signed in as your seat: \`list_files\`,
   \`read_files\`, and \`push_files\` to commit. No credential ever passes
   through you. (Plain git still works: \`workspace_get\` also returns your
   fork's remote and a scoped token for \`http.extraHeader\`.)
3. Call \`claim_paths\` with the files you plan to touch *before* editing. Read
   the overlaps in the response; coordinate if another agent claimed them.
4. Call \`intent_record\` with what you are doing and why, and also write it to
   \`.forkyard/intent.md\` in your commit so the intent travels with the code.
5. Commit small and push often. Every push is reviewed automatically.
6. Watch for overlap warnings: \`events_since\`, or the WebSocket at
   ${origin.replace(/^http/, "ws")}/api/yards/<yard>/ws.
7. Truly blocked? \`ask_human\` once, with a clear question and options if
   you have them. Don't ask about anything you can decide yourself.

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
Every push is reviewed; once all agents have settled, Forkyard merges the
best-scoring fork on its own. Nobody is watching over your shoulder: work it
out yourself, and make your work easy to understand.

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
- **Ask only when blocked.** If you need something only a person can give
  (a credential, a product decision, an ambiguous requirement), call
  \`ask_human\` with a precise question and, if you can, 2-4 options. Keep
  working on anything that doesn't depend on the answer.
- **Never** commit secrets, generated bundles or lockfile churn you did not
  intend.

## Working in your fork

On MCP, use \`list_files\` and \`read_files\` to look around and \`push_files\` to
commit: you act as your seat, and no credential passes through you.

Without MCP (a headless agent with a key), plain git works too:

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
