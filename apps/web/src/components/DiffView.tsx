import type { Hunk } from "@forkyard/shared";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "../lib/theme";
import { AgentBadge, type AgentLike } from "./AgentChip";

export type DiffStyle = "split" | "unified";

interface HunkMeta {
  hunkId: string;
  agent: AgentLike;
  index: number;
  total: number;
  note: string | null;
}

/**
 * One file's diff against base, rendered with @pierre/diffs (syntax and
 * word-level highlights, split/unified, collapsed unchanged regions). Every
 * hunk gets an annotation attributing it to its agent and linking it to the
 * intent that explains it; `data-hunk` anchors drive j/k navigation.
 */
export function FileDiff({
  path,
  base,
  next,
  hunks,
  agent,
  intent,
  diffStyle,
  wrap,
  header,
  renderHunkExtra,
}: {
  path: string;
  base: string | null;
  next: string | null;
  hunks: Hunk[];
  agent: AgentLike;
  intent?: string | null;
  diffStyle: DiffStyle;
  wrap: boolean;
  header?: ReactNode;
  renderHunkExtra?: (hunk: Hunk) => ReactNode;
}) {
  const { mode } = useTheme();
  if (base === null && next === null) return null;
  const annotations: DiffLineAnnotation<HunkMeta>[] = hunks.map((h, i) => {
    // Annotations render below their line, so anchor on the line just before the hunk
    // (0 = above the first line) to put the attribution banner on top of the hunk.
    const adds = h.lines.some((l) => l.startsWith("+"));
    return {
      side: adds ? "additions" : "deletions",
      lineNumber: Math.max(0, (adds ? h.newStart : h.oldStart) - 1),
      metadata: { hunkId: h.id, agent, index: i + 1, total: hunks.length, note: intent ?? null },
    };
  });
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const oldFile = base === null ? null : { name: path, contents: base, cacheKey: `base:${path}:${hash(base)}` };
  const newFile = next === null ? null : { name: path, contents: next, cacheKey: `${agent.id}:${path}:${hash(next)}` };
  const input = oldFile && newFile ? { oldFile, newFile } : oldFile ? { oldFile, newFile: null } : { oldFile: null, newFile: newFile! };

  return (
    <div
      className="overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base"
      style={{ "--diffs-light-bg": "var(--fy-surface)", "--diffs-dark-bg": "var(--fy-surface)" } as React.CSSProperties}
    >
      {header}
      <MultiFileDiff<HunkMeta, undefined>
        {...input}
        options={{
          diffStyle,
          themeType: mode,
          lineDiffType: "word",
          overflow: wrap ? "wrap" : "scroll",
          stickyHeader: true,
        }}
        lineAnnotations={annotations}
        renderAnnotation={(a) => (
          <div data-hunk={a.metadata.hunkId} className="flex items-center gap-2 border-y border-kumo-hairline bg-kumo-elevated px-3 py-1 text-xs">
            <AgentBadge agent={a.metadata.agent} size={16} />
            <span className="font-medium">{a.metadata.agent.name}</span>
            <span className="text-kumo-subtle">
              hunk {a.metadata.index}/{a.metadata.total}
            </span>
            {a.metadata.note && <span className="truncate text-kumo-subtle">— {a.metadata.note}</span>}
            <span className="ml-auto">{renderHunkExtra?.(byId.get(a.metadata.hunkId)!)}</span>
          </div>
        )}
      />
    </div>
  );
}

/** Mount children only once scrolled near the viewport: big forks stay fast. */
export function LazyMount({ children, minHeight = 120, eager = false }: { children: ReactNode; minHeight?: number; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} style={visible ? undefined : { minHeight }}>
      {visible ? children : null}
    </div>
  );
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
