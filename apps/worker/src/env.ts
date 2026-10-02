import type { LocalArtifacts } from "./artifacts/emulator";
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

  // Events and review pipeline
  ARTIFACT_EVENTS?: Queue;
  REVIEW_WORKFLOW: Workflow<ReviewParams>;
  AI?: Ai;
  REVIEW_MODEL?: string;

  // K2 spike (optional)
  EVENTS_K2?: K2Producer;
  K2_STREAM_ID?: string;
  K2_SUBSCRIPTION_ID?: string;
  K2_API_TOKEN?: string;

  // Static assets
  ASSETS?: Fetcher;

  // Auth
  FORKYARD_ADMIN_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  // Tuning
  FORK_TTL_HOURS?: string;
  TOKEN_TTL_SECONDS?: string;
  PUBLIC_ORIGIN?: string;
}

export function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
