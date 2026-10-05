import { Inflate, deflate } from "pako";
import { concat, fromHex, hashObject, sha1, toHex, utf8, type GitObject, type HashedObject, type ObjectType } from "./objects";

/**
 * Packfile v2 reader and writer (https://git-scm.com/docs/pack-format).
 * The writer emits undeltified objects, which every Git server accepts. The
 * reader resolves OFS_DELTA and REF_DELTA, which real `git push` produces.
 */

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export function writePack(objects: GitObject[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(utf8("PACK"), 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const o of objects) {
    parts.push(encodeObjectHeader(TYPE_CODES[o.type], o.data.length));
    parts.push(deflate(o.data));
  }
  const body = concat(parts);
  return concat([body, fromHex(sha1(body))]);
}

function encodeObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return new Uint8Array(bytes);
}

interface RawEntry {
  offset: number;
  type: number;
  data: Uint8Array;
  baseOffset?: number;
  baseHash?: string;
}

/**
 * Parse a packfile. `lookup` resolves REF_DELTA bases that are not in the
 * pack (thin packs); it may return undefined if the base is unknown.
 */
export function readPack(pack: Uint8Array, lookup?: (hash: string) => GitObject | undefined): HashedObject[] {
  if (pack.length < 32 || String.fromCharCode(...pack.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = dv.getUint32(8);
  const expected = toHex(pack.subarray(pack.length - 20));
  if (sha1(pack.subarray(0, pack.length - 20)) !== expected) throw new Error("pack checksum mismatch");

  const raw: RawEntry[] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const offset = i;
    let c = pack[i++]!;
    const type = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = pack[i++]!;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { offset, type, data: new Uint8Array() };
    if (type === OFS_DELTA) {
      c = pack[i++]!;
      let off = c & 0x7f;
      while (c & 0x80) {
        c = pack[i++]!;
        off = (off + 1) * 128 + (c & 0x7f);
      }
      entry.baseOffset = offset - off;
    } else if (type === REF_DELTA) {
      entry.baseHash = toHex(pack.subarray(i, i + 20));
      i += 20;
    }
    const inf = new Inflate();
    inf.push(pack.subarray(i), true);
    if (inf.err) throw new Error(`inflate failed at ${offset}: ${inf.msg}`);
    const data = inf.result as Uint8Array;
    if (data.length !== size) throw new Error(`object at ${offset}: size ${data.length} != ${size}`);
    entry.data = data;
    // pako exposes how much input the zlib stream consumed; the next object starts right after.
    i += (inf as unknown as { strm: { next_in: number } }).strm.next_in;
    raw.push(entry);
  }

  const byOffset = new Map<number, RawEntry>();
  for (const e of raw) byOffset.set(e.offset, e);
  const resolved = new Map<number, HashedObject>();
  const byHash = new Map<string, HashedObject>();

  const resolve = (e: RawEntry, depth = 0): HashedObject => {
    const done = resolved.get(e.offset);
    if (done) return done;
    if (depth > 4096) throw new Error("delta chain too deep");
    let out: HashedObject;
    if (e.type === OFS_DELTA || e.type === REF_DELTA) {
      let base: GitObject | undefined;
      if (e.type === OFS_DELTA) {
        const b = byOffset.get(e.baseOffset!);
        if (!b) throw new Error(`missing ofs-delta base at ${e.baseOffset}`);
        base = resolve(b, depth + 1);
      } else {
        base = byHash.get(e.baseHash!);
        if (!base) {
          // The base may be a later entry in the pack.
          for (const cand of raw) {
            if (resolved.has(cand.offset) || cand === e) continue;
            if (cand.type !== OFS_DELTA && cand.type !== REF_DELTA) {
              const h = resolve(cand, depth + 1);
              if (h.hash === e.baseHash) {
                base = h;
                break;
              }
            }
          }
        }
        base ??= lookup?.(e.baseHash!);
        if (!base) throw new Error(`missing ref-delta base ${e.baseHash}`);
      }
      const data = applyDelta(base.data, e.data);
      out = { type: base.type, data, hash: hashObject(base.type, data) };
    } else {
      const type = CODE_TYPES[e.type];
      if (!type) throw new Error(`unknown object type ${e.type}`);
      out = { type, data: e.data, hash: hashObject(type, e.data) };
    }
    resolved.set(e.offset, out);
    byHash.set(out.hash, out);
    return out;
  };

  return raw.map((e) => resolve(e));
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    let c: number;
    do {
      c = delta[i++]!;
      r += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return r;
  };
  const srcSize = varint();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const dstSize = varint();
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off |= delta[i++]!;
      if (op & 0x02) off |= delta[i++]! << 8;
      if (op & 0x04) off |= delta[i++]! << 16;
      if (op & 0x08) off += delta[i++]! * 2 ** 24;
      if (op & 0x10) size |= delta[i++]!;
      if (op & 0x20) size |= delta[i++]! << 8;
      if (op & 0x40) size |= delta[i++]! << 16;
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      out.set(delta.subarray(i, i + op), o);
      o += op;
      i += op;
    } else {
      throw new Error("invalid delta opcode 0");
    }
  }
  if (o !== dstSize) throw new Error("delta result size mismatch");
  return out;
}
