import { agentCliCommand, mcpHttpSnippet, mcpStdioConfigSnippet, SITE } from "../../config";
import { card, primaryButton, textButton } from "../../lib/ui";
import CopyBlock from "./CopyBlock";

export interface MandateResultData {
  id: string;
  agentKey: string;
  task: string;
}

interface MandateResultProps {
  result: MandateResultData;
  onDone: () => void;
}

/** The one-time result screen (P5 brief step 5): the agent key shown exactly
 * once, the mandate id, and ready-to-paste agent/MCP snippets. Nothing here
 * is fetched again later — the key never comes back from any API. */
export default function MandateResult({ result, onDone }: MandateResultProps) {
  return (
    <div className="space-y-6">
      <div className={`${card} border-primary/30 bg-sky-tint/40`}>
        <h2 className="text-heading-sm font-semibold text-ink">Mandate created</h2>
        <p className="mt-2 text-body text-graphite">
          Your agent can now spend against: <span className="font-medium text-ink">&ldquo;{result.task}&rdquo;</span>
        </p>
        <p className="mt-1 text-body-sm text-vermillion">
          The agent key below won&rsquo;t be shown again. Copy it now and store it with your agent — a lost key means
          creating a new mandate.
        </p>
      </div>

      <div className={card}>
        <div className="space-y-4">
          <CopyBlock label="Mandate id" value={result.id} />
          <CopyBlock label="Agent key" value={result.agentKey} />
        </div>
      </div>

      <div className={card}>
        <h3 className="text-heading-sm font-semibold text-ink">Hand this to your agent</h3>
        <p className="mt-1 text-body-sm text-graphite">
          Any of these gets an agent spending against this mandate through the firewall — none of them ever hold a
          signing key.
        </p>
        <div className="mt-4 space-y-4">
          <CopyBlock label="Agent CLI" value={agentCliCommand(result.id, result.agentKey)} block />
          <CopyBlock label="MCP client config (stdio)" value={mcpStdioConfigSnippet(result.agentKey)} block />
          <CopyBlock label="MCP (Streamable HTTP)" value={mcpHttpSnippet(result.agentKey)} block />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <button type="button" onClick={onDone} className={textButton}>
          Back to my mandates
        </button>
        <a href={SITE.dashboardRoute} className={primaryButton}>
          Next: open the dashboard
          <span aria-hidden="true">&rarr;</span>
        </a>
      </div>
    </div>
  );
}
