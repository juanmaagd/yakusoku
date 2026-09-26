import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { SITE } from "../config";
import { AGENT_PROVIDERS, type ProviderId, type Surface } from "../lib/agentSetup";
import { smallButton } from "../lib/ui";
import CopyButton from "./ui/CopyButton";

const CONNECTION_FIELDS = [
  { term: "Server name", value: "omamorisan" },
  { term: "Transport", value: "Streamable HTTP" },
  { term: "URL", value: SITE.mcpUrl },
] as const;

const PROVIDER_OPTIONS = AGENT_PROVIDERS.map((p) => ({ value: p.id, label: p.name }));
const SURFACE_OPTIONS: readonly { value: Surface; label: string }[] = [
  { value: "app", label: "App" },
  { value: "terminal", label: "Terminal" },
];

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

/** A roving-tabindex ARIA radiogroup: arrow keys move focus and the selection
 * together (WAI-ARIA radio-group pattern). The existing chip toggles elsewhere
 * on the site only handle click, so this isn't reused from there. */
function RadioSegment<T extends string>({
  groupLabelId,
  options,
  value,
  onChange,
}: {
  groupLabelId: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveTo(index: number) {
    onChange(options[index].value);
    refs.current[index]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveTo((index + 1) % options.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveTo((index - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(options.length - 1);
        break;
    }
  }

  return (
    <div role="radiogroup" aria-labelledby={groupLabelId} className="inline-flex w-full gap-1 rounded-btn border border-hairline-strong p-1 sm:w-auto">
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`flex-1 rounded-sm px-3 py-1.5 text-body-sm transition-colors duration-200 ease-out sm:flex-none ${
              selected ? "bg-ink text-surface" : "text-ink hover:bg-fog"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The setup section's interactive core: a provider × surface selector above
 * two artifacts for the current combination — a copyable prompt and copyable
 * connection details — or, for an unsupported combination, a quiet notice. */
export default function SetupAgentCard() {
  const [providerId, setProviderId] = useState<ProviderId>("claude");
  const [surface, setSurface] = useState<Surface>("terminal");

  const provider = AGENT_PROVIDERS.find((p) => p.id === providerId)!;
  const setup = provider[surface];

  return (
    <div className="mt-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-8">
        <div>
          <span id="agent-provider-label" className="label text-graphite">
            Provider
          </span>
          <div className="mt-2">
            <RadioSegment groupLabelId="agent-provider-label" options={PROVIDER_OPTIONS} value={providerId} onChange={setProviderId} />
          </div>
        </div>
        <div>
          <span id="agent-surface-label" className="label text-graphite">
            Surface
          </span>
          <div className="mt-2">
            <RadioSegment groupLabelId="agent-surface-label" options={SURFACE_OPTIONS} value={surface} onChange={setSurface} />
          </div>
        </div>
      </div>

      {setup.supported ? (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-start">
          <figure className="min-w-0 overflow-hidden rounded-card bg-ink">
            <figcaption className="flex flex-col items-start gap-2 border-b border-white/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="label text-white/60">Prompt for {setup.client}</span>
              <CopyButton value={setup.prompt!()} label="Copy prompt" ariaLabel={`Copy the ${setup.client} setup prompt`} />
            </figcaption>
            <p className="px-5 py-4 text-body-sm text-white/90">{renderWithCode(setup.prompt!())}</p>
          </figure>

          <div className="rounded-card border border-hairline">
            <div className="border-b border-hairline px-5 py-3.5">
              <p className="text-body-sm font-medium text-ink">{setup.client}</p>
              {setup.requirement && <p className="mt-1 text-body-sm text-graphite">{setup.requirement}</p>}
            </div>
            <ol className="list-decimal space-y-2.5 py-3.5 pr-5 pl-9 text-body-sm text-graphite marker:text-stone">
              {setup.steps.map((step, i) => (
                <li key={i} className="pl-1">
                  {step}
                </li>
              ))}
            </ol>
            {setup.docsUrl && (
              <div className="border-t border-hairline px-5 py-3.5">
                <a href={setup.docsUrl} target="_blank" rel="noreferrer" className="text-body-sm text-ink underline">
                  Official {provider.name} setup instructions ↗
                </a>
              </div>
            )}
            <dl className="divide-y divide-hairline border-t border-hairline">
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
      ) : (
        <div className="mt-6 rounded-card border border-hairline bg-fog px-5 py-4 md:px-6 md:py-5">
          <p className="text-body-sm text-ink">{setup.notice}</p>
          <button type="button" className={`${smallButton} mt-3`} onClick={() => setSurface("terminal")}>
            Switch to Terminal
          </button>
        </div>
      )}

      <p className="mt-6 text-body-sm text-graphite">
        Claude Code is the one we&rsquo;ve verified end-to-end. The other setups follow each vendor&rsquo;s official docs.
      </p>
    </div>
  );
}
