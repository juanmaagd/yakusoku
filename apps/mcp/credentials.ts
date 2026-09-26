// Local on-disk credential storage for the Omamorisan MCP server (P9.3,
// odd/tasks/yakusoku.md Phase 3) — lets a stdio agent run `connect` ONCE and
// have every later process pick up the resulting World ID account key
// automatically, without re-authenticating or ever exposing the key to the
// LLM. Keyed by firewall base URL so one machine can hold credentials for
// more than one firewall (e.g. an isolated test stack alongside the live
// one).
//
// Credential resolution order (index.ts, session.ts): an HTTP
// `Authorization: Bearer` header on the connecting request > the
// `OMAMORISAN_AGENT_KEY` env var > this file. `connect`/`check_connection`
// (tools.ts) are the only writers, and only after a real World ID approval —
// an env- or header-provided key is never written back here.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialKind = "wallet" | "account";

/** `yk_` = a wallet-signed TaskIntent mandate key (legacy, WU-P1/P1). `ya_` =
 * a World-ID-connected account key (P9.1). Anything else is unrecognized —
 * callers should treat that the same as "no usable credential". */
export function credentialKind(key: string): CredentialKind | undefined {
  if (key.startsWith("ya_")) return "account";
  if (key.startsWith("yk_")) return "wallet";
  return undefined;
}

export interface StoredCredential {
  agentKey: string;
  kind: CredentialKind;
  connectedAt: string;
}

/** Keyed by firewall base URL (e.g. `http://localhost:4001`). */
type CredentialsFile = Record<string, StoredCredential>;

function credentialsFilePath(): string {
  return process.env.OMAMORISAN_CREDENTIALS_FILE ?? join(homedir(), ".omamorisan", "credentials.json");
}

async function readCredentialsFile(): Promise<CredentialsFile> {
  try {
    const raw = await readFile(credentialsFilePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CredentialsFile) : {};
  } catch {
    return {}; // missing file, unreadable, or malformed — treat as "no stored credentials yet".
  }
}

/** Best-effort read — never throws; a missing/corrupt file just means no
 * stored credential for this firewall yet (the caller falls back to "not
 * connected"). */
export async function loadStoredCredential(firewallUrl: string): Promise<StoredCredential | undefined> {
  const all = await readCredentialsFile();
  return all[firewallUrl];
}

/** Persists a freshly-connected credential (file mode 0600, directory 0700).
 * Called only right after a real `connect`/`check_connection` World ID
 * approval — an env-provided or HTTP-header-provided key already lives
 * wherever the operator put it and is never written here. */
export async function saveStoredCredential(firewallUrl: string, credential: StoredCredential): Promise<void> {
  const path = credentialsFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const all = await readCredentialsFile();
  all[firewallUrl] = credential;
  await writeFile(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s `mode` option only applies when the file didn't already
  // exist — force it closed on every save too, in case an older version of
  // this file was left with looser permissions.
  await chmod(path, 0o600).catch(() => {});
}
