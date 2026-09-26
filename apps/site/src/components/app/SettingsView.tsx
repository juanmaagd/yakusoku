import { useCallback, useEffect, useState } from "react";
import { SITE } from "../../config";
import { createAgentKey, listAgentKeys, revokeAgentKey, UnauthorizedError, type AgentKeySummary, type CreatedAgentKey } from "../../lib/api";
import { dangerOutlinedButton, inputBase, label, primaryButton, smallButton } from "../../lib/ui";
import ConfirmInline from "../ui/ConfirmInline";
import CopyButton from "../ui/CopyButton";
import EmptyState from "../ui/EmptyState";
import { IconPlus } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import StatusPill from "../ui/StatusPill";

interface SettingsViewProps {
  sessionToken: string;
  onUnauthorized: () => void;
}

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; keys: AgentKeySummary[] };

/** The Settings tab (K1/Settings): manage hosted-MCP agent keys. Approve with
 * World ID once from a promise, then paste `Authorization: Bearer <key>`
 * into an MCP client so it remembers this account across sessions instead of
 * re-approving World ID every time (the hosted MCP keeps a session's
 * credential in memory only, apps/mcp/index.ts's T8 fix). Separate from the
 * one-shot wallet-mandate handoff (`KeyHandoff.tsx`) — this key authorizes
 * the account, not a single signed promise, and can be listed and revoked
 * later. */
export default function SettingsView({ sessionToken, onUnauthorized }: SettingsViewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [justCreated, setJustCreated] = useState<CreatedAgentKey | undefined>();
  const [labelInput, setLabelInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const keys = await listAgentKeys(sessionToken);
      setState({ kind: "loaded", keys: sortKeys(keys) });
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not load your agent keys." });
    }
  }, [sessionToken, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setCreateError(undefined);
    try {
      const created = await createAgentKey(sessionToken, labelInput.trim() || undefined);
      setJustCreated(created);
      setLabelInput("");
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      const message = err instanceof Error ? err.message : "Could not create a key.";
      // The firewall's `POST /owner/agent-key` 404s with `no_account` (never a
      // 500) when this wallet hasn't linked any account yet — a real state
      // for a brand-new sign-in with no promises. `describeApiError` turns
      // that into the plain string "no account"; give it an actionable reply
      // here instead of the bare error code.
      setCreateError(
        message === "no account"
          ? "Sign a promise first (Promises tab) — that sets up your account. Then come back here to connect your agent."
          : message,
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    await revokeAgentKey(sessionToken, id);
    await load();
  }

  return (
    <section className="mx-auto max-w-[760px]">
      <div className="max-w-[640px]">
        <h1 className="headline text-heading-sm md:text-heading">
          Connect your <strong>agent</strong>
        </h1>
        <p className="mt-2 text-body text-graphite">
          Approve with World ID once. Your agent&rsquo;s MCP client remembers your account with a key you create here — no new approval every session.
        </p>
      </div>

      <div className="mt-8">
        <span className={label}>Hosted MCP URL</span>
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-btn border border-hairline-strong bg-fog px-4 py-3">
          <p className="min-w-0 flex-1 break-all font-mono text-body-sm text-ink">{SITE.mcpUrl}</p>
          <CopyButton value={SITE.mcpUrl} ariaLabel="Copy hosted MCP URL" />
        </div>
      </div>

      {justCreated && (
        <div className="mt-8 rounded-card border border-verified/40 bg-verified-wash p-5">
          <p className="text-body-sm font-medium text-ink">Key created. Copy it now — it won&rsquo;t be shown again. Create a new one anytime.</p>
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className={label}>Authorization header</span>
              <CopyButton value={`Authorization: Bearer ${justCreated.agentKey}`} label="Copy header" ariaLabel="Copy Authorization header" />
            </div>
            <p className="break-all rounded-btn border border-hairline-strong bg-surface px-4 py-4 font-mono text-body-sm text-ink">
              Authorization: Bearer {justCreated.agentKey}
            </p>
          </div>
          <button type="button" className={`${smallButton} mt-4`} onClick={() => setJustCreated(undefined)}>
            Done
          </button>
        </div>
      )}

      <div className="mt-10 border-t border-hairline pt-8">
        <h2 className="text-subheading font-medium">Agent keys</h2>
        <p className="mt-1 text-body-sm text-graphite">Each key authorizes an MCP client to act as your account. Revoke one anytime.</p>

        <div className="mt-5 rounded-card border border-hairline bg-surface p-5">
          <label className={label} htmlFor="agent-key-label">
            Label (optional)
          </label>
          <div className="mt-2 flex flex-wrap gap-3">
            <input
              id="agent-key-label"
              className={`${inputBase} max-w-[320px]`}
              placeholder="Claude Code on my laptop"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              maxLength={80}
            />
            <button type="button" disabled={creating} onClick={() => void handleCreate()} className={primaryButton}>
              <IconPlus size={14} />
              {creating ? "Creating…" : "Create agent key"}
            </button>
          </div>
          {createError && <p className="mt-2 text-body-sm text-refuse-ink">{createError}</p>}
        </div>

        <div className="mt-6">
          {state.kind === "loading" && (
            <ul aria-busy="true" aria-label="Loading your agent keys" className="grid gap-3">
              {[0, 1].map((i) => (
                <li key={i} className="rounded-card border border-hairline p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-3 h-3 w-24" />
                </li>
              ))}
            </ul>
          )}

          {state.kind === "error" && <InlineError title="Couldn't load your agent keys." detail={state.message} onRetry={() => void load()} />}

          {state.kind === "loaded" && state.keys.length === 0 && (
            <div className="rounded-card border border-hairline">
              <EmptyState
                art="/art/app/agent.webp"
                title="No agent keys yet"
                body="Create one above, then paste the Authorization header into your MCP client's settings."
              />
            </div>
          )}

          {state.kind === "loaded" && state.keys.length > 0 && (
            <ul className="grid gap-3">
              {state.keys.map((k) => (
                <AgentKeyRow key={k.id} keySummary={k} onRevoke={handleRevoke} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function sortKeys(keys: AgentKeySummary[]): AgentKeySummary[] {
  return [...keys].sort((a, b) => {
    const aLive = a.revoked ? 1 : 0;
    const bLive = b.revoked ? 1 : 0;
    return aLive - bLive || b.createdAt.localeCompare(a.createdAt);
  });
}

function AgentKeyRow({ keySummary, onRevoke }: { keySummary: AgentKeySummary; onRevoke: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const created = new Date(keySummary.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <li className="rounded-card border border-hairline bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-ink">{keySummary.label || "Unlabeled key"}</p>
          <p className="mt-1 text-caption text-graphite">Created {created}</p>
        </div>
        {keySummary.revoked ? <StatusPill tone="muted">Revoked</StatusPill> : <StatusPill tone="neutral">Active</StatusPill>}
      </div>

      {!keySummary.revoked && (
        <div className="mt-4 border-t border-hairline pt-3">
          {confirming ? (
            <ConfirmInline
              message="Revoke this key? Any MCP client using it stops working immediately."
              confirmLabel="Revoke"
              busyLabel="Revoking…"
              onConfirm={async () => {
                await onRevoke(keySummary.id);
                setConfirming(false);
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <div className="flex justify-end">
              <button type="button" onClick={() => setConfirming(true)} className={dangerOutlinedButton}>
                Revoke
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
