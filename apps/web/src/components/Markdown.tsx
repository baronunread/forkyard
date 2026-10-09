import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./ui";

/**
 * GitHub-flavored markdown for backlog items and comments. No raw HTML (react-markdown drops it),
 * links open in a new tab. ponytail: no syntax highlighting, mermaid or math yet (#15).
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
