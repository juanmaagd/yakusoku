import { useMemo, useState } from "react";
import type { Address, EIP1193Provider } from "viem";
import { MANDATE_CATEGORY_OPTIONS, MANDATE_EXPIRY_PRESETS, SITE } from "../../config";
import { createMandate } from "../../lib/api";
import { formatUsdc } from "../../lib/format";
import { prepareTaskIntent, serializeSignedIntent, signTaskIntent, type PreparedTaskIntent } from "../../lib/taskIntent";
import { card, chipClass, errorText, inputBase, label as labelClass, outlinedButton, primaryButton } from "../../lib/ui";
import { describeWalletError } from "../../lib/wallet";
import type { MandateResultData } from "./MandateResult";

interface MandateWizardProps {
  provider: EIP1193Provider;
  address: Address;
  onCreated: (result: MandateResultData) => void;
}

type Phase = "form" | "preview" | "signing" | "submitting";

const DEFAULT_EXPIRY_SECONDS = MANDATE_EXPIRY_PRESETS[1]!.seconds; // 24 hours

export default function MandateWizard({ provider, address, onCreated }: MandateWizardProps) {
  const [phase, setPhase] = useState<Phase>("form");
  const [task, setTask] = useState("");
  const [budgetUsdc, setBudgetUsdc] = useState("25");
  const [categories, setCategories] = useState<string[]>([]);
  const [customCategory, setCustomCategory] = useState("");
  const [expirySeconds, setExpirySeconds] = useState<number>(DEFAULT_EXPIRY_SECONDS);
  const [prepared, setPrepared] = useState<PreparedTaskIntent | undefined>();
  const [error, setError] = useState<string | undefined>();

  const budgetValue = Number(budgetUsdc);
  const canPreview = task.trim().length > 0 && Number.isFinite(budgetValue) && budgetValue > 0 && categories.length > 0;

  const expiryLabel = useMemo(
    () => MANDATE_EXPIRY_PRESETS.find((p) => p.seconds === expirySeconds)?.label ?? `${expirySeconds}s`,
    [expirySeconds],
  );

  function toggleCategory(value: string) {
    setCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function addCustomCategory() {
    const value = customCategory.trim();
    if (!value || categories.includes(value)) return;
    setCategories((prev) => [...prev, value]);
    setCustomCategory("");
  }

  function goToPreview() {
    if (!canPreview) return;
    setError(undefined);
    setPrepared(prepareTaskIntent({ task, budgetUsdc: budgetValue, categories, expirySeconds }));
    setPhase("preview");
  }

  async function handleSign() {
    if (!prepared) return;
    setError(undefined);
    setPhase("signing");
    try {
      const signature = await signTaskIntent(provider, address, prepared);
      setPhase("submitting");
      const created = await createMandate(serializeSignedIntent(prepared, signature, address));
      onCreated({ id: created.id, agentKey: created.agentKey, task: prepared.task });
    } catch (err) {
      setError(describeWalletError(err, "Could not sign this mandate."));
      setPhase("preview");
    }
  }

  if (phase === "preview" || phase === "signing" || phase === "submitting") {
    const isBusy = phase !== "preview";
    return (
      <div className={card}>
        <h3 className="text-heading-sm font-semibold text-ink">Confirm what you&rsquo;re authorizing</h3>
        <p className="mt-1 text-body-sm text-graphite">
          This is exactly what you&rsquo;ll sign with your wallet — the firewall will only ever pay for this.
        </p>

        <dl className="mt-5 space-y-3 text-body-sm">
          <div>
            <dt className="text-stone">Task</dt>
            <dd className="text-ink">{prepared?.task}</dd>
          </div>
          <div>
            <dt className="text-stone">Budget</dt>
            <dd className="text-ink">${formatUsdc(prepared?.budget ?? 0n)} USDC total</dd>
          </div>
          <div>
            <dt className="text-stone">Categories</dt>
            <dd className="text-ink">{prepared?.categories.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-stone">Expires</dt>
            <dd className="text-ink">
              {expiryLabel} from now ({prepared ? new Date(Number(prepared.expiry) * 1000).toLocaleString() : ""})
            </dd>
          </div>
          <div>
            <dt className="text-stone">Signed for</dt>
            <dd className="text-ink">
              {SITE.name} on {SITE.network}
            </dd>
          </div>
        </dl>

        {error && (
          <p className={`${errorText} mt-4`} role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => void handleSign()} disabled={isBusy} className={primaryButton}>
            {phase === "signing" ? "Waiting for wallet…" : phase === "submitting" ? "Creating mandate…" : "Sign with wallet"}
          </button>
          <button type="button" onClick={() => setPhase("form")} disabled={isBusy} className={outlinedButton}>
            Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={card}>
      <h3 className="text-heading-sm font-semibold text-ink">Create a mandate</h3>
      <p className="mt-1 text-body-sm text-graphite">
        Describe what your agent is allowed to buy. The firewall will refuse anything else.
      </p>

      <div className="mt-5 space-y-5">
        <div>
          <label className={labelClass} htmlFor="mandate-task">
            Task
          </label>
          <textarea
            id="mandate-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="e.g. Buy a $25 Amazon gift card for my sister's birthday"
            className={inputBase}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="mandate-budget">
              Budget (USDC)
            </label>
            <input
              id="mandate-budget"
              type="number"
              min="0.01"
              step="0.01"
              value={budgetUsdc}
              onChange={(e) => setBudgetUsdc(e.target.value)}
              className={inputBase}
            />
          </div>

          <div>
            <span className={labelClass}>Expires</span>
            <div className="flex flex-wrap gap-2">
              {MANDATE_EXPIRY_PRESETS.map((preset) => (
                <button
                  key={preset.seconds}
                  type="button"
                  onClick={() => setExpirySeconds(preset.seconds)}
                  className={chipClass(expirySeconds === preset.seconds)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <span className={labelClass}>Categories</span>
          <div className="flex flex-wrap gap-2">
            {MANDATE_CATEGORY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => toggleCategory(option.value)}
                className={chipClass(categories.includes(option.value))}
              >
                {option.label}
              </button>
            ))}
            {categories
              .filter((c) => !MANDATE_CATEGORY_OPTIONS.some((o) => o.value === c))
              .map((custom) => (
                <button key={custom} type="button" onClick={() => toggleCategory(custom)} className={chipClass(true)}>
                  {custom} &times;
                </button>
              ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomCategory();
                }
              }}
              placeholder="Add a custom category"
              className={inputBase}
            />
            <button type="button" onClick={addCustomCategory} className={outlinedButton}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <button type="button" onClick={goToPreview} disabled={!canPreview} className={primaryButton}>
          Preview &amp; sign
        </button>
      </div>
    </div>
  );
}
