import { describe, expect, it } from "vitest";
import { detectOverlaps, matchesGlob, normalizePattern, isGlob, patternsOverlap, type AgentFootprint, type DetectedOverlap } from "../src/paths";

/** The original pairwise implementation, kept as the reference the indexed one must match. */
function pairwise(footprints: AgentFootprint[]): DetectedOverlap[] {
  const byKey = new Map<string, DetectedOverlap>();
  const add = (kind: "claim" | "change", path: string, a: string, b: string) => {
    const key = `${kind}:${path}`;
    const cur = byKey.get(key);
    if (cur) {
      if (!cur.agents.includes(a)) cur.agents.push(a);
      if (!cur.agents.includes(b)) cur.agents.push(b);
    } else byKey.set(key, { key, kind, path, agents: [a, b] });
  };
  const shorter = (a: string, b: string) => {
    const na = normalizePattern(a);
    const nb = normalizePattern(b);
    if (!isGlob(na)) return na;
    if (!isGlob(nb)) return nb;
    return na.length !== nb.length ? (na.length < nb.length ? na : nb) : na < nb ? na : nb;
  };
  for (let i = 0; i < footprints.length; i++)
    for (let j = i + 1; j < footprints.length; j++) {
      const A = footprints[i]!;
      const B = footprints[j]!;
      const changedB = new Set(B.changed);
      for (const p of A.changed) if (changedB.has(p)) add("change", p, A.agentId, B.agentId);
      for (const p of A.changed) for (const c of B.claims) if (!changedB.has(p) && matchesGlob(p, c)) add("change", p, A.agentId, B.agentId);
      for (const p of B.changed) for (const c of A.claims) if (!A.changed.includes(p) && matchesGlob(p, c)) add("change", p, A.agentId, B.agentId);
      for (const ca of A.claims) for (const cb of B.claims) if (patternsOverlap(ca, cb)) add("claim", shorter(ca, cb), A.agentId, B.agentId);
    }
  const changes = [...byKey.values()].filter((o) => o.kind === "change");
  for (const o of [...byKey.values()])
    if (o.kind === "claim" && changes.some((c) => matchesGlob(c.path, o.path) && o.agents.every((a) => c.agents.includes(a)))) byKey.delete(o.key);
  for (const o of byKey.values()) o.agents.sort();
  return [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const PATHS = ["README.md", "src/index.ts", "src/a.ts", "src/b.ts", "src/lib/x.ts", "src/lib/y.ts", "docs/api.md", "test/a.test.ts", "package.json"];
const CLAIMS = ["src/**", "src/lib/**", "docs/*.md", "README.md", "test/**", "src/a.ts", "**/*.md", "src/*.ts"];

describe("detectOverlaps at swarm scale", () => {
  it("matches the pairwise reference on random footprints", () => {
    const r = rng(7);
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(r() * 6);
      const fps: AgentFootprint[] = Array.from({ length: n }, (_, i) => ({
        agentId: `a${i}`,
        changed: PATHS.filter(() => r() < 0.25),
        claims: CLAIMS.filter(() => r() < 0.15),
      }));
      expect(detectOverlaps(fps)).toEqual(pairwise(fps));
    }
  });

  it("handles a thousand agents on one task quickly", () => {
    const r = rng(42);
    const files = Array.from({ length: 400 }, (_, i) => `src/mod-${String(i).padStart(3, "0")}.ts`);
    const fps: AgentFootprint[] = Array.from({ length: 1000 }, (_, i) => ({
      agentId: `agent-${i}`,
      changed: ["README.md", files[Math.floor(r() * files.length)]!, files[Math.floor(r() * files.length)]!],
      claims: i % 10 === 0 ? [`src/mod-${String(i % 400).padStart(3, "0")}.ts`] : [],
    }));
    const t0 = performance.now();
    const out = detectOverlaps(fps);
    const ms = performance.now() - t0;
    expect(out.find((o) => o.key === "change:README.md")?.agents.length).toBe(1000);
    expect(ms).toBeLessThan(500);
  });
});
