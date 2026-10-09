import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./ui";

/**
 * GitHub-flavored markdown for backlog items and comments. No raw HTML (react-markdown drops it),
 * links open in a new tab. ponytail: no syntax highlighting, mermaid or math yet (#15).
 */
export function Markdown({ children, className, base }: { children: string; className?: string; base?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, href, ...props }) => {
            // Relative links in a repo's markdown point at its own files: open them in the Code tab.
            const local = base && href && !/^([a-z]+:|\/\/|#)/i.test(href) ? new URL(href, `https://x${base}`).pathname : null;
            return local ? <a {...props} href={local} /> : <a {...props} href={href} target="_blank" rel="noreferrer noopener" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
