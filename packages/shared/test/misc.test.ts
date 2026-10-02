import { describe, expect, it } from "vitest";
import { forkName, initialsFor, parseForkName, parseIntentMarkdown, summarize, intentMarkdown, YardEvent } from "../src";

describe("naming", () => {
  it("round-trips fork names", () => {
    const n = forkName("demo", "dark-mode", "ada");
    expect(n).toBe("demo--dark-mode--ada");
    expect(parseForkName(n)).toEqual({ yardId: "demo", taskId: "dark-mode", agentId: "ada" });
    expect(parseForkName("demo--base")).toBeNull();
  });
  it("derives initials", () => {
    expect(initialsFor("Claude Opus")).toBe("CO");
    expect(initialsFor("ada")).toBe("AD");
  });
});

describe("intent markdown", () => {
  it("round-trips", () => {
    const md = intentMarkdown("Add dark mode", "Users asked for it", "Uses CSS vars");
    expect(parseIntentMarkdown(md)).toEqual({ summary: "Add dark mode", why: "Users asked for it", details: "Uses CSS vars" });
  });
});

describe("stats", () => {
  it("computes percentiles", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });
});

describe("events", () => {
  it("parses an envelope", () => {
    const e = YardEvent.parse({
      seq: 1, id: "x", yardId: "y", ts: new Date().toISOString(), taskId: null, agentId: "a",
      type: "claim.released", data: { patterns: ["src/**"] },
    });
    expect(e.type).toBe("claim.released");
  });
});
