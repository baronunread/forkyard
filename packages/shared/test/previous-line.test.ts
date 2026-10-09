import { structuredPatch } from "diff";
import { describe, expect, it } from "vitest";
import { previousLine } from "../src/hunks";
import type { Hunk } from "../src/schemas";

const hunks = (a: string, b: string): Hunk[] =>
  structuredPatch("f", "f", a, b, "", "", { context: 0 }).hunks.map((h) => ({ id: "", oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines }));

describe("previousLine", () => {
  it("follows every line of a new version back to the old one, or says it was added", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "new\na\nc\nX\nY\ne\nend\n"; // insert at top, delete b, replace d with X Y, append
    const h = hunks(before, after);
    expect([0, 1, 2, 3, 4, 5, 6].map((q) => previousLine(h, q))).toEqual(["added", 0, 2, "added", "added", 4, "added"]);
  });
});
