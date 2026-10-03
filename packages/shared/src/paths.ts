/**
 * Path claims and overlap detection.
 *
 * Supported glob syntax: `*` (within a segment), `**` (any depth), `?`, and
 * `{a,b}` alternation. A trailing `/` means "everything below".
 */

export function normalizePattern(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (s.endsWith("/")) s += "**";
  return s;
}

export function isGlob(p: string): boolean {
  return /[*?{]/.test(p);
}

const reCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const p = normalizePattern(pattern);
  const cached = reCache.get(p);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = p
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
    }
  }
  const out = new RegExp(`^${re}$`);
  reCache.set(p, out);
  return out;
}

export function matchesGlob(path: string, pattern: string): boolean {
  const p = normalizePattern(pattern);
  if (!isGlob(p)) return path === p || path.startsWith(`${p}/`);
  return globToRegExp(p).test(path);
}

/** The literal directory prefix of a pattern, up to the first wildcard segment. */
export function staticPrefix(pattern: string): string {
  const p = normalizePattern(pattern);
  if (!isGlob(p)) return p;
  const segs = p.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (isGlob(s)) break;
    out.push(s);
  }
  return out.join("/");
}

/**
 * Could two patterns match a common path? Exact for literal-vs-anything;
 * conservative for glob-vs-glob (compares static prefixes, so it may report
 * an overlap that a full intersection would rule out — the safe direction).
 */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = normalizePattern(a);
  const pb = normalizePattern(b);
  const ga = isGlob(pa);
  const gb = isGlob(pb);
  if (!ga && !gb) return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
  if (!ga) return matchesGlob(pa, pb);
  if (!gb) return matchesGlob(pb, pa);
  const xa = staticPrefix(pa);
  const xb = staticPrefix(pb);
  if (xa === "" || xb === "") {
    // e.g. `**/*.ts` vs `src/**/*.css`: fall back to comparing the last segments' extensions.
    return extensionsCompatible(pa, pb);
  }
  const prefixRelated = xa === xb || xa.startsWith(`${xb}/`) || xb.startsWith(`${xa}/`);
  return prefixRelated && extensionsCompatible(pa, pb);
}

function extensionsCompatible(a: string, b: string): boolean {
  const ea = literalExtension(a);
  const eb = literalExtension(b);
  return ea === null || eb === null || ea === eb;
}

function literalExtension(p: string): string | null {
  const last = p.split("/").pop() ?? "";
  const m = /\.([A-Za-z0-9]+)$/.exec(last);
  if (!m || /[{}]/.test(last)) return null;
  return m[1]!.toLowerCase();
}

export interface AgentFootprint {
  agentId: string;
  /** Claimed patterns (may be globs). */
  claims: string[];
  /** Paths actually changed in the agent's fork. */
  changed: string[];
}

export interface DetectedOverlap {
  key: string;
  kind: "claim" | "change";
  path: string;
  agents: string[];
}

/**
 * Overlap detection across agents on one task.
 *
 * - `change`: two agents changed the same file, or one changed a file the
 *   other claimed. These are the conflicts that will bite at merge time.
 * - `claim`: two agents claimed intersecting patterns but nobody has
 *   changed a shared file yet. An early warning.
 *
 * Results are grouped per path, so three agents on the same file produce one
 * overlap with three agents.
 *
 * Built for swarms: instead of comparing every pair of agents (O(agents²) on
 * every push), it indexes path → agents and pattern → agents, so the cost
 * follows the number of distinct paths and patterns touched, not the number
 * of agents. A thousand agents on one task recompute in milliseconds.
 */
