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

/** Atomic USDC as a fixed two-decimal amount (`"25000000"` -> `"25.00"`),
 * for tabular display where trailing zeros keep columns aligned. */
export function formatUsdcFixed(atomic: string | bigint): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const cents = (value + 5_000n) / 10_000n; // 6 decimals -> 2, rounded
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

/** "23h 12m" / "12m" / "3d 4h" — remaining time with two units of precision. */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(Math.floor(ms / 60_000), 0);
  if (totalMinutes < 1) return "under a minute";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "just now" / "4m ago" / "3h ago" / "2d ago" for an ISO timestamp. */
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 45_000) return "just now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Short hex for ids and nonces: `0x9f3a…c21e`. */
export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
