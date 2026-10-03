/**
 * Agent identity: stable colors, initials and fork names.
 *
 * Colors come from the Geist accent scale and read as markers on both the
 * light and dark canvases; each carries a text color for the initials drawn
 * on top. Every use in the UI pairs the color with the agent's initials and
 * name, so color is never the only signal.
 */

export interface AgentColor {
  name: string;
  /** Marker / border color, works on both themes. */
  hex: string;
  /** Text color to use on top of `hex`. */
  on: "#000000" | "#ffffff";
}

export const AGENT_COLORS: readonly AgentColor[] = [
  // Geist scale accents (see DESIGN.md → Forkyard application notes).
  { name: "blue", hex: "#0070f3", on: "#ffffff" },
  { name: "violet", hex: "#7928ca", on: "#ffffff" },
  { name: "pink", hex: "#ff0080", on: "#ffffff" },
  { name: "amber", hex: "#f5a623", on: "#000000" },
  { name: "teal", hex: "#29bc9b", on: "#000000" },
  { name: "red", hex: "#ee0000", on: "#ffffff" },
  { name: "green", hex: "#45a557", on: "#000000" },
  { name: "purple", hex: "#8e4ec6", on: "#ffffff" },
  { name: "cyan", hex: "#50e3c2", on: "#000000" },
  { name: "slate", hex: "#6e7c8c", on: "#ffffff" },
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
  // Numbered agents ("Agent 0901", "Worker 12"): the number tells them apart, not the word.
  const last = words.at(-1)!;
  if (/^\d+$/.test(last)) return last.slice(-2).padStart(2, "0");
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
