import { concat, fromUtf8, utf8 } from "./objects";

/** Git pkt-line framing (https://git-scm.com/docs/protocol-common#_pkt_line_format). */

export const FLUSH = utf8("0000");

export function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line === "string" ? utf8(line) : line;
  const len = (body.length + 4).toString(16).padStart(4, "0");
  return concat([utf8(len), body]);
}

export type PktItem = { kind: "data"; data: Uint8Array } | { kind: "flush" } | { kind: "delim" };

/**
 * Read pkt-lines until the first flush (or `untilFlushes` flushes). Returns
 * the items and the offset where reading stopped, so callers can pick up the
 * raw packfile that follows the command list in a receive-pack request.
 */
export function readPkts(buf: Uint8Array, start = 0, untilFlushes = 1): { items: PktItem[]; offset: number } {
  const items: PktItem[] = [];
  let i = start;
  let flushes = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(fromUtf8(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) throw new Error("malformed pkt-line");
    if (len === 0) {
      items.push({ kind: "flush" });
      i += 4;
      if (++flushes >= untilFlushes) break;
      continue;
    }
    if (len === 1) {
      items.push({ kind: "delim" });
      i += 4;
      continue;
    }
    items.push({ kind: "data", data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { items, offset: i };
}

export function pktText(item: PktItem): string | null {
  if (item.kind !== "data") return null;
  const s = fromUtf8(item.data);
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
