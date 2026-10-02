import type { Hunk } from "./schemas";

/**
 * Line-level hunk model used for attribution and for assembling a merge from
 * hunks of several forks. Hunks are context-free (jsdiff `structuredPatch`
 * with `context: 0`), so a hunk's old range is exactly the base lines it
 * replaces. `oldStart` is 1-based (see `baseRange` for insertions).
 */

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Stable id derived from the hunk's position and content. */
export function hunkId(path: string, h: Omit<Hunk, "id">): string {
  let x = 0x811c9dc5;
  const s = `${path}\0${h.oldStart},${h.oldLines}\0${h.lines.join("\n")}`;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193);
  }
  return `h${(x >>> 0).toString(36)}`;
}

/**
 * The [start, end) range of base lines a hunk replaces, 0-based. Insertions
 * are empty ranges. jsdiff (v9) reports a pure insertion before 0-based line
 * `i` as `oldStart = i + 1`, unlike GNU diff's "after line N" — so the same
 * formula covers both cases. Locked by a unit test.
 */
export function baseRange(h: Hunk): [number, number] {
  const start = Math.max(0, h.oldStart - 1);
  return [start, start + h.oldLines];
}

function rangesConflict(a: Hunk, b: Hunk): boolean {
  const [as, ae] = baseRange(a);
  const [bs, be] = baseRange(b);
  if (as === ae && bs === be) return as === bs; // two insertions at the same point
  if (as === ae) return as > bs && as < be; // insertion strictly inside a replaced range
  if (bs === be) return bs > as && bs < ae;
  return as < be && bs < ae;
}

function sameEdit(a: Hunk, b: Hunk): boolean {
  return a.oldStart === b.oldStart && a.oldLines === b.oldLines && a.lines.join("\n") === b.lines.join("\n");
}

export interface TaggedHunk {
  agentId: string;
  hunk: Hunk;
}

export interface ApplyResult {
  ok: boolean;
  text: string;
  conflicts: { a: TaggedHunk; b: TaggedHunk }[];
}

/**
 * Apply hunks (possibly from different agents) to a base text. Identical
 * edits from different agents are de-duplicated; overlapping different edits
 * are reported as conflicts and the later one is skipped.
 */
export function applyHunks(base: string, hunks: TaggedHunk[]): ApplyResult {
  const lines = splitLines(base);
  const trailing = base === "" || base.endsWith("\n");
  const sorted = [...hunks].sort(
    (x, y) => baseRange(x.hunk)[0] - baseRange(y.hunk)[0] || x.hunk.oldLines - y.hunk.oldLines,
  );
  const accepted: TaggedHunk[] = [];
  const conflicts: ApplyResult["conflicts"] = [];
  for (const h of sorted) {
    const dup = accepted.find((a) => sameEdit(a.hunk, h.hunk));
    if (dup) continue;
    const clash = accepted.find((a) => rangesConflict(a.hunk, h.hunk));
    if (clash) {
      conflicts.push({ a: clash, b: h });
      continue;
    }
    accepted.push(h);
  }
  // Apply bottom-up so earlier offsets stay valid.
  const out = [...lines];
  for (const { hunk } of [...accepted].sort((x, y) => baseRange(y.hunk)[0] - baseRange(x.hunk)[0])) {
    const [start, end] = baseRange(hunk);
    const added = hunk.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    out.splice(start, end - start, ...added);
  }
  return { ok: conflicts.length === 0, text: joinLines(out, trailing), conflicts };
}

export function countChanges(hunks: Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
  return { additions, deletions };
}
