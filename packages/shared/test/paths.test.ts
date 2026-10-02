import { describe, expect, it } from "vitest";
import { detectOverlaps, matchesGlob, patternsOverlap } from "../src/paths";

describe("matchesGlob", () => {
  it("matches literals as files and directories", () => {
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/")).toBe(true);
    expect(matchesGlob("srcx/a.ts", "src")).toBe(false);
  });
  it("supports *, **, ? and braces", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/x/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/x/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("a.css", "*.{ts,css}")).toBe(true);
    expect(matchesGlob("ab.ts", "a?.ts")).toBe(true);
  });
});

describe("patternsOverlap", () => {
  it("is exact for literal vs glob", () => {
    expect(patternsOverlap("src/a.ts", "src/**")).toBe(true);
    expect(patternsOverlap("docs/a.md", "src/**")).toBe(false);
  });
  it("is conservative for glob vs glob", () => {
    expect(patternsOverlap("src/**/*.ts", "src/ui/**")).toBe(true);
    expect(patternsOverlap("src/**/*.ts", "src/**/*.css")).toBe(false);
    expect(patternsOverlap("docs/**", "src/**")).toBe(false);
  });
});

describe("detectOverlaps", () => {
  it("reports shared changed files once with all agents", () => {
    const o = detectOverlaps([
      { agentId: "a", claims: [], changed: ["src/app.ts", "README.md"] },
      { agentId: "b", claims: [], changed: ["src/app.ts"] },
      { agentId: "c", claims: [], changed: ["src/app.ts", "x.ts"] },
    ]);
    expect(o).toEqual([{ key: "change:src/app.ts", kind: "change", path: "src/app.ts", agents: ["a", "b", "c"] }]);
  });
  it("flags a change inside someone else's claim, and claim-vs-claim early", () => {
    const o = detectOverlaps([
      { agentId: "a", claims: ["src/ui/**"], changed: [] },
      { agentId: "b", claims: ["src/ui/button.tsx"], changed: ["src/ui/button.tsx"] },
      { agentId: "c", claims: ["docs/**"], changed: [] },
    ]);
    expect(o.map((x) => x.key)).toEqual(["change:src/ui/button.tsx"]);
  });
  it("keeps claim overlaps that have no concrete change yet", () => {
    const o = detectOverlaps([
      { agentId: "a", claims: ["src/**/*.ts"], changed: [] },
      { agentId: "b", claims: ["src/api/**"], changed: [] },
    ]);
    expect(o).toHaveLength(1);
    expect(o[0]!.kind).toBe("claim");
  });
});
