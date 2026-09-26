import { useEffect, useState } from "react";
import { SITE } from "../../config";
import { ghostButton, label, primaryButton } from "../../lib/ui";
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

      <div className="mt-8">
        <SecretField fieldLabel="Agent key" value={created.agentKey} />
        <p className="mt-3 max-w-[64ch] text-body-sm text-graphite">
          The agent key is a scoped credential: it can only ask the firewall to sign payments for this promise. It can&rsquo;t move funds.
        </p>
      </div>

      <ConnectionDetails created={created} />

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

function SecretField({ fieldLabel, value }: { fieldLabel: string; value: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={label}>{fieldLabel}</span>
        <CopyButton value={value} ariaLabel={`Copy ${fieldLabel.toLowerCase()}`} />
      </div>
      <p className="break-all rounded-btn border border-hairline-strong bg-fog px-4 py-4 font-mono text-body text-ink">{value}</p>
    </div>
  );
}

/** Everything an MCP client needs, as copyable values rather than commands. */
function ConnectionDetails({ created }: { created: CreatedPromise }) {
  const fields: { term: string; shown: string; copy: string }[] = [
    { term: "Promise ID", shown: created.id, copy: created.id },
    { term: "MCP server URL", shown: SITE.mcpUrl, copy: SITE.mcpUrl },
    { term: "Auth header", shown: "Authorization: Bearer <agent key>", copy: `Authorization: Bearer ${created.agentKey}` },
  ];
  return (
    <div className="mt-10">
      <h2 className="text-subheading font-medium text-ink">Connect your agent</h2>
      <p className="mt-1.5 text-body-sm text-graphite">Point any MCP client at this URL and send the agent key as a bearer token.</p>
      <dl className="mt-4 divide-y divide-hairline rounded-card border border-hairline">
        {fields.map((field) => (
          <div key={field.term} className="grid gap-2 px-4 py-3.5 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
            <dt className="label text-graphite">{field.term}</dt>
            <dd className="min-w-0 break-all font-mono text-body-sm text-ink">{field.shown}</dd>
            <dd className="sm:justify-self-end">
              <CopyButton value={field.copy} ariaLabel={`Copy ${field.term}`} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
