import type { Agent, Yard } from "@forkyard/shared";
import { disposeRepo, getArtifacts, treeReader } from "./artifacts";
import { commitTree, treeChanges } from "./diff";
import type { Env } from "./env";
import { buildCommit, type FileChange } from "./git/build";

/**
 * Preview branches for Workers Builds.
 *
 * Workers Builds connects one Artifacts repo — the yard's base — and builds a
 * Preview for every non-production branch. Agents work in separate fork
 * repos, so after each push Forkyard mirrors the fork's tree onto
 * `fy/<task>/<agent>` in the base repo. The mirror is a synthetic commit
 * whose parent is the previous mirror (always a fast-forward), so agents
 * never need write access to the base repo.
 */

export function previewBranch(taskId: string, agentId: string): string {
  return `fy/${taskId}/${agentId}`;
}

/** Workers Builds slugs branch names into the preview hostname. */
export function previewBranchSlug(taskId: string, agentId: string): string {
  return previewBranch(taskId, agentId).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

export async function mirrorPreviewBranch(env: Env, yard: Yard, agent: Agent, baseCommit: string, headCommit: string): Promise<{ branch: string; commit: string } | null> {
  const artifacts = getArtifacts(env, yard.jurisdiction);
  const [base, fork] = await Promise.all([artifacts.get(yard.baseRepo), artifacts.get(agent.forkName)]);
  try {
    const ref = `refs/heads/${previewBranch(agent.taskId, agent.id)}`;
    const branchName = previewBranch(agent.taskId, agent.id);
    const [previous] = await base.log({ ref: branchName, limit: 1 });
    const baseTree = await commitTree(fork, baseCommit);
    const headTree = await commitTree(fork, headCommit);
    if (previous?.treeHash === headTree) return { branch: branchName, commit: previous.hash };
    const changed = await treeChanges(fork, baseTree, headTree);
    const changes = new Map<string, FileChange>();
    for (const c of changed) {
      if (c.status === "deleted") changes.set(c.path, null);
      else {
        const blob = await fork.readBlob(c.newHash!);
        if (!blob) throw new Error(`blob ${c.newHash} missing in ${agent.forkName}`);
        changes.set(c.path, { contents: new Uint8Array(await blob.arrayBuffer()) });
      }
    }
    // Build on the *task base* tree (present in the base repo), so the mirror tree equals the fork's tree.
    const built = await buildCommit({
      reader: treeReader(base),
      baseTree,
      parents: [previous?.hash ?? baseCommit],
      changes,
      message: `Preview of ${agent.name} @ ${headCommit.slice(0, 7)}\n\nMirrored by Forkyard from ${agent.forkName}.`,
      author: { name: "Forkyard", email: "previews@forkyard.dev" },
    });
    await artifacts.writeCommit(yard.baseRepo, built, ref, previous?.hash ?? null);
    return { branch: branchName, commit: built.commit };
  } finally {
    disposeRepo(base);
    disposeRepo(fork);
  }
}

export async function deletePreviewBranch(env: Env, yard: Yard, taskId: string, agentId: string): Promise<void> {
  const artifacts = getArtifacts(env, yard.jurisdiction);
  const base = await artifacts.get(yard.baseRepo);
  try {
    const [cur] = await base.log({ ref: previewBranch(taskId, agentId), limit: 1 });
    if (!cur) return;
    await artifacts.deleteRef(yard.baseRepo, `refs/heads/${previewBranch(taskId, agentId)}`, cur.hash);
  } finally {
    disposeRepo(base);
  }
}
