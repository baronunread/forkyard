import { concat, parseCommit, parseTree, ZERO_HASH, type GitObject, type HashedObject } from "./objects";
import { readPack, writePack } from "./pack";
import { FLUSH, pkt, pktText, readPkts } from "./pktline";

/**
 * Git smart-HTTP server (protocol v0) over a synchronous object store. Used
 * by the local Artifacts emulator so `bun run dev` supports real `git clone` and
 * `git push` without a Cloudflare account.
 */

export interface GitStore {
  getObject(hash: string): GitObject | undefined;
  putObjects(objects: HashedObject[]): void;
  refs(): Map<string, string>;
  head(): string;
  /** Compare-and-swap ref updates; returns an error string per failed ref. */
  updateRefs(updates: RefUpdate[]): Map<string, string | null>;
}

export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

const AGENT = "agent=forkyard-artifacts-emulator";

export function advertise(service: "git-upload-pack" | "git-receive-pack", store: GitStore): Uint8Array {
  const refs = store.refs();
  const head = store.head();
  const caps =
    service === "git-upload-pack"
      ? `ofs-delta side-band-64k symref=HEAD:${head} ${AGENT}`
      : `report-status delete-refs ofs-delta side-band-64k ${AGENT}`;
  const lines: Uint8Array[] = [pkt(`# service=${service}\n`), FLUSH];
  const entries: [string, string][] = [];
  const headHash = refs.get(head);
  if (service === "git-upload-pack" && headHash) entries.push(["HEAD", headHash]);
  for (const [name, hash] of [...refs.entries()].sort(([a], [b]) => a.localeCompare(b))) entries.push([name, hash]);
  if (entries.length === 0) {
    lines.push(pkt(`${ZERO_HASH} capabilities^{}\0${caps}\n`));
  } else {
    entries.forEach(([name, hash], i) => lines.push(pkt(i === 0 ? `${hash} ${name}\0${caps}\n` : `${hash} ${name}\n`)));
  }
  lines.push(FLUSH);
  return concat(lines);
}

export function uploadPack(body: Uint8Array, store: GitStore): Uint8Array {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let banded = false;
  let offset = 0;
  while (offset < body.length) {
    const { items, offset: next } = readPkts(body, offset, 1);
    if (next === offset) break;
    offset = next;
    for (const item of items) {
      const line = pktText(item);
      if (!line) continue;
      if (line.startsWith("want ")) {
        wants.push(line.slice(5, 45));
        if (line.includes("side-band-64k")) banded = true;
      }
      else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
      else if (line === "done") done = true;
    }
  }
  const common = haves.filter((h) => store.getObject(h));
  if (!done) {
    // Stateless negotiation round without multi_ack: ACK the first common commit, else NAK.
    return common[0] ? pkt(`ACK ${common[0]}\n`) : pkt("NAK\n");
  }
  const exclude = closure(common, store);
  const send = closure(wants, store, exclude);
  const objects: GitObject[] = [];
  for (const h of send) {
    const o = store.getObject(h);
    if (o) objects.push(o);
  }
  const ack = common[0] ? pkt(`ACK ${common[0]}\n`) : pkt("NAK\n");
  return concat([ack, banded ? concat([band(1, writePack(objects)), FLUSH]) : writePack(objects)]);
}

/** All objects reachable from `roots`, skipping anything in `stop`. */
export function closure(roots: string[], store: GitStore, stop: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h) || stop.has(h)) continue;
    const o = store.getObject(h);
    if (!o) continue;
    seen.add(h);
    if (o.type === "commit") {
      const c = parseCommit(o.data);
      stack.push(c.tree, ...c.parents);
    } else if (o.type === "tree") {
      for (const e of parseTree(o.data)) if (e.mode !== "160000") stack.push(e.hash);
    }
  }
  return seen;
}

export function receivePack(body: Uint8Array, store: GitStore): { response: Uint8Array; updates: RefUpdate[] } {
  const { items, offset } = readPkts(body, 0, 1);
  const commands: RefUpdate[] = [];
  let banded = false;
  for (const item of items) {
    const line = pktText(item);
    if (!line) continue;
    const [cmd, caps] = line.split("\0");
    if (caps?.includes("side-band-64k")) banded = true;
    const [oldHash, newHash, ref] = cmd!.split(" ");
    if (oldHash && newHash && ref) commands.push({ old: oldHash, new: newHash, ref });
  }
  const packBytes = body.subarray(offset);
  let unpack = "ok";
  if (packBytes.length > 0 && commands.some((c) => c.new !== ZERO_HASH)) {
    try {
      const objects = readPack(packBytes, (h) => store.getObject(h));
      store.putObjects(objects);
    } catch (err) {
      unpack = err instanceof Error ? err.message : String(err);
    }
  }
  const lines: Uint8Array[] = [pkt(`unpack ${unpack}\n`)];
  const applied: RefUpdate[] = [];
  if (unpack === "ok") {
    const valid = commands.filter((c) => {
      if (c.new !== ZERO_HASH && !store.getObject(c.new)) {
        lines.push(pkt(`ng ${c.ref} missing object ${c.new}\n`));
        return false;
      }
      if (!c.ref.startsWith("refs/")) {
        lines.push(pkt(`ng ${c.ref} funny refname\n`));
        return false;
      }
      return true;
    });
    const results = store.updateRefs(valid);
    for (const c of valid) {
      const err = results.get(c.ref);
      if (err) lines.push(pkt(`ng ${c.ref} ${err}\n`));
      else {
        lines.push(pkt(`ok ${c.ref}\n`));
        applied.push(c);
      }
    }
  } else {
    for (const c of commands) lines.push(pkt(`ng ${c.ref} unpacker error\n`));
  }
  lines.push(FLUSH);
  const status = concat(lines);
  return { response: banded ? concat([band(1, status), FLUSH]) : status, updates: applied };
}

/** Side-band-64k: `data` split into band `n` pkt-lines (1 = data, 2 = progress shown as "remote:"). */
export function band(n: 1 | 2, data: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 65515) out.push(pkt(concat([Uint8Array.of(n), data.subarray(i, i + 65515)])));
  return concat(out);
}

export function serviceContentType(service: string, kind: "advertisement" | "result"): string {
  return `application/x-${service}-${kind}`;
}
