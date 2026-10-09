import { z } from "zod";

/**
 * Domain schemas shared by the REST API, the MCP server and the web UI.
 * Everything that crosses a process boundary is described here once.
 */

export const Slug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and single dashes")
  .refine((s) => !s.includes("--"), "double dashes are reserved as the fork-name separator");

/** A yard's slug from its name: "My Project!" → "my-project". */
export function yardSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export const Jurisdiction = z.enum(["default", "eu"]);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const Budgets = z.object({
  // Swarm scale: a task can fan out to thousands of agents, each in its own fork.
  maxAgentsPerTask: z.number().int().min(1).max(10_000).default(1_000),
  maxActiveForks: z.number().int().min(1).max(100_000).default(10_000),
});
export type Budgets = z.infer<typeof Budgets>;

export const Yard = z.object({
  /** Internal and stable: repo names, Durable Object, API paths. People see owner/slug. */
  id: Slug,
  name: z.string(),
  /** The owner's handle and the yard's slug: the yard lives at /owner/slug. */
  owner: z.string(),
  slug: z.string(),
  baseRepo: z.string(),
  defaultBranch: z.string(),
  jurisdiction: Jurisdiction,
  previewUrlTemplate: z.string().nullable(),
  budgets: Budgets,
  createdAt: z.string(),
});
export type Yard = z.infer<typeof Yard>;

