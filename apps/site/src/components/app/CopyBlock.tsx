import { useState } from "react";
import { outlinedButton } from "../../lib/ui";

interface CopyBlockProps {
  /** Short label above the block, e.g. "Agent key" or "MCP (stdio)". */
  label: string;
  value: string;
  /** Renders the value in a monospace code block instead of an inline row —
   * used for keys and multi-line snippets. */
  block?: boolean;
}

/** A labeled value with a copy button — clipboard access can throw or be
 * unavailable (insecure context, permission denied), so a failed copy falls
 * back to a visible "select and copy manually" hint instead of failing silently. */
export default function CopyBlock({ label, value, block = false }: CopyBlockProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-body-sm font-medium text-ink/90">{label}</span>
        <button type="button" onClick={() => void handleCopy()} className={outlinedButton}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select to copy" : "Copy"}
        </button>
      </div>
      {block ? (
        <pre className="overflow-x-auto rounded-btn border border-black/[0.1] bg-canvas p-3 text-caption text-charcoal">
          <code>{value}</code>
        </pre>
      ) : (
        <p className="break-all rounded-btn border border-black/[0.1] bg-canvas px-3 py-2 font-mono text-body-sm text-charcoal">
          {value}
        </p>
      )}
    </div>
  );
}
