import type { Jurisdiction } from "@forkyard/shared";
import type { Env } from "../env";
import type { BuiltCommit } from "../git/build";
import { pushObjects } from "../git/client";
import type { TreeEntry } from "../git/objects";

/**
 * One interface over the real Artifacts Workers binding and the local
 * emulator. The method names and shapes are the binding's
 * (@cloudflare/workers-types `Artifacts` / `ArtifactsRepo`); the emulator
 * implements the same subset.
 */

export type RepoInfo = ArtifactsRepoInfo;
export type CreateRepoResult = ArtifactsCreateRepoResult;
export type CommitMeta = ArtifactsCommitMetadata;

export interface Repo {
  info(): Promise<RepoInfo>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<CreateRepoResult>;
  createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readCommit(hash: string): Promise<CommitMeta | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<CommitMeta[]>;
}

export interface ArtifactsApi {
  readonly mode: "local" | "remote";
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<CreateRepoResult>;
  get(name: string): Promise<Repo>;
  import(params: Parameters<Artifacts["import"]>[0]): Promise<CreateRepoResult>;
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;
  delete(name: string): Promise<boolean>;
  /** Write a prepared commit to a ref (Forkyard-side merge). */
  writeCommit(repo: string, built: BuiltCommit, ref: string, expectedOld: string | null): Promise<void>;
}

export function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string")
    return (err as { code: string }).code;
  const msg = err instanceof Error ? err.message : String(err);
  const m = /\b(ALREADY_EXISTS|NOT_FOUND|CREATE_IN_PROGRESS|IMPORT_IN_PROGRESS|FORK_IN_PROGRESS|INVALID_INPUT|INVALID_REPO_NAME|INVALID_TTL|INVALID_URL|REMOTE_AUTH_REQUIRED|UPSTREAM_UNAVAILABLE|MEMORY_LIMIT|INTERNAL_ERROR)\b/.exec(msg);
  return m ? m[1]! : null;
}

export function getArtifacts(env: Env, jurisdiction: Jurisdiction = "default"): ArtifactsApi {
  if (env.ARTIFACTS_MODE === "local" || !env.ARTIFACTS) {
    if (env.ARTIFACTS_MODE === "remote") throw new Error("ARTIFACTS_MODE=remote but no ARTIFACTS binding is configured");
    return localArtifacts(env, jurisdiction);
  }
  const binding = jurisdiction === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;
  if (!binding) throw new Error("This deployment has no EU Artifacts namespace bound (ARTIFACTS_EU)");
  return remoteArtifacts(binding);
}

function remoteArtifacts(binding: Artifacts): ArtifactsApi {
  return {
    mode: "remote",
    create: (name, opts) => binding.create(name, opts),
    get: (name) => binding.get(name),
    import: (params) => binding.import(params),
    list: (opts) => binding.list(opts),
    delete: (name) => binding.delete(name),
    async writeCommit(repoName, built, ref, expectedOld) {
      const repo = await binding.get(repoName);
      try {
        const info = await repo.info();
        const token = await repo.createToken("write", 120);
        try {
          await pushObjects({ remote: info.remote, token: token.plaintext, ref, newHash: built.commit, objects: built.objects, expectedOld });
        } finally {
          await repo.revokeToken(token.id).catch(() => false);
        }
      } finally {
        repo[Symbol.dispose]?.();
      }
    },
  };
}

function localArtifacts(env: Env, jurisdiction: Jurisdiction): ArtifactsApi {
  // The emulator keeps one object per namespace; EU yards get their own instance.
  const stub = env.ARTIFACTS_EMULATOR.get(env.ARTIFACTS_EMULATOR.idFromName(jurisdiction === "eu" ? "eu" : "default"));
  const repo = (name: string): Repo => ({
    info: () => stub.info(name),
    fork: (target, opts) => stub.fork(name, target, opts),
    createToken: (scope, ttl) => stub.createToken(name, scope, ttl),
    revokeToken: (t) => stub.revokeToken(name, t),
    async readBlob(hash) {
      const b = await stub.readBlob(name, hash);
      return b ? new Blob([b]) : null;
    },
    readTree: (hash) => stub.readTree(name, hash) as Promise<ArtifactsTreeEntry[] | null>,
    readCommit: (hash) => stub.readCommit(name, hash),
    async readFile(args) {
      const f = await stub.readFile(name, args);
      return f ? new Blob([f.bytes], { type: f.type }) : null;
    },
    log: (opts) => stub.log(name, opts),
  });
  return {
    mode: "local",
    create: (name, opts) => stub.create(name, opts),
    async get(name) {
      await stub.info(name); // throws NOT_FOUND like the binding
      return repo(name);
    },
    import: () => Promise.reject(new Error("INVALID_INPUT: import is not supported by the local Artifacts emulator; pass `files` instead")),
    list: (opts) => stub.list(opts) as Promise<ArtifactsRepoListResult>,
    delete: (name) => stub.delete(name),
    writeCommit: (repoName, built, ref, expectedOld) => stub.writeObjects(repoName, built.objects, ref, expectedOld, built.commit),
  };
}

/** Adapt an Artifacts repo to the tree reader the commit builder needs. */
export function treeReader(repo: Repo): { readTree(hash: string): Promise<TreeEntry[] | null> } {
  return {
    async readTree(hash) {
      const entries = await repo.readTree(hash);
      return entries ? entries.map((e) => ({ mode: e.mode === "040000" ? "40000" : e.mode, name: e.name, hash: e.hash })) : null;
    },
  };
}

export async function blobText(b: Blob | null): Promise<{ text: string | null; binary: boolean; size: number }> {
  if (!b) return { text: null, binary: false, size: 0 };
  const bytes = new Uint8Array(await b.arrayBuffer());
  const probe = bytes.subarray(0, 8000);
  if (probe.includes(0)) return { text: null, binary: true, size: bytes.length };
  return { text: new TextDecoder().decode(bytes), binary: false, size: bytes.length };
}

export function disposeRepo(repo: Repo): void {
  (repo as Partial<Disposable>)[Symbol.dispose]?.();
}
