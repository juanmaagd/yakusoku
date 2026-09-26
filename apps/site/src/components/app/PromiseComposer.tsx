import TutorialVideo from "../ui/TutorialVideo";
import { useMemo, useState, type ReactNode } from "react";
import type { Address, EIP1193Provider } from "viem";
import { MANDATE_CATEGORY_OPTIONS, MANDATE_EXPIRY_PRESETS, SITE } from "../../config";
import { createMandate } from "../../lib/api";
import { formatRemaining, formatUsdcFixed, shortAddress, shortHex } from "../../lib/format";
import { prepareTaskIntent, serializeSignedIntent, signTaskIntent, type PreparedTaskIntent } from "../../lib/taskIntent";
import { chipClass, errorText, ghostButton, helpText, inputBase, label, primaryButton, smallButton } from "../../lib/ui";
import { describeWalletError, isUserRejection, TARGET_CHAIN } from "../../lib/wallet";
import { IconArrowLeft, IconCross, IconPlus } from "../ui/Icons";

export interface CreatedPromise {
  id: string;
  agentKey: string;
  task: string;
}

interface PromiseComposerProps {
  provider: EIP1193Provider;
  address: Address;
  onCreated: (created: CreatedPromise) => void;
  onCancel: () => void;
}

type Phase = "idle" | "signing" | "submitting";

const DEFAULT_EXPIRY_SECONDS = MANDATE_EXPIRY_PRESETS[1]!.seconds; // 24 hours

/** S2: the form on the left, the promise document on the right. The preview
 * renders the exact `TaskIntent` that "Sign promise" signs (task, budget,
 * categories, expiry, nonce, under the Omamorisan / Base Sepolia domain):
 * nothing shown that is not signed, nothing signed that is not shown. */
