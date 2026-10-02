import { structuredPatch } from "diff";
import { describe, expect, it } from "vitest";
import { applyHunks, hunkId } from "../src/hunks";
import type { Hunk } from "../src/schemas";

function hunks(path: string, a: string, b: string): Hunk[] {
  return structuredPatch(path, path, a, b, "", "", { context: 0 }).hunks.map((h) => {
    const x = { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines };
    return { id: hunkId(path, x), ...x };
  });
}

const base = "one\ntwo\nthree\nfour\nfive\n";

describe("applyHunks", () => {
  it("reproduces a single fork exactly", () => {
    for (const next of [
      "one\nTWO\nthree\nfour\nfive\n",
      "zero\none\ntwo\nthree\nfour\nfive\n",
      "one\ntwo\nX\nY\nthree\nfour\nfive\n",
      "one\nfour\nfive\nsix\n",
      "",
    ]) {
      const r = applyHunks(base, hunks("f", base, next).map((hunk) => ({ agentId: "a", hunk })));
      expect(r.ok).toBe(true);
      expect(r.text).toBe(next);
    }
  });
  it("combines non-overlapping hunks from two agents", () => {
    const a = hunks("f", base, "ONE\ntwo\nthree\nfour\nfive\n").map((hunk) => ({ agentId: "a", hunk }));
    const b = hunks("f", base, "one\ntwo\nthree\nfour\nFIVE\n").map((hunk) => ({ agentId: "b", hunk }));
    const r = applyHunks(base, [...a, ...b]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });
  it("reports overlapping edits as conflicts", () => {
    const a = hunks("f", base, "one\nTWO\nthree\nfour\nfive\n").map((hunk) => ({ agentId: "a", hunk }));
    const b = hunks("f", base, "one\n2\nthree\nfour\nfive\n").map((hunk) => ({ agentId: "b", hunk }));
    const r = applyHunks(base, [...a, ...b]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });
  it("dedupes identical edits", () => {
    const a = hunks("f", base, "one\nTWO\nthree\nfour\nfive\n");
    const r = applyHunks(base, [...a.map((hunk) => ({ agentId: "a", hunk })), ...a.map((hunk) => ({ agentId: "b", hunk }))]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("one\nTWO\nthree\nfour\nfive\n");
  });
});
