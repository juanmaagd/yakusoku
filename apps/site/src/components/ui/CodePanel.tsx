import CopyButton from "./CopyButton";

interface CodePanelProps {
  title: string;
  code: string;
}

/** Dark code panel with a copy action — the same product fragment the
 * landing uses for its API snippets. */
export default function CodePanel({ title, code }: CodePanelProps) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-card bg-ink">
      <figcaption className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <span className="truncate text-body-sm font-medium text-white">{title}</span>
        <CopyButton value={code} tone="dark" />
      </figcaption>
      <pre className="code-block overflow-x-auto px-4 py-3.5 text-white/90">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