export default function PromiseComposer({ provider, address, onCreated, onCancel }: PromiseComposerProps) {
  const [task, setTask] = useState("");
  const [budgetUsdc, setBudgetUsdc] = useState("25");
  const [categories, setCategories] = useState<string[]>([]);
  const [customCategory, setCustomCategory] = useState("");
  const [expirySeconds, setExpirySeconds] = useState<number>(DEFAULT_EXPIRY_SECONDS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | undefined>();

  const budgetValue = Number(budgetUsdc);
  const budgetValid = Number.isFinite(budgetValue) && budgetValue >= 0.01;
  const missing = [
    task.trim().length === 0 && "what your agent should do",
    !budgetValid && "a budget",
    categories.length === 0 && "at least one category",
  ].filter(Boolean) as string[];
  const isValid = missing.length === 0;

  // Recomputed on every edit, frozen while signing: this object is both what
  // the preview shows and what the wallet signs.
  const prepared = useMemo<PreparedTaskIntent | undefined>(
    () => (isValid ? prepareTaskIntent({ task, budgetUsdc: budgetValue, categories, expirySeconds }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isValid/budgetValue derive from these
    [task, budgetUsdc, categories, expirySeconds],
  );

  const busy = phase !== "idle";

  function toggleCategory(value: string) {
    setCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function addCustomCategory() {
    const value = customCategory.trim();
    if (!value || categories.includes(value)) return;
    setCategories((prev) => [...prev, value]);
    setCustomCategory("");
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
      setError(isUserRejection(err) ? "Signature rejected. Nothing was created." : describeWalletError(err, "Could not create this intent."));
      setPhase("idle");
    }
  }

  return (
    <section>
      <button type="button" onClick={onCancel} disabled={busy} className={`${ghostButton} -ml-3`}>
        <IconArrowLeft size={14} />
        Intents
      </button>
      <h1 className="headline mt-3 text-heading-sm md:text-heading">
        New <strong>intent</strong>
      </h1>

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_440px]">
        <fieldset disabled={busy} className="min-w-0 space-y-7">
          <div>
            <label className={label} htmlFor="promise-task">
              What should your agent do?
            </label>
            <textarea
              id="promise-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              placeholder="Buy a $25 Amazon gift card for my sister's birthday"
              className={`${inputBase} mt-2 resize-y`}
              aria-describedby="promise-task-help"
            />
            <p id="promise-task-help" className={helpText}>
              Write it like you&rsquo;d tell a person. Every payment is checked against it.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="promise-budget">
              Budget
            </label>
            <div className="relative mt-2 max-w-[240px]">
              <input
                id="promise-budget"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={budgetUsdc}
                onChange={(e) => setBudgetUsdc(e.target.value)}
                className={`${inputBase} pr-16 font-mono tabular-nums`}
                aria-describedby="promise-budget-help"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-caption text-graphite">
                USDC
              </span>
            </div>
            <p id="promise-budget-help" className={helpText}>
              The most your agent can spend under this intent.
            </p>
          </div>

          <div>
            <span className={label} id="promise-categories">
              Categories
            </span>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby="promise-categories">
              {MANDATE_CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={categories.includes(option.value)}
                  onClick={() => toggleCategory(option.value)}
                  className={chipClass(categories.includes(option.value))}
                >
                  {option.label}
                </button>
              ))}
              {categories
                .filter((c) => !MANDATE_CATEGORY_OPTIONS.some((o) => o.value === c))
                .map((custom) => (
                  <button
                    key={custom}
                    type="button"
                    onClick={() => toggleCategory(custom)}
                    className={chipClass(true)}
                    aria-label={`Remove ${custom}`}
                  >
                    {custom}
                    <IconCross size={12} />
                  </button>
                ))}
            </div>
            <div className="mt-2 flex max-w-[420px] gap-2">
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
                placeholder="Another category"
                aria-label="Add a category"
                className={inputBase}
              />
              <button type="button" onClick={addCustomCategory} disabled={!customCategory.trim()} className={`${smallButton} shrink-0`}>
                <IconPlus size={14} />
                Add category
              </button>
            </div>
            <p className={helpText}>Tells the intent check what kind of purchase fits.</p>
          </div>

          <div>
            <span className={label} id="promise-expiry">
              Valid for
            </span>
            <div role="radiogroup" aria-labelledby="promise-expiry" className="mt-2 inline-flex rounded-btn border border-hairline-strong p-0.5">
              {MANDATE_EXPIRY_PRESETS.map((preset) => {
                const selected = expirySeconds === preset.seconds;
                return (
                  <button
                    key={preset.seconds}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setExpirySeconds(preset.seconds)}
                    className={`rounded-sm px-4 py-1.5 text-body-sm transition-colors duration-200 ease-out ${
                      selected ? "bg-ink text-surface" : "text-ink hover:bg-fog"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
        </fieldset>

        <aside className="lg:sticky lg:top-24">
          <PromisePreview
            prepared={prepared}
            draftTask={task.trim()}
            address={address}
            phase={phase}
            missing={missing}
            error={error}
            onSign={() => void handleSign()}
          />
        </aside>
      </div>
      <TutorialVideo topic="create" />
    </section>
  );
}

interface PromisePreviewProps {
  prepared: PreparedTaskIntent | undefined;
  draftTask: string;
  address: Address;
  phase: Phase;
  missing: string[];
  error: string | undefined;
  onSign: () => void;
}

function PromisePreview({ prepared, draftTask, address, phase, missing, error, onSign }: PromisePreviewProps) {
  const expiryMs = prepared ? Number(prepared.expiry) * 1000 : undefined;
  const task = prepared?.task ?? draftTask;

  return (
    <div className="rounded-card border border-hairline bg-surface shadow-console">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <span className="text-body-sm font-semibold text-ink">Intent</span>
        <span className="label text-graphite">EIP-712 typed data</span>
      </div>

      <div className="px-5 py-5">
        <p className={`text-subheading text-pretty ${task ? "text-ink" : "text-graphite"}`}>
          {task || "What your agent should do appears here."}
        </p>

        <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-body-sm">
          <Row term="Budget">
            {prepared ? <span className="font-mono tabular-nums">{formatUsdcFixed(prepared.budget)} USDC</span> : <Pending />}
          </Row>
          <Row term="Categories">
            {prepared ? <span className="font-mono break-all">{prepared.categories.join(", ")}</span> : <Pending />}
          </Row>
          <Row term="Expires">
            {expiryMs ? (
              <>
                {new Date(expiryMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                <span className="text-graphite"> · in {formatRemaining(expiryMs - Date.now())}</span>
              </>
            ) : (
              <Pending />
            )}
          </Row>
          <Row term="Signed by">
            <span className="font-mono" title={address}>
              {shortAddress(address)}
            </span>
          </Row>
          <Row term="Network">
            {SITE.network}
            <span className="text-graphite"> · chain {TARGET_CHAIN.id}</span>
          </Row>
          <Row term="Nonce">
            {prepared ? (
              <>
                <span className="font-mono" title={prepared.nonce}>
                  {shortHex(prepared.nonce)}
                </span>
                <span className="text-graphite"> · random, prevents reuse</span>
              </>
            ) : (
              <Pending />
            )}
          </Row>
        </dl>
      </div>

      <div className="border-t border-hairline px-5 py-4">
        <button type="button" onClick={onSign} disabled={!prepared || phase !== "idle"} className={`${primaryButton} w-full`}>
          {phase === "signing" ? "Waiting for your wallet…" : phase === "submitting" ? "Registering with the firewall…" : "Sign intent"}
        </button>
        {!prepared && missing.length > 0 ? (
          <p className="mt-2 text-caption text-graphite">Add {joinList(missing)} to sign.</p>
        ) : (
          <p className="mt-2 text-caption text-graphite">Your wallet shows this exact data. Signing is free.</p>
        )}
        {error && (
          <p className={`${errorText} mt-2`} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 py-2.5">
      <dt className="text-graphite">{term}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function Pending() {
  return <span className="text-graphite">—</span>;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

