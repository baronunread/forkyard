import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCommit, textFile } from "../src/git/build";
import { pushObjects } from "../src/git/client";
import { parseCommit, parseTree, type GitObject, type HashedObject } from "../src/git/objects";
import { readPack, writePack } from "../src/git/pack";
import { advertise, receivePack, uploadPack, type GitStore } from "../src/git/server";

class MemStore implements GitStore {
  objects = new Map<string, GitObject>();
  refMap = new Map<string, string>();
  getObject(h: string) {
    return this.objects.get(h);
  }
  putObjects(objs: HashedObject[]) {
    for (const o of objs) this.objects.set(o.hash, { type: o.type, data: o.data });
  }
  refs() {
    return new Map(this.refMap);
  }
  head() {
    return "refs/heads/main";
  }
  updateRefs(updates: { ref: string; old: string; new: string }[]) {
    const out = new Map<string, string | null>();
    for (const u of updates) {
      const cur = this.refMap.get(u.ref) ?? "0".repeat(40);
      if (cur !== u.old) out.set(u.ref, "fetch first");
      else {
        if (u.new === "0".repeat(40)) this.refMap.delete(u.ref);
        else this.refMap.set(u.ref, u.new);
        out.set(u.ref, null);
      }
    }
    return out;
  }
}

const store = new MemStore();
let server: Server;
let remote = "";
const TOKEN = "secret-token";

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    encoding: "utf8",
  });
  return stdout;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' }).end();
      return;
    }
    const url = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));
    if (url.pathname.endsWith("/info/refs")) {
      const svc = url.searchParams.get("service") as "git-upload-pack" | "git-receive-pack";
      res.writeHead(200, { "Content-Type": `application/x-${svc}-advertisement`, "Cache-Control": "no-cache" });
      res.end(Buffer.from(advertise(svc, store)));
    } else if (url.pathname.endsWith("/git-upload-pack")) {
      res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result" });
      res.end(Buffer.from(uploadPack(body, store)));
    } else if (url.pathname.endsWith("/git-receive-pack")) {
      res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result" });
      res.end(Buffer.from(receivePack(body, store).response));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  remote = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/git/test.git`;
});

afterAll(() => server?.close());

describe("pack round-trip", () => {
  it("writes and reads undeltified packs", () => {
    const objs = [{ type: "blob" as const, data: new TextEncoder().encode("hello\n") }];
    const back = readPack(writePack(objs));
    expect(back[0]!.hash).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("smart HTTP with real git", () => {
  it("accepts a first push, serves clones, accepts delta pushes, and our own client push", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fy-git-"));
    const a = join(dir, "a");
    mkdirSync(a);
    await git(a, "init", "-q", "-b", "main");
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} of a file that compresses into deltas`).join("\n");
    writeFileSync(join(a, "README.md"), "# demo\n");
    mkdirSync(join(a, "src"));
    writeFileSync(join(a, "src", "big.txt"), `${big}\n`);
    await git(a, "add", "-A");
    await git(a, "commit", "-qm", "init");
    await git(a, "push", "-q", remote, "main:refs/heads/main");
    expect(store.refMap.get("refs/heads/main")).toMatch(/^[0-9a-f]{40}$/);

    const b = join(dir, "b");
    await git(dir, "clone", "-q", remote, b);
    expect(readFileSync(join(b, "README.md"), "utf8")).toBe("# demo\n");

    // A small change to a big file makes git send an OFS_DELTA.
    writeFileSync(join(b, "src", "big.txt"), `${big.replace("line 200 ", "LINE 200 ")}\nmore\n`);
    await git(b, "commit", "-qam", "edit big file");
    await git(b, "push", "-q", "origin", "main");
    const head = store.refMap.get("refs/heads/main")!;
    const commit = parseCommit(store.getObject(head)!.data);
    expect(commit.message).toBe("edit big file\n");

    // Our own push client, building a commit on top of the current head.
    const reader = { readTree: async (h: string) => parseTree(store.getObject(h)!.data) };
    const built = await buildCommit({
      reader,
      baseTree: commit.tree,
      parents: [head],
      changes: new Map([
        ["src/new/file.ts", textFile("export const x = 1;\n")],
        ["README.md", textFile("# demo\n\nmerged by forkyard\n")],
      ]),
      message: "forkyard merge",
    });
    await pushObjects({ remote, token: TOKEN, ref: "refs/heads/main", newHash: built.commit, objects: built.objects, expectedOld: head });
    expect(store.refMap.get("refs/heads/main")).toBe(built.commit);

    // Incremental fetch with haves.
    await git(a, "fetch", "-q", remote, "main");
    await git(a, "reset", "-q", "--hard", "FETCH_HEAD");
    expect(readFileSync(join(a, "src", "new", "file.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(readFileSync(join(a, "README.md"), "utf8")).toContain("merged by forkyard");
    await git(a, "fsck", "--strict");

    // A stale expectedOld is rejected before sending anything.
    await expect(
      pushObjects({ remote, token: TOKEN, ref: "refs/heads/main", newHash: built.commit, objects: built.objects, expectedOld: head }),
    ).rejects.toThrow(/moved/);
  });
});
