/**
 * Agent identity: stable colors, initials and fork names.
 *
 * Colors are mid-lightness so they read as markers on both the light and dark
 * Kumo canvases (contrast ≥ 3:1 against white and against #111), and every use
 * in the UI pairs them with the agent's initials, so color is never the only
 * signal.
 */

export interface AgentColor {
  name: string;
  /** Marker / border color, works on both themes. */
  hex: string;
  /** Text color to use on top of `hex`. */
  on: "#000000" | "#ffffff";
}

export const AGENT_COLORS: readonly AgentColor[] = [
  { name: "blue", hex: "#3b82f6", on: "#000000" },
  { name: "orange", hex: "#f97316", on: "#000000" },
  { name: "violet", hex: "#a855f7", on: "#000000" },
  { name: "teal", hex: "#14b8a6", on: "#000000" },
  { name: "pink", hex: "#ec4899", on: "#000000" },
  { name: "lime", hex: "#84cc16", on: "#000000" },
  { name: "amber", hex: "#eab308", on: "#000000" },
  { name: "cyan", hex: "#06b6d4", on: "#000000" },
  { name: "red", hex: "#ef4444", on: "#000000" },
  { name: "indigo", hex: "#818cf8", on: "#000000" },
];

/** Pick the first color not used by `taken`, falling back to a stable hash of the name. */
export function pickAgentColor(name: string, taken: Iterable<string> = []): AgentColor {
  const used = new Set(taken);
  const free = AGENT_COLORS.find((c) => !used.has(c.hex));
  if (free) return free;
  return AGENT_COLORS[hashString(name) % AGENT_COLORS.length]!;
}

export function colorByHex(hex: string): AgentColor {
  return AGENT_COLORS.find((c) => c.hex === hex) ?? { name: "custom", hex, on: "#000000" };
}

export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function slugify(s: string, max = 32): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");
  return slug.length >= 2 ? slug : `x-${slug || "0"}`;
}

export const FORK_SEPARATOR = "--";

/** `<yard>--<task>--<agent>` — predictable, parseable, and valid as an Artifacts repo name. */
export function forkName(yardId: string, taskId: string, agentId: string): string {
  return [yardId, taskId, agentId].join(FORK_SEPARATOR);
}

export function parseForkName(name: string): { yardId: string; taskId: string; agentId: string } | null {
  const parts = name.split(FORK_SEPARATOR);
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { yardId: parts[0]!, taskId: parts[1]!, agentId: parts[2]! };
}

export function baseRepoName(yardId: string): string {
  return `${yardId}${FORK_SEPARATOR}base`;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
