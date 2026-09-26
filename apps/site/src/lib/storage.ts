// Session-token persistence (P5). `sessionStorage` is a per-viewer convenience
// only — every access is wrapped in try/catch (private windows, blocked site
// data, etc. can all throw or silently no-op) so the app still works without
// it, just asking the signer to sign in again after a refresh.

const SESSION_TOKEN_KEY = "omamorisan.sessionToken";

export function readSessionToken(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Best-effort only — see file header.
  }
}

export function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Best-effort only — see file header.
  }
}
