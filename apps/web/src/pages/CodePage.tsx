import { Empty, Loader } from "@cloudflare/kumo";
import { File as FileIcon, FileText, Folder, Lightning } from "@phosphor-icons/react";
import { File } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Markdown } from "../components/Markdown";
import { Button, Card, cx } from "../components/ui";
import { initialsFor } from "@forkyard/shared";
import { AgentBadge } from "../components/AgentChip";
import type { Change, CodeFile, CodeTree, CodeWhy } from "../lib/api";
import { ago } from "../lib/format";
import { codeQuery, codeWhyQuery, yardParams } from "../lib/queries";
import { useTheme } from "../lib/theme";
import { useYard } from "./YardLayout";

/**
 * The base repo as people read it. Where a forge shows the last commit message, every folder
 * and file here says which task changed it last, and which agents did the work.
 */
export function CodePage({ path }: { path: string }) {
  const { yard, start } = useYard();
  const q = useQuery(codeQuery(yard, path));
  const here = path || "the whole repo";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Crumbs yard={yard} path={path} />
        <Button size="sm" icon={<Lightning />} onClick={() => start(path ? `In \`${path}\`: ` : "")} title={`Start a task about ${here}`}>
          Start a task here
        </Button>
      </div>
      {q.error ? (
        <Card className="px-6 py-10">
          <Empty title="Nothing here" description={q.error.message} />
        </Card>
      ) : !q.data ? (
        <Loader />
      ) : q.data.kind === "tree" ? (
        <Folder_ yard={yard} tree={q.data.tree} />
      ) : (
        <FileView yard={yard} file={q.data.file} />
      )}
    </div>
  );
}

function Crumbs({ yard, path }: { yard: string; path: string }) {
  const params = yardParams(yard);
  const parts = path ? path.split("/") : [];
  const cls = "rounded px-1 py-0.5 hover:bg-hover hover:text-fg";
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[14px] text-body">
      <Link to="/$owner/$yard/code/$" params={{ ...params, _splat: "" }} className={cx(cls, !parts.length && "font-semibold text-fg")}>
        {params.yard}
      </Link>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-0.5">
          <span className="text-muted">/</span>
          <Link to="/$owner/$yard/code/$" params={{ ...params, _splat: parts.slice(0, i + 1).join("/") }} className={cx(cls, i === parts.length - 1 && "font-semibold text-fg")}>
            {p}
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** "Add caching · Ada, Bash · 2h ago", linking to the task; or the commit's first line for changes made outside a task. */
export function ChangeLine({ yard, change, className }: { yard: string; change: Change; className?: string }) {
  const title = change.task?.title ?? change.message.split("\n")[0];
  return (
    <span className={cx("flex min-w-0 items-center gap-2", className)}>
      {change.task ? (
        <Link to="/$owner/$yard/t/$task" params={{ ...yardParams(yard), task: change.task.id }} className="min-w-0 truncate text-fg hover:underline" title={title}>
          {title}
        </Link>
      ) : (
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
      )}
      {change.agents.length > 0 && <span className="shrink-0 text-muted">{change.agents.join(", ")}</span>}
    </span>
  );
}

function Folder_({ yard, tree }: { yard: string; tree: CodeTree }) {
  const now = Date.now();
  const params = yardParams(yard);
  if (!tree.entries.length)
    return (
      <Card className="px-6 py-10">
        <Empty title="Empty" description="Nothing has been committed here yet." />
      </Card>
    );
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        {tree.here && (
          <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-5 py-3 text-[13px] text-body">
            <span className="shrink-0 text-muted">Latest</span>
            <ChangeLine yard={yard} change={tree.here} className="flex-1" />
            <span className="shrink-0 text-muted">{ago(tree.here.at, now)}</span>
            {!tree.path && (
              <Link to="/$owner/$yard/log" params={params} className="shrink-0 hover:text-fg">
                {tree.commits} {tree.commits === 1 ? "change" : "changes"}
              </Link>
            )}
          </div>
        )}
        <div className="divide-y divide-line">
          {tree.entries.map((e) => (
            <div key={e.path} className="flex items-center gap-4 px-5 py-2.5 text-[14px] hover:bg-hover">
              <Link to="/$owner/$yard/code/$" params={{ ...params, _splat: e.path }} className="flex w-56 min-w-0 shrink-0 items-center gap-2.5 hover:underline max-sm:flex-1">
                {e.type === "tree" ? <Folder weight="fill" className="shrink-0 text-link" /> : <FileIcon className="shrink-0 text-muted" />}
                <span className="truncate">{e.name}</span>
              </Link>
              <span className="min-w-0 flex-1 text-[13px] text-body max-sm:hidden">{e.last && <ChangeLine yard={yard} change={e.last} />}</span>
              <span className="w-20 shrink-0 text-right text-xs text-muted">{e.last ? ago(e.last.at, now) : ""}</span>
            </div>
          ))}
        </div>
      </Card>
      {tree.readme?.text && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[13px] text-body">
            <FileText /> {tree.readme.name}
          </div>
          <Markdown className="px-6 py-5" base={`/${params.owner}/${params.yard}/code/${tree.path ? `${tree.path}/` : ""}`}>
            {tree.readme.text}
          </Markdown>
        </Card>
      )}
    </div>
  );
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Span = CodeWhy["spans"][number];

