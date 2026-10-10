import { actingAgent, AuthError, isMember, principalForToken, type Principal } from "./auth";
import { disposeRepo, getArtifacts } from "./artifacts";
import { origin } from "./better-auth";
import { getAgent, getTask, getYard, newId, now, sha256Hex } from "./db";
import { concat, fromUtf8, utf8 } from "./git/objects";
import { FLUSH } from "./git/pktline";
import { band } from "./git/server";
import { yardStub } from "./yard";
import type { Env } from "./env";
import { Slug, type Yard } from "@forkyard/shared";

/**
 * Git at Forkyard's own address: /git/<owner>/<yard>/<task>/<agent>.git for a seat's fork, and
 * /git/<owner>/<yard>.git for the yard's main (read-only: merging is Forkyard's job). Git signs in with
 * the person's access token (or a headless seat's fy_ key) as its password, kept by their
 * credential helper, so an agent runs plain `git clone` / `git push` and never holds a secret.
 * Forkyard checks the seat, mints a minutes-long Artifacts token for that one fork, and
 * streams the request through. A person's agent takes a seat just by cloning a new name on an open
 * task, and Forkyard talks back in git's own output ("remote: …"): the task on clone, the plan it
 * read, overlaps and reviews on push.
 */
const SEAT = /^\/git\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.git(\/.*)?$/;
const YARD = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export const isForkyardGitPath = (path: string) => SEAT.test(path) || YARD.test(path);

