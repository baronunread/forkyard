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
 * Pairwise overlap detection across agents on one task.
 *
 * - `change`: two agents changed the same file, or one changed a file the
 *   other claimed. These are the conflicts that will bite at merge time.
 * - `claim`: two agents claimed intersecting patterns but nobody has
 *   changed a shared file yet. An early warning.
 *
 * Results are grouped per path, so three agents on the same file produce one
 * overlap with three agents.
 */
export function detectOverlaps(footprints: AgentFootprint[]): DetectedOverlap[] {
  const byKey = new Map<string, DetectedOverlap>();
  const add = (kind: "claim" | "change", path: string, a: string, b: string) => {
    const key = `${kind}:${path}`;
    const cur = byKey.get(key);
    if (cur) {
      if (!cur.agents.includes(a)) cur.agents.push(a);
      if (!cur.agents.includes(b)) cur.agents.push(b);
    } else {
      byKey.set(key, { key, kind, path, agents: [a, b] });
    }
  };

  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const A = footprints[i]!;
      const B = footprints[j]!;
      const changedB = new Set(B.changed);
      for (const p of A.changed) if (changedB.has(p)) add("change", p, A.agentId, B.agentId);
      for (const p of A.changed)
        for (const c of B.claims) if (!changedB.has(p) && matchesGlob(p, c)) add("change", p, A.agentId, B.agentId);
      for (const p of B.changed)
        for (const c of A.claims)
          if (!A.changed.includes(p) && matchesGlob(p, c)) add("change", p, A.agentId, B.agentId);
      for (const ca of A.claims)
        for (const cb of B.claims) if (patternsOverlap(ca, cb)) add("claim", shorter(ca, cb), A.agentId, B.agentId);
    }
  }

  // A claim overlap whose area is already covered by a concrete change overlap is noise.
  const changes = [...byKey.values()].filter((o) => o.kind === "change");
  for (const o of [...byKey.values()]) {
    if (o.kind !== "claim") continue;
    const covered = changes.some(
      (c) => matchesGlob(c.path, o.path) && o.agents.every((a) => c.agents.includes(a)),
    );
    if (covered) byKey.delete(o.key);
  }
  for (const o of byKey.values()) o.agents.sort();
  return [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));
}

function shorter(a: string, b: string): string {
  const na = normalizePattern(a);
  const nb = normalizePattern(b);
  if (!isGlob(na)) return na;
  if (!isGlob(nb)) return nb;
  return na.length <= nb.length ? na : nb;
}
