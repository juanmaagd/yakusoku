// Display formatting shared by the mandate wizard, result screen, and list.

const USDC_DECIMALS = 6;

/** Renders a 6-decimal atomic USDC amount (string or bigint) as a plain
 * decimal string, trimming trailing zeros (`"1000000"` -> `"1"`). */
export function formatUsdc(atomic: string | bigint): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export interface ExpiryInfo {
  absolute: string;
  relative: string;
  isExpired: boolean;
}

/** Formats a unix-seconds expiry (string or bigint) as an absolute date/time
 * plus a short relative label ("in 24h", "expired"). */
export function formatExpiry(expiryUnixSeconds: string | bigint): ExpiryInfo {
  const seconds = typeof expiryUnixSeconds === "bigint" ? expiryUnixSeconds : BigInt(expiryUnixSeconds);
  const ms = Number(seconds) * 1000;
  const diffMs = ms - Date.now();
  const isExpired = diffMs <= 0;
  const absolute = new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return { absolute, relative: isExpired ? "expired" : `in ${formatDuration(diffMs)}`, isExpired };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${Math.max(totalMinutes, 1)}m`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  return `${Math.round(totalHours / 24)}d`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