export const TaskStatus = z.enum(["open", "decided", "abandoned"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: Slug,
  yardId: Slug,
  title: z.string(),
  brief: z.string(),
  status: TaskStatus,
  baseCommit: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

export const AgentStatus = z.enum(["forking", "ready", "working", "pushed", "reviewed", "failed", "retired"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentRole = z.enum(["agent", "judge"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const Agent = z.object({
  id: Slug,
  yardId: Slug,
  taskId: Slug,
  name: z.string(),
  harness: z.string(),
  role: AgentRole,
  color: z.string(),
  initials: z.string(),
  status: AgentStatus,
  forkName: z.string(),
  forkRemote: z.string().nullable(),
  headCommit: z.string().nullable(),
  forkMs: z.number().nullable(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

/**
 * Where an agent runs: `mcp` is any agent you run yourself (Claude Code, Codex CLI, …) that joins
 * over MCP; `cloud` is a Pi Durable agent Forkyard runs in a Durable Object (harness "pi").
 */
export const AgentRunner = z.enum(["mcp", "cloud"]);
export type AgentRunner = z.infer<typeof AgentRunner>;
export const CLOUD_HARNESS = "pi";

export const AgentSpec = z.object({
  name: z.string().min(1).max(40),
  harness: z.string().min(1).max(60).default("unknown"),
  role: AgentRole.default("agent"),
  runner: AgentRunner.default("mcp"),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

export const Intent = z.object({
  id: z.string(),
  agentId: Slug,
  taskId: Slug,
  summary: z.string(),
  why: z.string(),
  details: z.string().nullable(),
  commit: z.string().nullable(),
  source: z.enum(["mcp", "api", "git"]),
  createdAt: z.string(),
});
export type Intent = z.infer<typeof Intent>;

export const Claim = z.object({
  agentId: Slug,
  taskId: Slug,
  pattern: z.string(),
  createdAt: z.string(),
});
export type Claim = z.infer<typeof Claim>;

export const OverlapKind = z.enum(["claim", "change"]);
export const Overlap = z.object({
  key: z.string(),
  taskId: Slug,
  kind: OverlapKind,
  /** Path or glob both agents claimed or changed. */
  path: z.string(),
  agents: z.array(Slug).min(2),
  active: z.boolean(),
  detectedAt: z.string(),
});
export type Overlap = z.infer<typeof Overlap>;

export const CheckStatus = z.enum(["pass", "warn", "fail"]);
export const Check = z.object({
  name: z.string(),
  status: CheckStatus,
  detail: z.string(),
});
export type Check = z.infer<typeof Check>;

export const ReviewComment = z.object({
  path: z.string().nullable(),
  line: z.number().nullable(),
  body: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const Review = z.object({
  id: z.string(),
  agentId: Slug,
  taskId: Slug,
  commit: z.string(),
  score: z.number().min(0).max(100),
  summary: z.string(),
  checks: z.array(Check),
  comments: z.array(ReviewComment),
  reviewer: z.string(),
  createdAt: z.string(),
});
export type Review = z.infer<typeof Review>;

export const FileStatus = z.enum(["added", "modified", "deleted"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const ChangedFile = z.object({
  path: z.string(),
  status: FileStatus,
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  oldHash: z.string().nullable(),
  newHash: z.string().nullable(),
  mode: z.string().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** A context-free hunk (jsdiff structuredPatch with context 0). Line prefixes: "+", "-". */
export const Hunk = z.object({
  id: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof Hunk>;

export const ForkDiff = z.object({
  agentId: Slug,
  baseCommit: z.string(),
  headCommit: z.string().nullable(),
  files: z.array(ChangedFile),
});
export type ForkDiff = z.infer<typeof ForkDiff>;

export const FileVersion = z.object({
  agentId: Slug,
  status: FileStatus.or(z.literal("unchanged")),
  contents: z.string().nullable(),
  binary: z.boolean(),
  hunks: z.array(Hunk),
});
export type FileVersion = z.infer<typeof FileVersion>;

export const FileCompare = z.object({
  path: z.string(),
  base: z.string().nullable(),
  baseBinary: z.boolean(),
  versions: z.array(FileVersion),
});
export type FileCompare = z.infer<typeof FileCompare>;

export const Selection = z.object({
  path: z.string(),
  agentId: Slug,
  /** Hunk ids to take. Omit to take the whole file as the agent left it. */
  hunkIds: z.array(z.string()).optional(),
});
export type Selection = z.infer<typeof Selection>;

export const DecideInput = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("winner"),
    winnerAgentId: Slug,
    message: z.string().optional(),
  }),
  z.object({
    mode: z.literal("assemble"),
    selections: z.array(Selection).min(1),
    message: z.string().optional(),
  }),
]);
export type DecideInput = z.infer<typeof DecideInput>;

export const AssembledFile = z.object({
  path: z.string(),
  status: FileStatus,
  contents: z.string().nullable(),
  fromAgents: z.array(Slug),
  /** Git file mode to write; absent keeps the base's (or 100644 for a new file). */
  mode: z.string().optional(),
  /** Copied byte for byte from this blob in the winner's fork (binaries); `contents` is then empty. */
  blob: z.string().optional(),
  /** Assembled from several agents: who wrote each line of `contents` (null: unchanged from base). */
  lineAgents: z.array(Slug.nullable()).optional(),
});
export type AssembledFile = z.infer<typeof AssembledFile>;

export const DecideConflict = z.object({
  path: z.string(),
  detail: z.string(),
  agents: z.array(Slug),
});
export type DecideConflict = z.infer<typeof DecideConflict>;

export const DecidePreview = z.object({
  taskId: Slug,
  baseCommit: z.string(),
  files: z.array(AssembledFile),
  conflicts: z.array(DecideConflict),
});
export type DecidePreview = z.infer<typeof DecidePreview>;

export const Decision = z.object({
  id: z.string(),
  taskId: Slug,
  mode: z.enum(["winner", "assemble"]),
  winnerAgentId: Slug.nullable(),
  selections: z.array(Selection),
  resultCommit: z.string(),
  decidedBy: z.string(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const Workspace = z.object({
  agent: Agent,
  task: Task,
  yard: Yard,
  git: z.object({
    remote: z.string(),
    token: z.string(),
    tokenExpiresAt: z.string().nullable(),
    branch: z.string(),
    cloneCommand: z.string(),
  }),
  agentsMd: z.string(),
  digest: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const CreateYardInput = z.object({
  /** The slug; from `name` when left out. */
  id: Slug.optional(),
  name: z.string().min(1).max(80).optional(),
  /** Seed the base repo from a public https git URL (Artifacts import). */
  importUrl: z.string().url().optional(),
  /** Or seed it with these files (path -> contents). */
  files: z.record(z.string(), z.string()).optional(),
  jurisdiction: Jurisdiction.default("default"),
  previewUrlTemplate: z.string().nullable().optional(),
  budgets: Budgets.partial().optional(),
});
export type CreateYardInput = z.infer<typeof CreateYardInput>;

export const CreateTaskInput = z.object({
  id: Slug.optional(),
  title: z.string().min(1).max(120),
  brief: z.string().max(8000).default(""),
  agents: z.array(AgentSpec).min(1).max(10_000),
  /** Merge the best reviewed fork without asking once the agents settle. Off: a person decides. */
  autopilot: z.boolean().default(true),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/**
 * Where a task's autopilot stands:
 *  - waiting: agents are still working, or reviews are still running
 *  - merged:  autopilot merged the best fork
 *  - handed:  autopilot could not decide alone and asked a person (see the open ask)
 *  - off:     a person decides this task
 */
export const AutopilotState = z.enum(["waiting", "merged", "handed", "off"]);
export type AutopilotState = z.infer<typeof AutopilotState>;

export const AskKind = z.enum(["question", "decision"]);
export type AskKind = z.infer<typeof AskKind>;

export const AskOption = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(200) });
export type AskOption = z.infer<typeof AskOption>;

/**
 * A request for a person. Agents raise `question`s when they are blocked
 * (ask_human); autopilot raises a `decision` when it cannot merge on its own.
 * Everything else is the agents' job.
 */
export const Ask = z.object({
  id: z.string(),
  yardId: z.string(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  kind: AskKind,
  question: z.string(),
  context: z.string().nullable(),
  options: z.array(AskOption),
  status: z.enum(["open", "answered"]),
  answer: z.string().nullable(),
  answeredBy: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
});
export type Ask = z.infer<typeof Ask>;

export const AskInput = z.object({
  question: z.string().min(1).max(500),
  context: z.string().max(4000).optional(),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
});
export type AskInput = z.infer<typeof AskInput>;

export const AnswerInput = z.object({
  optionId: z.string().optional(),
  text: z.string().max(4000).optional(),
}).refine((a) => a.optionId || a.text?.trim(), "pick an option or write an answer");
export type AnswerInput = z.infer<typeof AnswerInput>;

export const IntentInput = z.object({
  summary: z.string().min(1).max(200),
  why: z.string().min(1).max(4000),
  details: z.string().max(8000).optional(),
});
export type IntentInput = z.infer<typeof IntentInput>;

export const ClaimInput = z.object({
  paths: z.array(z.string().min(1).max(300)).min(1).max(100),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** Credentials handed back once when a task fans out. */
export const AgentCredential = z.object({
  agentId: Slug,
  apiKey: z.string(),
});
export type AgentCredential = z.infer<typeof AgentCredential>;

export const BenchStats = z.object({
  n: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  min: z.number(),
  max: z.number(),
  mean: z.number(),
});
export type BenchStats = z.infer<typeof BenchStats>;

// ── backlog: tasks that haven't started ────────────────────────────────────

export const BacklogStatus = z.enum(["open", "started", "done", "dropped"]);
export type BacklogStatus = z.infer<typeof BacklogStatus>;

export const BacklogComment = z.object({ author: z.string(), body: z.string(), createdAt: z.string() });
export type BacklogComment = z.infer<typeof BacklogComment>;

export const BacklogItem = z.object({
  id: z.string(),
  yardId: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  source: z.enum(["forkyard", "github"]),
  sourceRef: z.string().nullable(),
  status: BacklogStatus,
  taskId: z.string().nullable(),
  createdAt: z.string(),
  comments: z.number(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const FileBacklogInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(60_000).default(""),
  labels: z.array(z.string().max(50)).max(20).default([]),
});
export type FileBacklogInput = z.infer<typeof FileBacklogInput>;

export const ImportIssuesInput = z.object({
  /** owner/repo on GitHub. Open issues only; pull requests are skipped. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo"),
});
export type ImportIssuesInput = z.infer<typeof ImportIssuesInput>;

export const StartBacklogInput = z.object({
  agents: z.array(AgentSpec).min(1).max(10_000),
  autopilot: z.boolean().default(true),
});
export type StartBacklogInput = z.infer<typeof StartBacklogInput>;