export async function gitProxy(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const seat = SEAT.exec(url.pathname);
  const m = seat ?? YARD.exec(url.pathname)!;
  const [owner, slug] = [m[1]!, m[2]!];
  const [taskId, agentId] = [seat?.[3] ?? "", seat?.[4] ?? ""];
  const rest = (seat ? seat[5] : m[3]) ?? "";
  const say = (status: number, text: string, headers: HeadersInit = {}) => new Response(`${text}\n`, { status, headers });
  const challenge = () =>
    say(401, "Forkyard: use your Forkyard access token as the git password (Settings → Git access).", { "WWW-Authenticate": 'Basic realm="Forkyard"' });

  const secret = passwordOf(req);
  if (!secret) return challenge();
  const p = await principalForToken(env, origin(env, req), secret);
  if (!p) return challenge();
  const row = await env.DB.prepare("SELECT id FROM yards WHERE owner = ? AND slug = ?").bind(owner, slug).first<{ id: string }>();
  const yard = row ? await getYard(env.DB, row.id) : null;
  if (!yard) return say(404, `Forkyard: no yard ${owner}/${slug}`);
  const pushing = rest === "/git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";

  if (!seat) {
    // The yard's main: anyone in the yard can clone it; nobody pushes to it.
    if (p.kind === "agent" ? p.yardId !== yard.id : p.kind === "user" && !(await isMember(env, p.userId, yard.id))) return say(403, "Forkyard: you are not in this yard");
    if (pushing) return say(403, "Forkyard: the yard's main takes no pushes. Push to your seat's fork; Forkyard merges.");
    return forward(env, req, yard.jurisdiction, yard.baseRepo, rest + url.search, "read");
  }
  try {
    await actingAgent(env, p, yard.id, taskId, agentId);
  } catch (err) {
    if (err instanceof AuthError) return say(403, `Forkyard: ${err.message}`);
    throw err;
  }
  let agent = await getAgent(env.DB, yard.id, taskId, agentId);
  if (!agent && p.kind === "user" && Slug.safeParse(agentId).success) {
    // Cloning a new name on an open task takes a seat: the fork is made now.
    try {
      agent = await yardStub(env, yard).addSeat(taskId, agentId, "git");
    } catch (err) {
      return say(403, `Forkyard: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!agent?.forkRemote) return say(404, `Forkyard: ${agentId} has no fork on ${taskId}`);
  const taskUrl = `${origin(env, req)}/${owner}/${slug}/t/${taskId}`;
  const news = (kind: "clone" | "fetch" | "push") => yardStub(env, yard).gitNews(taskId, agentId, kind, taskUrl);

  if (pushing) {
    const task = await getTask(env.DB, yard.id, taskId);
    if (task?.status !== "open" || agent.status === "retired") return say(403, `Forkyard: ${taskId} is ${task?.status ?? "gone"}; its forks take no more pushes`);
  }
  if (req.method !== "POST") return forward(env, req, yard.jurisdiction, agent.forkName, rest + url.search, pushing ? "write" : "read");

  if (pushing) {
    const res = await forward(env, req, yard.jurisdiction, agent.forkName, rest, "write");
    const buf = new Uint8Array(await res.arrayBuffer());
    const ok = res.ok && buf[4] === 1 && fromUtf8(buf.subarray(-4)) === "0000" && fromUtf8(buf).includes("unpack ok");
    const lines = ok ? await news("push").catch((err) => [`Forkyard: ${err instanceof Error ? err.message : String(err)}`]) : [];
    return new Response(lines.length ? concat([buf.subarray(0, -4), say2(lines), FLUSH]) : buf, res);
  }
  // A fetch or clone: the request is a short list of wants/haves, so read it to tell the two apart.
  const body = new Uint8Array(await new Response(req.headers.get("Content-Encoding") === "gzip" ? req.body!.pipeThrough(new DecompressionStream("gzip")) : req.body).arrayBuffer());
  const headers = new Headers(req.headers);
  headers.delete("Content-Encoding");
  const res = await forward(env, new Request(req.url, { method: "POST", headers, body }), yard.jurisdiction, agent.forkName, rest, "read");
  if (!res.ok || !res.body) return res;
  const kind = fromUtf8(body).includes("have ") ? "fetch" : "clone";
  return new Response(appendRemoteLines(res.body, () => news(kind).catch(() => [])), res);
}

/** Lines git prints as "remote: …" (side-band channel 2). */
const say2 = (lines: string[]) => band(2, utf8(lines.map((l) => `${l}\n`).join("")));

/**
 * Stream a fetch response through and, if it carries a pack over side-band, add Forkyard's lines
 * just before the closing flush. Responses without a pack (negotiation rounds, ref listings) pass
 * untouched, since an extra channel-2 packet there would break git.
 */
function appendRemoteLines(body: ReadableStream<Uint8Array>, lines: () => Promise<string[]>): ReadableStream<Uint8Array> {
  let head: Uint8Array = new Uint8Array(0);
  let mode: "sniff" | "pass" | "hold" = "sniff";
  let held: Uint8Array = new Uint8Array(0);
  const push = (chunk: Uint8Array, ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (mode === "pass") return ctl.enqueue(chunk);
    held = concat([held, chunk]);
    if (held.length > 4) {
      ctl.enqueue(held.slice(0, -4));
      held = held.slice(-4);
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (mode !== "sniff") return push(chunk, ctl);
        head = concat([head, chunk]);
        const s = sniffPack(head);
        if (s === "unknown" && head.length < 65536) return;
        mode = s === "pack" ? "hold" : "pass";
        push(head, ctl);
      },
      async flush(ctl) {
        if (mode === "sniff") {
          mode = sniffPack(head) === "pack" ? "hold" : "pass";
          push(head, ctl);
        }
        if (mode === "hold") {
          if (fromUtf8(held) === "0000") {
            const l = await lines();
            if (l.length) ctl.enqueue(say2(l));
          }
          ctl.enqueue(held);
        }
      },
    }),
  );
}

/** Does this upload-pack response go on to send a pack over side-band (protocol v0 or v2)? */
function sniffPack(buf: Uint8Array): "pack" | "none" | "unknown" {
  for (let i = 0; i + 4 <= buf.length; ) {
    const len = parseInt(fromUtf8(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) return "none";
    if (len < 4) {
      i += 4;
      continue;
    }
    if (i + len > buf.length) return "unknown";
    const data = buf.subarray(i + 4, i + len);
    const text = fromUtf8(data);
    if (text === "packfile\n" || data[0] === 1 || data[0] === 2) return "pack";
    if (!/^(ACK|NAK|acknowledgments|ready|shallow|unshallow|wanted-refs|shallow-info)/.test(text)) return "none";
    i += len;
  }
  return "unknown";
}

/** Stream one git request to an Artifacts repo with a minutes-long token minted for it. */
async function forward(env: Env, req: Request, jurisdiction: Yard["jurisdiction"], repoName: string, path: string, scope: "read" | "write"): Promise<Response> {
  const repo = await getArtifacts(env, jurisdiction).get(repoName);
  let token: string;
  let remote: string;
  try {
    token = (await repo.createToken(scope, 600)).plaintext;
    remote = (await repo.info()).remote;
  } finally {
    disposeRepo(repo);
  }
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.set("Authorization", `Bearer ${token}`);
  const out = new Request(remote + path, { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
  if (env.ARTIFACTS_MODE === "local" || !env.ARTIFACTS) return env.ARTIFACTS_EMULATOR.get(env.ARTIFACTS_EMULATOR.idFromName("default")).fetch(out);
  return fetch(out);
}

/** Git's password (Basic auth; the username is ignored) or a Bearer token. */
function passwordOf(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim() || null;
  if (!h.startsWith("Basic ")) return null;
  try {
    const decoded = atob(h.slice(6).trim());
    return decoded.slice(decoded.indexOf(":") + 1) || null;
  } catch {
    return null;
  }
}

// ── access tokens ───────────────────────────────────────────────────────────

function personOf(p: Principal): string {
  if (p.kind !== "user") throw new AuthError("access tokens belong to a person; sign in", 403);
  return p.userId;
}

export async function accessTokens(env: Env, p: Principal) {
  const rows = await env.DB.prepare("SELECT id, name, created_at, last_used_at FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .bind(personOf(p))
    .all<{ id: string; name: string; created_at: string; last_used_at: string | null }>();
  return { tokens: rows.results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })) };
}

/** A new token, shown once. */
export async function accessTokenCreate(env: Env, p: Principal, name: string) {
  const userId = personOf(p);
  const token = `fyp_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const id = newId("at_");
  await env.DB.prepare("INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, userId, name, await sha256Hex(token), now()).run();
  return { id, name, token };
}

export async function accessTokenRevoke(env: Env, p: Principal, id: string) {
  await env.DB.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(now(), id, personOf(p)).run();
  return accessTokens(env, p);
}
