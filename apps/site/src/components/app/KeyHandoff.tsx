import TutorialVideo from "../ui/TutorialVideo";
import ConnectionSetup from "./ConnectionSetup";
import { useEffect, useState } from "react";
import { ghostButton, label, primaryButton } from "../../lib/ui";
import CopyButton from "../ui/CopyButton";
import { IconArrowRight, IconCheck } from "../ui/Icons";
import type { CreatedPromise } from "./PromiseComposer";

interface KeyHandoffProps {
  entryPath?: string;
  created: CreatedPromise;
  onDone: () => void;
  /** Switches to the Live tab client-side (P5); used to be a
   * `window.location.assign` full document reload. */
  onOpenLive: () => void;
}

/** S3: the only moment the agent key exists in the UI. It is never fetched
 * again (the firewall only returns it on `POST /intents`), so leaving is
 * gated on the owner confirming they stored it. */
export default function KeyHandoff({ created, onDone, entryPath, onOpenLive }: KeyHandoffProps) {
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
          <p className="mt-3 text-body text-graphite">Connect your agent below. Your key is shown once; save the configuration before leaving.</p>
          <p className="mt-3 text-body-sm text-graphite">
            For <span className="text-ink">&ldquo;{created.task}&rdquo;</span>
          </p>
        </div>
        <img src="/art/app/pass.webp" alt="" width={1024} height={1024} decoding="async" className="hidden size-32 shrink-0 sm:block md:size-36" />
      </div>

      <div className="mt-8">
        <SecretField fieldLabel="Agent key" value={created.agentKey} />
        <p className="mt-3 max-w-[64ch] text-body-sm text-graphite">
          This secret authorizes payment requests under this promise. The firewall still checks every request. Keep it in your client settings, not in chat.
        </p>
      </div>

      <p className="mt-4 break-all font-mono text-caption text-graphite">Promise ID: {created.id}</p>
      <TutorialVideo topic="connect" />
      <ConnectionSetup agentKey={created.agentKey} entryPath={entryPath} />

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
          <button type="button" disabled={!stored} onClick={onOpenLive} className={primaryButton}>
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
