import { makeObject, serializeCommit, serializeTree, signature, utf8, type Commit, type HashedObject, type TreeEntry } from "./objects";

/**
 * Build new tree and commit objects on top of an existing tree, reading only
 * the trees along changed paths. Unchanged subtrees are reused by hash, so a
 * merge that touches three files costs a handful of objects regardless of
 * repository size.
 */

export interface TreeReader {
  readTree(hash: string): Promise<TreeEntry[] | null>;
}

export type FileChange = { contents: Uint8Array; mode?: string } | null;

export interface BuiltCommit {
  commit: string;
  tree: string;
  objects: HashedObject[];
}

export async function buildTree(
  reader: TreeReader,
  baseTree: string | null,
  changes: Map<string, FileChange>,
  objects: HashedObject[],
): Promise<string> {
  const root = await buildSubtree(reader, baseTree, [...changes.entries()], objects);
  if (root) return root;
  const empty = makeObject("tree", serializeTree([]));
  objects.push(empty);
  return empty.hash;
}

async function buildSubtree(
  reader: TreeReader,
  treeHash: string | null,
  changes: [string, FileChange][],
  objects: HashedObject[],
): Promise<string | null> {
  const existing = treeHash ? ((await reader.readTree(treeHash)) ?? []) : [];
  const entries = new Map(existing.map((e) => [e.name, e]));
  const direct: [string, FileChange][] = [];
  const nested = new Map<string, [string, FileChange][]>();
  for (const [path, change] of changes) {
    const slash = path.indexOf("/");
    if (slash < 0) direct.push([path, change]);
    else {
      const dir = path.slice(0, slash);
      const list = nested.get(dir) ?? [];
      list.push([path.slice(slash + 1), change]);
      nested.set(dir, list);
    }
  }
  for (const [name, change] of direct) {
    if (change === null) {
      entries.delete(name);
      continue;
    }
    const blob = makeObject("blob", change.contents);
    objects.push(blob);
    const prev = entries.get(name);
    const mode = change.mode ?? (prev && prev.mode !== "40000" ? prev.mode : "100644");
    entries.set(name, { mode, name, hash: blob.hash });
  }
  for (const [dir, sub] of nested) {
    const prev = entries.get(dir);
    const subHash = await buildSubtree(reader, prev?.mode === "40000" ? prev.hash : null, sub, objects);
    if (subHash) entries.set(dir, { mode: "40000", name: dir, hash: subHash });
    else entries.delete(dir);
  }
  if (entries.size === 0) return null;
  const tree = makeObject("tree", serializeTree([...entries.values()]));
  objects.push(tree);
  return tree.hash;
}

export async function buildCommit(opts: {
  reader: TreeReader;
  baseTree: string | null;
  parents: string[];
  changes: Map<string, FileChange>;
  message: string;
  author?: { name: string; email: string };
  when?: Date;
}): Promise<BuiltCommit> {
  const objects: HashedObject[] = [];
  const tree = await buildTree(opts.reader, opts.baseTree, opts.changes, objects);
  const who = opts.author ?? { name: "Forkyard", email: "forkyard@users.noreply.forkyard.dev" };
  const sig = signature(who.name, who.email, opts.when);
  const commit: Commit = { tree, parents: opts.parents, author: sig, committer: sig, message: opts.message };
  const obj = makeObject("commit", serializeCommit(commit));
  objects.push(obj);
  // De-duplicate (two identical files produce the same blob).
  const seen = new Set<string>();
  const unique = objects.filter((o) => (seen.has(o.hash) ? false : (seen.add(o.hash), true)));
  return { commit: obj.hash, tree, objects: unique };
}

export function textFile(s: string): FileChange {
  return { contents: utf8(s) };
}
