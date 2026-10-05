import { colorByHex } from "@forkyard/shared";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTheme } from "../lib/theme";
import type { AgentLike } from "./AgentChip";

export interface TreeFile {
  path: string;
  agents: { agentId: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number }[];
  overlap: boolean;
}

/**
 * Union of files touched across all forks. Each row carries the initials of
 * every agent that touched it (in that agent's color) and a ⚠ when more than
 * one agent did — the task's conflict map at a glance.
 */
export function FileTreePane({
  files,
  agents,
  selected,
  onSelect,
}: {
  files: TreeFile[];
  agents: AgentLike[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { mode } = useTheme();
  return <TreeInner key={mode} mode={mode} files={files} agents={agents} selected={selected} onSelect={onSelect} />;
}

function TreeInner({
  mode,
  files,
  agents,
  selected,
  onSelect,
}: {
  mode: "light" | "dark";
  files: TreeFile[];
  agents: AgentLike[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  // The tree calls back into these outside React's render; keep them current from a layout
  // effect, which runs before the effect below hands the tree its new paths.
  const lookup = useMemo(() => ({ files: new Map(files.map((f) => [f.path, f])), agents: new Map(agents.map((a) => [a.id, a])) }), [files, agents]);
  const data = useRef(lookup);
  const onSelectRef = useRef(onSelect);
  useLayoutEffect(() => {
    data.current = lookup;
    onSelectRef.current = onSelect;
  });
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.map((f) => {
        const statuses = new Set(f.agents.map((a) => a.status));
        return { path: f.path, status: statuses.size === 1 ? [...statuses][0]! : "modified" };
      }),
    [files],
  );

  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    gitStatus,
    density: "compact",
    unsafeCSS: `:host, :host * { color-scheme: ${mode} !important; }`,
    onSelectionChange: (sel) => {
      const p = sel[0];
      if (p && data.current.files.has(p)) onSelectRef.current(p);
    },
    renderRowDecoration: ({ item }) => {
      const f = data.current.files.get(item.path);
      if (!f) return null;
      // Up to three agents by initials; past that, a count (a hot file in a swarm has hundreds).
      const parts =
        f.agents.length <= 3
          ? f.agents.map((a, i) => {
              const ag = data.current.agents.get(a.agentId);
              return { text: `${i ? "\u00a0" : ""}${ag?.initials ?? "?"}`, color: ag ? colorByHex(ag.color).hex : undefined };
            })
          : [{ text: `×${f.agents.length}`, color: undefined as string | undefined }];
      if (f.overlap) parts.push({ text: "\u00a0⚠", color: "var(--color-overlap)" });
      const all = f.agents.map((a) => data.current.agents.get(a.agentId)?.name ?? a.agentId);
      const names = all.length > 12 ? `${all.slice(0, 12).join(", ")} and ${all.length - 12} more` : all.join(", ");
      return { text: parts.map((p) => p.text).join(""), parts, title: f.overlap ? `Overlap: touched by ${names}` : `Touched by ${names}` };
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  useEffect(() => {
    if (selected && paths.includes(selected)) {
      model.focusPath(selected);
      model.scrollToPath(selected, { focus: false });
    }
  }, [model, selected, paths]);

  return (
    <FileTree
      model={model}
      style={
        {
          height: "100%",
          "--trees-bg-override": "var(--color-surface)",
          "--trees-fg-override": "var(--color-fg)",
          "--trees-fg-muted-override": "var(--color-muted)",
          "--trees-selected-bg-override": "var(--color-selected)",
          "--trees-border-color-override": "var(--color-line)",
          "--trees-search-bg-override": "var(--color-surface-2)",
          "--trees-search-fg-override": "var(--color-fg)",
          "--trees-font-family-override": "var(--font-sans)",
          "--trees-font-size-override": "13px",
        } as React.CSSProperties
      }
    />
  );
}
