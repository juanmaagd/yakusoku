import type { ReactNode } from "react";
import { claudeSetupPrompt, SITE } from "../config";
import CopyButton from "./ui/CopyButton";

const CONNECTION_FIELDS = [
  { term: "Server name", value: "omamorisan" },
  { term: "Transport", value: "Streamable HTTP" },
  { term: "URL", value: SITE.mcpUrl },
] as const;

/** Splits on backtick-quoted spans and renders them as inline `<code>` — the
 * prompt is prose, so only its tool/identifier names get the mono treatment. */
function renderWithCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded-sm bg-white/10 px-1 py-0.5 font-mono text-[13px] text-white">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** The setup section's two artifacts: a copyable prompt for Claude Code, and
 * copyable connection details for any other Streamable HTTP MCP client. */
export default function SetupClaudeCard() {
  const prompt = claudeSetupPrompt();

  return (
    <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-start">
      <figure className="min-w-0 overflow-hidden rounded-card bg-ink">
        <figcaption className="flex flex-col items-start gap-2 border-b border-white/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="label text-white/60">Prompt for Claude Code</span>
          <CopyButton value={prompt} label="Copy prompt" ariaLabel="Copy the Claude Code setup prompt" />
        </figcaption>
        <p className="px-5 py-4 text-body-sm text-white/90">{renderWithCode(prompt)}</p>
      </figure>

      <div className="rounded-card border border-hairline">
        <div className="border-b border-hairline px-5 py-3.5">
          <p className="text-body-sm font-medium text-ink">Any other MCP client</p>
          <p className="mt-1 text-body-sm text-graphite">
            Works with any client that supports Streamable HTTP. Claude Code is the one we&rsquo;ve verified end-to-end.
          </p>
        </div>
        <dl className="divide-y divide-hairline">
          {CONNECTION_FIELDS.map((field) => (
            <div key={field.term} className="px-5 py-3.5">
              <dt className="label text-graphite">{field.term}</dt>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <dd className="min-w-0 break-words font-mono text-body-sm text-ink">{field.value}</dd>
                <CopyButton value={field.value} ariaLabel={`Copy ${field.term.toLowerCase()}`} />
              </div>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
