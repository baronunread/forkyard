import { DurableObject } from "cloudflare:workers";
import { entryType, isHash, parseCommit, parseTree, ZERO_HASH, type GitObject, type HashedObject } from "../git/objects";
import { advertise, receivePack, serviceContentType, uploadPack, type GitStore, type RefUpdate } from "../git/server";
import type { Env } from "../env";

/**
 * Local Artifacts emulator.
 *
 * Implements the subset of the Artifacts Workers binding Forkyard uses
 * (create/get/list/delete, fork, tokens, readTree/readBlob/readCommit/
 * readFile/log) plus a git smart-HTTP endpoint, on Durable Object SQLite.
 * Objects are content-addressed and shared across repos, so a fork is a copy
 * of the ref table — the same shape of cost the real service advertises.
 *
 * It also emits `cf.artifacts.repo.pushed` events to the same Queue the
 * production event subscription targets, with the documented payload shape.
 *
 * Only used when `ARTIFACTS_MODE=local`. Never deployed as a substitute for
 * the real service.
 */

export class EmulatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ArtifactsError";
  }
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

type RepoRow = {
  name: string;
  id: string;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  last_push_at: string | null;
  source: string | null;
  read_only: number;
};

export class LocalArtifacts extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY, id TEXT NOT NULL, description TEXT, default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_push_at TEXT, source TEXT, read_only INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS refs (repo TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (repo, name));
      CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, secret TEXT NOT NULL, scope TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private origin(): string {
    return (this.env.LOCAL_GIT_ORIGIN || "http://localhost:8787").replace(/\/$/, "");
  }

  private remote(name: string): string {
    return `${this.origin()}/git/${name}.git`;
  }

  private row(name: string): RepoRow {
    const r = this.sql.exec<RepoRow>("SELECT * FROM repos WHERE name = ?", name).toArray()[0];
    if (!r) throw new EmulatorError("NOT_FOUND", `repo ${name} not found`);
    return r;
  }

  private info_(r: RepoRow) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      defaultBranch: r.default_branch,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastPushAt: r.last_push_at,
      source: r.source,
      readOnly: !!r.read_only,
      remote: this.remote(r.name),
    };
  }

  private mintToken(repo: string, scope: "read" | "write", ttl: number) {
    if (ttl < 60 || ttl > 31536000) throw new EmulatorError("INVALID_TTL", "ttl must be between 60 and 31536000");
    const id = crypto.randomUUID();
    const secret = randomHex(24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    this.sql.exec(
      "INSERT INTO tokens (id, repo, secret, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      repo,
      secret,
      scope,
      now.toISOString(),
      expiresAt,
    );
    return { id, plaintext: `art_local_${id}.${secret}`, scope, expiresAt };
  }

  private store(repo: string): GitStore {
    const sql = this.sql;
    const r = this.row(repo);
    return {
      getObject: (hash) => this.getObject(hash),
      putObjects: (objects: HashedObject[]) => {
        for (const o of objects)
          sql.exec("INSERT OR IGNORE INTO objects (hash, type, data) VALUES (?, ?, ?)", o.hash, o.type, o.data);
      },
      refs: () => new Map(sql.exec<{ name: string; hash: string }>("SELECT name, hash FROM refs WHERE repo = ?", repo).toArray().map((x) => [x.name, x.hash])),
      head: () => `refs/heads/${r.default_branch}`,
      updateRefs: (updates: RefUpdate[]) => {
        const out = new Map<string, string | null>();
        for (const u of updates) {
          const cur = sql.exec<{ hash: string }>("SELECT hash FROM refs WHERE repo = ? AND name = ?", repo, u.ref).toArray()[0]?.hash ?? ZERO_HASH;
          if (cur !== u.old) {
            out.set(u.ref, "fetch first");
            continue;
          }
          if (u.new === ZERO_HASH) sql.exec("DELETE FROM refs WHERE repo = ? AND name = ?", repo, u.ref);
          else sql.exec("INSERT OR REPLACE INTO refs (repo, name, hash) VALUES (?, ?, ?)", repo, u.ref, u.new);
          out.set(u.ref, null);
        }
        return out;
      },
    };
  }

  private getObject(hash: string): GitObject | undefined {
    const o = this.sql.exec<{ type: string; data: ArrayBuffer }>("SELECT type, data FROM objects WHERE hash = ?", hash).toArray()[0];
    return o ? { type: o.type as GitObject["type"], data: new Uint8Array(o.data) } : undefined;
  }

  private resolveRef(repo: string, ref: string): string | null {
    const r = this.row(repo);
    if (isHash(ref)) return this.getObject(ref) ? ref : null;
    const candidates =
      ref === "HEAD"
        ? [`refs/heads/${r.default_branch}`]
        : ref.startsWith("refs/")
          ? [ref]
          : [`refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const c of candidates) {
      const h = this.sql.exec<{ hash: string }>("SELECT hash FROM refs WHERE repo = ? AND name = ?", repo, c).toArray()[0]?.hash;
      if (h) return h;
    }
    return null;
  }

  // ── binding surface (namespace) ────────────────────────────────────────────

  async create(name: string, opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {}) {
    if (!NAME_RE.test(name)) throw new EmulatorError("INVALID_REPO_NAME", name);
    if (this.sql.exec("SELECT 1 FROM repos WHERE name = ?", name).toArray().length)
      throw new EmulatorError("ALREADY_EXISTS", name);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const branch = opts.setDefaultBranch ?? "main";
    this.sql.exec(
      "INSERT INTO repos (name, id, description, default_branch, created_at, updated_at, read_only) VALUES (?, ?, ?, ?, ?, ?, ?)",
      name,
      id,
      opts.description ?? null,
      branch,
      now,
      now,
      opts.readOnly ? 1 : 0,
    );
    const token = this.mintToken(name, "write", 86400);
    return { id, name, description: opts.description ?? null, defaultBranch: branch, remote: this.remote(name), token: token.plaintext };
  }

  async info(name: string) {
    return this.info_(this.row(name));
  }

  async list(opts: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const rows = this.sql
      .exec<RepoRow>("SELECT * FROM repos WHERE name > ? ORDER BY name LIMIT ?", opts.cursor ?? "", limit + 1)
      .toArray();
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM repos").one().n;
    const page = rows.slice(0, limit);
    const repos = page.map((r) => {
      const { remote: _r, ...rest } = this.info_(r);
      return rest;
    });
    return { repos, total, cursor: rows.length > limit ? page[page.length - 1]!.name : undefined };
  }

  async delete(name: string) {
    if (!NAME_RE.test(name)) throw new EmulatorError("INVALID_REPO_NAME", name);
    const existed = this.sql.exec("SELECT 1 FROM repos WHERE name = ?", name).toArray().length > 0;
    this.sql.exec("DELETE FROM repos WHERE name = ?", name);
    this.sql.exec("DELETE FROM refs WHERE repo = ?", name);
    this.sql.exec("DELETE FROM tokens WHERE repo = ?", name);
    return existed;
  }

  // ── binding surface (repo) ───────────────────────────────────────────────

  async fork(source: string, name: string, opts: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean } = {}) {
    const src = this.row(source);
    const created = await this.create(name, { description: opts.description, readOnly: opts.readOnly, setDefaultBranch: src.default_branch });
    const only = opts.defaultBranchOnly ?? true;
    if (only)
      this.sql.exec(
        "INSERT INTO refs (repo, name, hash) SELECT ?, name, hash FROM refs WHERE repo = ? AND name = ?",
        name,
        source,
        `refs/heads/${src.default_branch}`,
      );
    else this.sql.exec("INSERT INTO refs (repo, name, hash) SELECT ?, name, hash FROM refs WHERE repo = ?", name, source);
    this.sql.exec("UPDATE repos SET source = ? WHERE name = ?", `artifacts:local/${source}`, name);
    return created;
  }

  async createToken(repo: string, scope: "write" | "read" = "write", ttl = 86400) {
    this.row(repo);
    return this.mintToken(repo, scope, ttl);
  }

  async listTokens(repo: string) {
    const now = new Date().toISOString();
    const rows = this.sql
      .exec<{ id: string; scope: string; created_at: string; expires_at: string; revoked: number }>(
        "SELECT id, scope, created_at, expires_at, revoked FROM tokens WHERE repo = ? ORDER BY created_at",
        repo,
      )
      .toArray();
    return {
      tokens: rows.map((t) => ({
        id: t.id,
        scope: t.scope as "read" | "write",
        state: (t.revoked ? "revoked" : t.expires_at < now ? "expired" : "active") as "active" | "expired" | "revoked",
        createdAt: t.created_at,
        expiresAt: t.expires_at,
      })),
      total: rows.length,
    };
  }

  async revokeToken(repo: string, tokenOrId: string) {
    if (!tokenOrId) throw new EmulatorError("INVALID_INPUT", "tokenOrId is empty");
    const id = tokenOrId.startsWith("art_local_") ? tokenOrId.slice(10).split(".")[0]! : tokenOrId;
    const cur = this.sql.exec("SELECT 1 FROM tokens WHERE repo = ? AND id = ? AND revoked = 0", repo, id).toArray();
    this.sql.exec("UPDATE tokens SET revoked = 1 WHERE repo = ? AND id = ?", repo, id);
    return cur.length > 0;
  }

  async readBlob(repo: string, hash: string) {
    this.row(repo);
    if (!isHash(hash)) throw new EmulatorError("INVALID_INPUT", "malformed hash");
    const o = this.getObject(hash);
    return o && o.type === "blob" ? o.data : null;
  }

  async readTree(repo: string, hash: string) {
    this.row(repo);
    if (!isHash(hash)) throw new EmulatorError("INVALID_INPUT", "malformed hash");
    const o = this.getObject(hash);
    if (!o) return null;
    if (o.type !== "tree") throw new EmulatorError("INTERNAL_ERROR", "not a tree");
    return parseTree(o.data).map((e) => ({ ...e, type: entryType(e.mode) }));
  }

  async readCommit(repo: string, hash: string) {
    this.row(repo);
    if (!isHash(hash)) throw new EmulatorError("INVALID_INPUT", "malformed hash");
    const o = this.getObject(hash);
    if (!o) return null;
    if (o.type !== "commit") throw new EmulatorError("INTERNAL_ERROR", "not a commit");
    return commitMetadata(hash, o.data);
  }

  async readFile(repo: string, args: { ref: string; path: string }) {
    if (!args.ref || !args.path) throw new EmulatorError("INVALID_INPUT", "ref and path are required");
    const commitHash = this.resolveRef(repo, args.ref);
    if (!commitHash) return null;
    const commit = this.getObject(commitHash);
    if (!commit || commit.type !== "commit") return null;
    let tree = parseCommit(commit.data).tree;
    const parts = args.path.replace(/^\/+/, "").split("/");
    for (let i = 0; i < parts.length; i++) {
      const t = this.getObject(tree);
      if (!t) return null;
      const e = parseTree(t.data).find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) {
        const blob = this.getObject(e.hash);
        return blob?.type === "blob" ? { bytes: blob.data, type: contentType(args.path) } : null;
      }
      tree = e.hash;
    }
    return null;
  }

  async log(repo: string, opts: { ref?: string; limit?: number; offset?: number } = {}) {
    const start = this.resolveRef(repo, opts.ref ?? "HEAD");
    if (!start) return [];
    const limit = Math.min(1000, opts.limit ?? 50);
    const offset = opts.offset ?? 0;
    const out = [];
    let cur: string | undefined = start;
    let i = 0;
    while (cur && out.length < limit) {
      const o = this.getObject(cur);
      if (!o) break;
      const meta = commitMetadata(cur, o.data);
      if (i++ >= offset) out.push(meta);
      cur = meta.parents[0];
    }
    return out;
  }

  /** Write a commit's objects and move a ref (used to seed base repos from files). */
  async writeObjects(repo: string, objects: HashedObject[], ref: string, expectedOld: string | null, newHash: string) {
    const store = this.store(repo);
    store.putObjects(objects);
    const res = store.updateRefs([{ ref, old: expectedOld ?? ZERO_HASH, new: newHash }]);
    const err = res.get(ref);
    if (err) throw new EmulatorError("INVALID_INPUT", `${ref}: ${err}`);
    this.sql.exec("UPDATE repos SET updated_at = ?, last_push_at = ? WHERE name = ?", new Date().toISOString(), new Date().toISOString(), repo);
    // Like a real push: Artifacts emits push events for server-side writes too (they are git pushes there).
    this.ctx.waitUntil(this.emitPushed(repo, [{ ref, old: expectedOld ?? ZERO_HASH, new: newHash }]));
  }

  // ── git smart HTTP ─────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/git\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const repo = m[1]!;
    const op = m[2]!;
    const service = op === "info/refs" ? url.searchParams.get("service") : op;
    if (service !== "git-upload-pack" && service !== "git-receive-pack")
      return new Response("dumb HTTP is not supported", { status: 403 });
    let r: RepoRow;
    try {
      r = this.row(repo);
    } catch {
      return new Response("repository not found", { status: 404 });
    }
    const auth = this.checkAuth(request, repo, service === "git-receive-pack" ? "write" : "read");
    if (auth) return auth;
    if (service === "git-receive-pack" && r.read_only) return new Response("repository is read-only", { status: 403 });

    const store = this.store(repo);
    if (op === "info/refs") {
      return new Response(advertise(service, store), {
        headers: { "Content-Type": serviceContentType(service, "advertisement"), "Cache-Control": "no-cache" },
      });
    }
    const body = await readBody(request);
    if (service === "git-upload-pack") {
      return new Response(uploadPack(body, store), { headers: { "Content-Type": serviceContentType(service, "result") } });
    }
    const { response, updates } = receivePack(body, store);
    if (updates.length) {
      const now = new Date().toISOString();
      this.sql.exec("UPDATE repos SET updated_at = ?, last_push_at = ? WHERE name = ?", now, now, repo);
      this.ctx.waitUntil(this.emitPushed(repo, updates));
    }
    return new Response(response, { headers: { "Content-Type": serviceContentType(service, "result") } });
  }

  private checkAuth(request: Request, repo: string, need: "read" | "write"): Response | null {
    const header = request.headers.get("Authorization") ?? "";
    let token = "";
    if (header.startsWith("Bearer ")) token = header.slice(7).trim();
    else if (header.startsWith("Basic ")) token = atob(header.slice(6)).split(":").slice(1).join(":");
    const deny = () =>
      new Response("authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="artifacts"' } });
    const m = /^art_local_([0-9a-f-]{36})\.([0-9a-f]+)$/.exec(token);
    if (!m) return deny();
    const row = this.sql
      .exec<{ secret: string; scope: string; expires_at: string; revoked: number }>(
        "SELECT secret, scope, expires_at, revoked FROM tokens WHERE id = ? AND repo = ?",
        m[1]!,
        repo,
      )
      .toArray()[0];
    if (!row || row.secret !== m[2] || row.revoked || row.expires_at < new Date().toISOString()) return deny();
    if (need === "write" && row.scope !== "write") return new Response("token is read-only", { status: 403 });
    return null;
  }

  private async emitPushed(repo: string, updates: RefUpdate[]) {
    if (!this.env.ARTIFACT_EVENTS) return;
    const messages = updates
      .filter((u) => u.new !== ZERO_HASH)
      .map((u) => {
        const o = this.getObject(u.new);
        const meta = o ? commitMetadata(u.new, o.data) : null;
        return {
          body: {
            type: "cf.artifacts.repo.pushed",
            source: { type: "artifacts.repo", namespace: this.env.ARTIFACTS_NAMESPACE ?? "local", repoName: repo },
            payload: {
              ref: u.ref,
              before: u.old,
              after: u.new,
              commits: meta
                ? [
                    {
                      id: u.new,
                      message: meta.message,
                      messageTruncated: false,
                      timestamp: new Date(meta.committedAt * 1000).toISOString(),
                      author: meta.author,
                    },
                  ]
                : [],
            },
            metadata: { emittedAt: new Date().toISOString(), emulator: true },
          },
        };
      });
    if (messages.length) await this.env.ARTIFACT_EVENTS.sendBatch(messages);
  }
}

function commitMetadata(hash: string, data: Uint8Array) {
  const c = parseCommit(data);
  return {
    hash,
    treeHash: c.tree,
    message: c.message.replace(/\n$/, ""),
    author: { name: c.author.name, email: c.author.email },
    committer: { name: c.committer.name, email: c.committer.email },
    parents: c.parents,
    authoredAt: c.author.time,
    committedAt: c.committer.time,
  };
}

async function readBody(request: Request): Promise<Uint8Array> {
  let stream = request.body;
  if (!stream) return new Uint8Array();
  if (request.headers.get("Content-Encoding") === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    svg: "image/svg+xml",
  };
  return map[ext] ?? "text/plain; charset=utf-8";
}
