import { useEffect, useState } from "react";
import { agentCliCommand, mcpHttpSnippet, mcpStdioConfigSnippet, SITE } from "../../config";
import { ghostButton, label, primaryButton } from "../../lib/ui";
import CodePanel from "../ui/CodePanel";
import CopyButton from "../ui/CopyButton";
import { IconArrowRight, IconCheck } from "../ui/Icons";
import type { CreatedPromise } from "./PromiseComposer";

interface KeyHandoffProps {
  created: CreatedPromise;
  onDone: () => void;
}

/** S3: the only moment the agent key exists in the UI. It is never fetched
 * again (the firewall only returns it on `POST /intents`), so leaving is
 * gated on the owner confirming they stored it. */
export default function KeyHandoff({ created, onDone }: KeyHandoffProps) {
  const [stored, setStored] = useState(false);

  useEffect(() => {
    if (stored) return;
    function warn(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [stored]);

  return (
    <section className="mx-auto max-w-[760px]">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-verified text-surface" aria-hidden="true">
              <IconCheck size={18} strokeWidth={2} />
            </span>
            <h1 className="headline text-heading-sm md:text-heading">
              Promise <strong>signed.</strong>
            </h1>
          </div>
          <p className="mt-3 text-body text-graphite">Hand your agent its key. It&rsquo;s shown once. Store it before you leave this page.</p>
          <p className="mt-3 text-body-sm text-graphite">
            For <span className="text-ink">&ldquo;{created.task}&rdquo;</span>
          </p>
        </div>
        <img src="/art/app/pass.webp" alt="" width={1024} height={1024} decoding="async" className="hidden size-32 shrink-0 sm:block md:size-36" />
      </div>

      <div className="mt-8 space-y-5">
        <SecretField fieldLabel="Agent key" value={created.agentKey} large />
        <SecretField fieldLabel="Promise id" value={created.id} />
      </div>

      <p className="mt-4 max-w-[64ch] text-body-sm text-graphite">
        The agent key is a scoped credential: it can only ask the firewall to sign payments for this promise. It can&rsquo;t move funds.
      </p>

      <SetupTabs created={created} />

      <div className="mt-10 border-t border-hairline pt-6">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={stored}
            onChange={(e) => setStored(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-ink"
          />
          <span className="text-body text-ink">I&rsquo;ve stored the agent key somewhere safe.</span>
        </label>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" disabled={!stored} onClick={() => window.location.assign(SITE.dashboardRoute)} className={primaryButton}>
            Open Live
            <IconArrowRight size={14} />
          </button>
          <button type="button" disabled={!stored} onClick={onDone} className={ghostButton}>
            Back to promises
          </button>
        </div>
      </div>
    </section>
  );
}

function SecretField({ fieldLabel, value, large = false }: { fieldLabel: string; value: string; large?: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={label}>{fieldLabel}</span>
        <CopyButton value={value} />
      </div>
      <p
        className={`break-all rounded-btn border border-hairline-strong bg-fog px-4 font-mono text-ink ${
          large ? "py-4 text-body" : "py-3 text-body-sm"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

type SetupId = "mcp" | "http" | "cli";

function SetupTabs({ created }: { created: CreatedPromise }) {
  const [active, setActive] = useState<SetupId>("mcp");
  const tabs: { id: SetupId; label: string; hint: string; title: string; code: string }[] = [
    {
      id: "mcp",
      label: "Claude Desktop / Cursor",
      hint: "Add this server to your MCP client config, with the path pointing at your checkout of the repo.",
      title: "MCP config (stdio)",
      code: mcpStdioConfigSnippet(created.agentKey),
    },
    {
      id: "http",
      label: "HTTP (MCP)",
      hint: "Start the MCP server over HTTP, then send the agent key as a bearer token.",
      title: "MCP over Streamable HTTP",
      code: mcpHttpSnippet(created.agentKey),
    },
    {
      id: "cli",
      label: "Command line",
      hint: "Run the demo agent against this promise.",
      title: "Agent CLI",
      code: agentCliCommand(created.id, created.agentKey),
    },
  ];
  const current = tabs.find((t) => t.id === active)!;

  return (
    <div className="mt-10">
      <h2 className="text-subheading font-medium text-ink">Connect your agent</h2>
      <div role="tablist" aria-label="Agent setup" className="mt-4 flex gap-6 overflow-x-auto border-b border-hairline">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`setup-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="setup-panel"
              onClick={() => setActive(tab.id)}
              className={`relative shrink-0 whitespace-nowrap pb-3 text-body-sm transition-colors duration-200 ease-out ${
                selected ? "font-medium text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-ink" : "text-graphite hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div id="setup-panel" role="tabpanel" aria-labelledby={`setup-tab-${current.id}`} className="pt-4">
        <p className="mb-3 text-body-sm text-graphite">{current.hint}</p>
        <CodePanel title={current.title} code={current.code} />
      </div>
    </div>
  );
}
