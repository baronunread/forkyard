import { countChanges, hunkId, type ChangedFile, type FileStatus, type Hunk } from "@forkyard/shared";
import { structuredPatch } from "diff";
import { blobText, type Repo } from "./artifacts";

/**
 * Fork-vs-base diffs computed straight from Artifacts objects.
 *
 * The tree walk compares entries by hash, so identical subtrees are skipped
 * without reading them: diffing a three-file change in a 10k-file repo costs
 * a few `readTree` calls, not a checkout.
 */

export const MAX_FILES = 500;
export const MAX_TEXT_BYTES = 1_000_000;
export const IGNORED_PREFIXES = [".forkyard/"];

interface RawChange {
  path: string;
  status: FileStatus;
  oldHash: string | null;
  newHash: string | null;
  /** The new entry's mode ("100755", "120000" for a symlink…); absent for deletions. */
  mode?: string;
}

export async function commitTree(repo: Repo, commit: string): Promise<string> {
  const c = await repo.readCommit(commit);
  if (!c) throw new Error(`commit ${commit} not found`);
  return c.treeHash;
}

export async function treeChanges(repo: Repo, oldTree: string | null, newTree: string | null, prefix = ""): Promise<RawChange[]> {
  if (oldTree === newTree) return [];
  const [a, b] = await Promise.all([
    oldTree ? repo.readTree(oldTree) : Promise.resolve([]),
    newTree ? repo.readTree(newTree) : Promise.resolve([]),
  ]);
  const left = new Map((a ?? []).map((e) => [e.name, e]));
  const right = new Map((b ?? []).map((e) => [e.name, e]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const out: RawChange[] = [];
  const nested: Promise<RawChange[]>[] = [];
  for (const name of names) {
    const l = left.get(name);
    const r = right.get(name);
    if (l && r && l.hash === r.hash && l.mode === r.mode) continue;
    const path = prefix + name;
    const lTree = l?.type === "tree";
    const rTree = r?.type === "tree";
    if (lTree || rTree) {
      nested.push(treeChanges(repo, lTree ? l!.hash : null, rTree ? r!.hash : null, `${path}/`));
    }
    const lFile = l && !lTree && l.type !== "gitlink";
    const rFile = r && !rTree && r.type !== "gitlink";
    if (lFile && rFile) out.push({ path, status: "modified", oldHash: l!.hash, newHash: r!.hash, mode: r!.mode });
    else if (lFile) out.push({ path, status: "deleted", oldHash: l!.hash, newHash: null });
    else if (rFile) out.push({ path, status: "added", oldHash: null, newHash: r!.hash, mode: r!.mode });
  }
  for (const n of await Promise.all(nested)) out.push(...n);
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export async function readText(repo: Repo, hash: string | null): Promise<{ text: string | null; binary: boolean }> {
  if (!hash) return { text: "", binary: false };
  const blob = await repo.readBlob(hash);
  if (blob && blob.size > MAX_TEXT_BYTES) return { text: null, binary: true };
  const r = await blobText(blob);
  return { text: r.text, binary: r.binary };
}

export function computeHunks(path: string, oldText: string, newText: string): Hunk[] {
  const patch = structuredPatch(path, path, oldText, newText, "", "", { context: 0 });
  return patch.hunks.map((h) => {
    const lines = h.lines.filter((l) => !l.startsWith("\\"));
    const x = { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
    return { id: hunkId(path, x), ...x };
  });
}

/**
 * Full fork diff: changed files with line stats. `repo` must contain both
 * commits (a fork contains its base's objects).
 */
export async function forkDiff(repo: Repo, baseCommit: string, headCommit: string): Promise<ChangedFile[]> {
  const [baseTree, headTree] = await Promise.all([commitTree(repo, baseCommit), commitTree(repo, headCommit)]);
  const raw = (await treeChanges(repo, baseTree, headTree)).filter((c) => !IGNORED_PREFIXES.some((p) => c.path.startsWith(p)));
  const limited = raw.slice(0, MAX_FILES);
  const files = await mapLimit(limited, 8, async (c): Promise<ChangedFile> => {
    const [o, n] = await Promise.all([readText(repo, c.oldHash), readText(repo, c.newHash)]);
    if (o.binary || n.binary || o.text === null || n.text === null) {
      return { ...c, additions: 0, deletions: 0, binary: true };
    }
    const { additions, deletions } = countChanges(computeHunks(c.path, o.text, n.text));
    return { ...c, additions, deletions, binary: false };
  });
  return files;
}

export async function readPathAt(repo: Repo, commit: string, path: string): Promise<{ text: string | null; binary: boolean; exists: boolean }> {
  const blob = await repo.readFile({ ref: commit, path });
  if (!blob) return { text: null, binary: false, exists: false };
  if (blob.size > MAX_TEXT_BYTES) return { text: null, binary: true, exists: true };
  const r = await blobText(blob);
  return { text: r.text, binary: r.binary, exists: true };
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
