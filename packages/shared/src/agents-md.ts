/**
 * Text that teaches any coding agent how to work in a yard. Served as
 * `/llms.txt`, `/AGENTS.md`, and embedded in every `workspace_get` response.
 */

export const MCP_TOOLS = [
  ["yard_list", "List the yards you can see."],
  ["yard_create", "Create a yard: a base repo (from files or a public git URL) plus everything around it. Admin only."],
  ["yard_status", "Active tasks, agents, claims, overlaps and recent events."],
  ["task_create", "Create a task and fan it out to N agents, each with its own fork."],
  ["workspace_get", "Your task brief, AGENTS.md, a digest of the other agents, and your fork's git remote."],
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

## Join a task: just git

A person hands you one line: \`git clone ${origin}/git/<owner>/<yard>/<task>/<you>.git\`.
Cloning a new name on an open task takes a seat and makes your own fork.
Git signs in with the person's Forkyard access token, kept by their credential
helper (Settings → Git access), so no secret ever passes through you.

1. Clone. Forkyard prints the task, who else is on it, and how to work
   ("remote: …" lines in git's output). Read them.
2. Plan first: write \`.forkyard/intent.md\` (\`# what\`, \`## Why\`, \`## Files\`
   with one path or glob per line), commit and push. The push output confirms
   the plan and tells you if another agent plans the same files, with their plan.
3. Commit small and push often, only to your remote. Every push is reviewed;
   the push output carries the last review and anything that touches your work.
   Keep intent.md current when your plan changes.
4. \`git pull\` also prints what changed around you.

Headless agents use their seat key (\`fy_...\`) as the git password.

## Optional: MCP

Clients that prefer tools can add ${origin}/mcp (streamable HTTP, OAuth: a
person signs in and picks a seat or lets you act as them). Use it for
\`ask_human\` when you are truly blocked on something only a person can settle,
and for \`compare_forks\`, \`code_why\` and \`events_since\`.

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

- **Plan before you edit.** Write \`.forkyard/intent.md\` and push it first:

  \`\`\`md
  # <one-line summary>

  ## Why
  <the reasoning a reviewer needs>

  ## Files
  - src/the/file.ts
  - src/area/**
  \`\`\`

  The push output says if another agent plans the same files. Narrow your plan
  or take a different approach, and say in your intent how the two fit.
- **Keep it current.** Update intent.md whenever your plan changes.
- **Small commits, frequent pushes.** Each push triggers a review and updates
  the live diff humans are watching.
- **Stay in scope.** Touch only what the task needs. Unrelated refactors
  make your fork harder to pick.
- **Ask only when blocked.** If you need something only a person can give
  (a credential, a product decision, an ambiguous requirement), call
  \`ask_human\` (MCP) with a precise question and, if you can, 2-4 options.
  Keep working on anything that doesn't depend on the answer.
- **Never** commit secrets, generated bundles or lockfile churn you did not
  intend.

## Git

\`\`\`sh
git clone <the line the person gave you> work && cd work   # read the remote: lines
mkdir -p .forkyard && $EDITOR .forkyard/intent.md
git add -A && git commit -m "plan: <what>" && git push     # read the remote: lines
# ...edit, commit small, push often...
\`\`\`

Git signs in through the person's credential helper: you never handle a token.
If git asks for a password, ask the person to set up git access in Settings.
`;

export function intentMarkdown(summary: string, why: string, details?: string | null): string {
  return `# ${summary.trim()}\n\n## Why\n\n${why.trim()}\n${details ? `\n## Details\n\n${details.trim()}\n` : ""}`;
}

/** Parse `.forkyard/intent.md` written by an agent. Lenient: first heading is the summary. */
export function parseIntentMarkdown(md: string): { summary: string; why: string; details: string | null; files: string[] } | null {
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
  // "## Files": the paths (globs allowed) the plan expects to touch, one per line.
  const files = (section("files") ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").replace(/`/g, "").trim())
    .filter(Boolean)
    .slice(0, 200);
  return { summary: summary.slice(0, 200), why: why || summary, details: section("details"), files };
}
