import { createHash } from "node:crypto";

/**
 * Minimal Git object model: enough to read and write blobs, trees and
 * commits, which is all Forkyard needs to build merge commits and to run the
 * local Artifacts emulator.
 */

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

export interface HashedObject extends GitObject {
  hash: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ZERO_HASH = "0000000000000000000000000000000000000000";

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha1(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  return sha1(concat([utf8(`${type} ${data.length}\0`), data]));
}

export function makeObject(type: ObjectType, data: Uint8Array): HashedObject {
  return { type, data, hash: hashObject(type, data) };
}

export function isHash(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// ── Trees ────────────────────────────────────────────────────────────────

export interface TreeEntry {
  mode: string;
  name: string;
  hash: string;
}

export function entryType(mode: string): "tree" | "blob" | "symlink" | "gitlink" | "exec" {
  if (mode === "40000" || mode === "040000") return "tree";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  if (mode === "100755") return "exec";
  return "blob";
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = fromUtf8(data.subarray(i, sp));
    const name = fromUtf8(data.subarray(sp + 1, nul));
    const hash = toHex(data.subarray(nul + 1, nul + 21));
    out.push({ mode: mode === "040000" ? "40000" : mode, name, hash });
    i = nul + 21;
  }
  return out;
}

/** Git sorts tree entries as if directories had a trailing slash. */
function treeSortKey(e: TreeEntry): string {
  return entryType(e.mode) === "tree" ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return concat(sorted.flatMap((e) => [utf8(`${e.mode} ${e.name}\0`), fromHex(e.hash)]));
}

// ── Commits ──────────────────────────────────────────────────────────────

export interface Signature {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

function parseSignature(s: string): Signature {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (!m) return { name: s, email: "", time: 0, tz: "+0000" };
  return { name: m[1]!, email: m[2]!, time: Number(m[3]), tz: m[4]! };
}

function formatSignature(s: Signature): string {
  return `${s.name} <${s.email}> ${s.time} ${s.tz}`;
}

export function parseCommit(data: Uint8Array): Commit {
  const text = fromUtf8(data);
  const split = text.indexOf("\n\n");
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : "";
  const c: Commit = {
    tree: "",
    parents: [],
    author: { name: "", email: "", time: 0, tz: "+0000" },
    committer: { name: "", email: "", time: 0, tz: "+0000" },
    message,
  };
  for (const line of header.split("\n")) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (key === "tree") c.tree = val;
    else if (key === "parent") c.parents.push(val);
    else if (key === "author") c.author = parseSignature(val);
    else if (key === "committer") c.committer = parseSignature(val);
  }
  return c;
}

export function serializeCommit(c: Commit): Uint8Array {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`)];
  lines.push(`author ${formatSignature(c.author)}`, `committer ${formatSignature(c.committer)}`);
  const msg = c.message.endsWith("\n") ? c.message : `${c.message}\n`;
  return utf8(`${lines.join("\n")}\n\n${msg}`);
}

export function signature(name: string, email: string, when = new Date()): Signature {
  return { name, email, time: Math.floor(when.getTime() / 1000), tz: "+0000" };
}