/** Share of the file's lines per author: agents in their colors, everything else grey. */
function Authorship({ spans, lines, on, toggle }: { spans: Span[]; lines: number; on: boolean; toggle: () => void }) {
  const by = new Map<string, { name: string; color: string; n: number }>();
  for (const s of spans) {
    const k = s.agent ?? "";
    const e = by.get(k) ?? { name: s.agent ?? "Before agents", color: s.color ?? "var(--color-line-strong)", n: 0 };
    e.n += s.end - s.start;
    by.set(k, e);
  }
  const parts = [...by.values()].sort((a, b) => b.n - a.n);
  const agents = parts.filter((p) => p.name !== "Before agents");
  return (
    <button
      onClick={toggle}
      aria-pressed={on}
      title={parts.map((p) => `${p.name}: ${Math.round((p.n / Math.max(1, lines)) * 100)}%`).join(" · ")}
      className={cx("flex items-center gap-2 rounded-md px-2 py-1 text-xs ring-1 ring-line hover:bg-hover", on ? "bg-selected text-fg" : "text-body")}
    >
      <span className="flex h-1.5 w-24 overflow-hidden rounded-full bg-line">
        {parts.map((p) => (
          <span key={p.name} style={{ width: `${(p.n / Math.max(1, lines)) * 100}%`, background: p.color }} />
        ))}
      </span>
      {agents.length ? `${agents.map((a) => a.name).join(", ")} wrote ${Math.round((agents.reduce((n, a) => n + a.n, 0) / Math.max(1, lines)) * 100)}%` : "Who & why"}
    </button>
  );
}

/** The line above a block of code: who wrote it, in which task, meaning to do what. */
function WhyRow({ yard, span }: { yard: string; span: Span }) {
  const c = span.change;
  return (
    <div className="flex items-center gap-2 border-y border-line bg-surface-2 px-3 py-1.5 font-sans text-xs text-body" title={span.intent?.why ?? undefined}>
      {span.agent ? (
        <>
          <AgentBadge agent={{ id: span.agent, name: span.agent, initials: initialsFor(span.agent), color: span.color ?? "#888888" }} size={16} />
          <span className="font-medium text-fg">{span.agent}</span>
          <span>wrote this in</span>
        </>
      ) : (
        <span>{c ? "From" : "Older than the log"}</span>
      )}
      {c && <ChangeLine yard={yard} change={{ ...c, agents: [] }} className="font-medium" />}
      {span.intent && <span className="min-w-0 truncate">— {span.intent.summary}</span>}
      {c && <span className="ml-auto shrink-0 text-muted">{ago(c.at)}</span>}
    </div>
  );
}

function FileView({ yard, file }: { yard: string; file: CodeFile }) {
  const { mode } = useTheme();
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const [preview, setPreview] = useState(markdown);
  const lines = file.text?.split("\n").length ?? 0;
  const code = file.text !== null && !file.binary;
  const why = useQuery({ ...codeWhyQuery(yard, file.path), enabled: code });
  const [explain, setExplain] = useState(false);
  const spans = why.data?.spans ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2 px-5 py-3 text-[13px] text-body">
        <span className="text-muted">
          {file.text !== null ? `${lines} lines · ` : ""}
          {size(file.size)}
        </span>
        {file.last && (
          <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <ChangeLine yard={yard} change={file.last} className="justify-end" />
            <span className="shrink-0 text-muted">{ago(file.last.at)}</span>
          </span>
        )}
        {spans.length > 0 && <Authorship spans={spans} lines={why.data!.lines} on={explain} toggle={() => (setExplain(!explain), setPreview(false))} />}
        {markdown && file.text !== null && (
          <span className="flex rounded-md ring-1 ring-line">
            {(["Preview", "Code"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setPreview(v === "Preview")}
                className={cx("px-2.5 py-1 text-xs", (v === "Preview") === preview ? "bg-selected font-medium text-fg" : "text-body hover:text-fg")}
              >
                {v}
              </button>
            ))}
          </span>
        )}
      </div>
      {file.text === null || file.binary ? (
        <p className="px-6 py-10 text-center text-body">Binary file ({size(file.size)}), not shown.</p>
      ) : preview ? (
        <Markdown className="px-6 py-5" base={`/${yardParams(yard).owner}/${yardParams(yard).yard}/code/${file.path.replace(/[^/]*$/, "")}`}>
          {file.text}
        </Markdown>
      ) : (
        <div className="[--diffs-dark-bg:var(--color-surface)] [--diffs-font-fallback:ui-monospace,monospace] [--diffs-font-family:var(--font-mono)] [--diffs-light-bg:var(--color-surface)]">
          <File<Span>
            file={{ name: file.path, contents: file.text }}
            options={{ themeType: mode, overflow: "scroll" }}
            lineAnnotations={explain ? spans.map((s) => ({ lineNumber: s.start, metadata: s })) : []}
            renderAnnotation={(a) => <WhyRow yard={yard} span={a.metadata} />}
          />
        </div>
      )}
    </Card>
  );
}
