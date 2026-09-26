// Session-token persistence (P5). `localStorage`, not `sessionStorage`: a
// session must survive new tabs, links opened from the agent and browser
// restarts, or every visit asks for a fresh wallet signature. The firewall
// stays the authority (8h TTL, revocable via logout), so this is only a
// cache of the bearer token. Every access is wrapped in try/catch (private
// windows, blocked site data, etc. can all throw or silently no-op) so the
// app still works without it, just asking the signer to sign in again.

export const SESSION_TOKEN_KEY = "omamorisan.sessionToken";

export function readSessionToken(): string | undefined {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Best-effort only — see file header.
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Best-effort only — see file header.
  }
}
