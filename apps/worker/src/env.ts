import type { IssueImportParams } from "./backlog";
import type { LocalArtifacts } from "./artifacts/emulator";
import type { PiAgent } from "./pi-agent";
import type { Yard } from "./yard";
import type { ReviewParams } from "./review";

/** Minimal K2 producer binding surface (beta). See docs/decisions/events.md. */
export interface K2Producer {
  send(
    records: { content: ArrayBuffer | Uint8Array; headers?: Record<string, string>; key?: string }[],
  ): Promise<{ success: boolean; error?: { message: string; retryable?: boolean } }>;
}

export interface Env {
  // Artifacts
  ARTIFACTS?: Artifacts;
  /** Optional second binding to an EU-jurisdiction namespace. */
  ARTIFACTS_EU?: Artifacts;
  ARTIFACTS_MODE?: "local" | "remote";
  ARTIFACTS_NAMESPACE?: string;
  ARTIFACTS_EMULATOR: DurableObjectNamespace<LocalArtifacts>;
  LOCAL_GIT_ORIGIN?: string;

  // State
  DB: D1Database;
  YARD: DurableObjectNamespace<Yard>;
  /** Workers AI model for cloud agents when the task owner hasn't connected ChatGPT. */
  PI_AGENT_MODEL?: string;
  /** Cloud agents: one Pi Durable harness per agent seat. */
  PI_AGENT: DurableObjectNamespace<PiAgent>;

  // Events and review pipeline
  ARTIFACT_EVENTS?: Queue;
  REVIEW_WORKFLOW: Workflow<ReviewParams>;
  /** Imports a GitHub repo's open issues into a new yard's backlog, surviving the browser. */
  ISSUE_IMPORT_WORKFLOW: Workflow<IssueImportParams>;
  AI?: Ai;
  /** Autopilot merges the best fork once every agent's head is reviewed and the task has been quiet this long (default 15000). */
  AUTOPILOT_QUIET_MS?: string;
  /** The lowest review score autopilot merges without asking (default 60). */
  AUTOPILOT_MIN_SCORE?: string;
  /** Reviews in flight per yard at once (default 16); the rest queue. */
  REVIEW_CONCURRENCY?: string;
  /** "off" skips the review pipeline on push (diagnostics; overlaps then come from claims only). */
  REVIEWS?: string;
  REVIEW_MODEL?: string;

  // K2 spike (optional)
  EVENTS_K2?: K2Producer;
  K2_STREAM_ID?: string;
  K2_SUBSCRIPTION_ID?: string;
  K2_API_TOKEN?: string;

  // Static assets
  ASSETS?: Fetcher;

  // Auth (Better Auth): people sign in with GitHub / Google; agents use OAuth (or per-agent keys)
  BETTER_AUTH_SECRET?: string;
  FORKYARD_ADMIN_KEY?: string;
  /** "true" (local only): anonymous requests act as admin, for the scripts. */
  FORKYARD_DEV?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Local only: emulate.dev base URLs that stand in for GitHub and Google. */
  EMULATE_GITHUB_URL?: string;
  EMULATE_GOOGLE_URL?: string;
  /** Where the Worker itself reaches the emulators, when that differs from the browser-facing URL (portless). */
  EMULATE_GITHUB_INTERNAL_URL?: string;
  EMULATE_GOOGLE_INTERNAL_URL?: string;

  // Hard limits (src/limits.ts); unset = no cap
  FORKYARD_PAUSED?: string;
  LIMIT_YARDS_PER_ACCOUNT?: string;
  LIMIT_TASKS_PER_ACCOUNT_PER_DAY?: string;
  LIMIT_AGENTS_PER_TASK?: string;
  LIMIT_LIVE_FORKS?: string;
  LIMIT_AGENT_TURNS?: string;
  LIMIT_WORKERS_AI_PER_DAY?: string;

  // Tuning
  FORK_TTL_HOURS?: string;
  /** How many queued push events one consumer invocation routes at once (default 8). */
  QUEUE_CONCURRENCY?: string;
  /** How many forks a fan-out runs at once (default 64). */
  FORK_CONCURRENCY?: string;
  TOKEN_TTL_SECONDS?: string;
  /** Canonical origin, e.g. https://forkyard.example.com — the OAuth issuer and MCP resource. */
  PUBLIC_ORIGIN?: string;
}

export function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