export function detectOverlaps(footprints: AgentFootprint[]): DetectedOverlap[] {
  const byKey = new Map<string, { key: string; kind: "claim" | "change"; path: string; agents: Set<string> }>();
  const add = (kind: "claim" | "change", path: string, agents: Iterable<string>) => {
    const key = `${kind}:${path}`;
    let cur = byKey.get(key);
    if (!cur) byKey.set(key, (cur = { key, kind, path, agents: new Set() }));
    for (const a of agents) cur.agents.add(a);
  };

  // path → agents that changed it; normalized pattern → agents that claimed it.
  const changedBy = new Map<string, Set<string>>();
  const claimedBy = new Map<string, Set<string>>();
  for (const fp of footprints) {
    for (const p of fp.changed) {
      let s = changedBy.get(p);
      if (!s) changedBy.set(p, (s = new Set()));
      s.add(fp.agentId);
    }
    for (const raw of fp.claims) {
      const c = normalizePattern(raw);
      if (!c) continue;
      let s = claimedBy.get(c);
      if (!s) claimedBy.set(c, (s = new Set()));
      s.add(fp.agentId);
    }
  }

  // change × change: the same file changed by two or more agents.
  for (const [p, agents] of changedBy) if (agents.size >= 2) add("change", p, agents);

  // change × claim: a changed file inside someone else's claim (who hasn't changed it).
  const literalClaims = new Map<string, Set<string>>();
  const globClaims: [string, Set<string>][] = [];
  for (const [c, agents] of claimedBy) (isGlob(c) ? globClaims.push([c, agents]) : literalClaims.set(c, agents));
  for (const [p, changers] of changedBy) {
    const claimers = new Set<string>();
    const lit = literalClaims.get(p);
    if (lit) for (const a of lit) claimers.add(a);
    for (const [c, agents] of globClaims) if (matchesGlob(p, c)) for (const a of agents) claimers.add(a);
    const others = [...claimers].filter((a) => !changers.has(a));
    if (others.length) add("change", p, [...changers, ...others]);
  }

  // claim × claim: intersecting patterns from different agents. Patterns are bucketed by
  // their first literal segment so unrelated areas of the tree are never compared.
  const buckets = new Map<string, string[]>();
  const anywhere: string[] = [];
  for (const c of claimedBy.keys()) {
    const head = c.split("/")[0]!;
    if (isGlob(head)) anywhere.push(c);
    else {
      let b = buckets.get(head);
      if (!b) buckets.set(head, (b = []));
      b.push(c);
    }
  }
  const claimPair = (ca: string, cb: string) => {
    const A = claimedBy.get(ca)!;
    const B = claimedBy.get(cb)!;
    if (ca === cb) {
      if (A.size >= 2) add("claim", ca, A);
      return;
    }
    // Needs two different agents across the pair.
    if (A.size === 1 && B.size === 1 && [...A][0] === [...B][0]) return;
    if (patternsOverlap(ca, cb)) add("claim", shorter(ca, cb), [...A, ...B]);
  };
  const groups = [...buckets.values()];
  for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i; j < g.length; j++) claimPair(g[i]!, g[j]!);
  for (let i = 0; i < anywhere.length; i++) {
    for (let j = i; j < anywhere.length; j++) claimPair(anywhere[i]!, anywhere[j]!);
    for (const g of groups) for (const c of g) claimPair(anywhere[i]!, c);
  }

  // A claim overlap whose area is already covered by a concrete change overlap is noise.
  const changes = [...byKey.values()].filter((o) => o.kind === "change");
  for (const o of [...byKey.values()]) {
    if (o.kind !== "claim") continue;
    const covered = changes.some((c) => matchesGlob(c.path, o.path) && [...o.agents].every((a) => c.agents.has(a)));
    if (covered) byKey.delete(o.key);
  }
  return [...byKey.values()]
    .map((o) => ({ key: o.key, kind: o.kind, path: o.path, agents: [...o.agents].sort() }))
    .sort((x, y) => x.key.localeCompare(y.key));
}

function shorter(a: string, b: string): string {
  const na = normalizePattern(a);
  const nb = normalizePattern(b);
  if (!isGlob(na)) return na;
  if (!isGlob(nb)) return nb;
  // Deterministic regardless of argument order: shorter, then alphabetical.
  return na.length !== nb.length ? (na.length < nb.length ? na : nb) : na < nb ? na : nb;
}
