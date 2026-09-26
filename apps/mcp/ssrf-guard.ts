// SSRF guard for the shared MCP HTTP server (T2, odd/tasks/dokploy-deploy.md).
//
// Only wired up when this process runs in Streamable HTTP mode (`--http`):
// that server is shared by every tester who talks to the hosted MCP URL, so
// `fetch_url`/`pay_x402` must never be a proxy an agent can point at another
// container's admin port or the cloud metadata service. In stdio mode the
// user runs this process on their own machine, so index.ts never calls into
// this module there — the behavior is unchanged (root task's decision log).
//
// Blocks a request whose target host resolves to a private, loopback,
// link-local, unique-local (IPv6 ULA), CGNAT, or metadata address (IPv4 +
// IPv6). DNS is resolved once per hop, and `fetch` is called with
// `redirect: "manual"` so a 3xx can't silently walk the request into a
// blocked address the way `fetch`'s default `redirect: "follow"` would.
//
// Known limitation (documented, not fixed here — hackathon scope): this
// checks the resolved address, then lets `fetch` re-resolve DNS itself for
// the actual connection a moment later. A DNS answer that changes between
// the check and the connect (DNS rebinding) could still slip through.
// Closing that gap needs pinning the connection to the checked address (a
// custom dispatcher/Agent) — out of scope for this pass.

import { lookup } from "node:dns/promises";

export class BlockedUrlError extends Error {}

// --- IPv4 -------------------------------------------------------------------

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const v = Number(part);
    if (v > 255) return undefined;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

interface Cidr4 {
  base: number;
  bits: number;
}

function cidr4(base: string, bits: number): Cidr4 {
  const n = ipv4ToInt(base);
  if (n === undefined) throw new Error(`invalid built-in CIDR base: ${base}`);
  return { base: n, bits };
}

const BLOCKED_IPV4_RANGES: Cidr4[] = [
  cidr4("0.0.0.0", 8), // "this network" / unspecified
  cidr4("10.0.0.0", 8), // private
  cidr4("100.64.0.0", 10), // CGNAT (shared address space)
  cidr4("127.0.0.0", 8), // loopback
  cidr4("169.254.0.0", 16), // link-local, incl. 169.254.169.254 cloud metadata
  cidr4("172.16.0.0", 12), // private
  cidr4("192.168.0.0", 16), // private
];

function ipv4InRange(ip: number, cidr: Cidr4): boolean {
  if (cidr.bits === 0) return true;
  const mask = cidr.bits === 32 ? 0xffffffff : (0xffffffff << (32 - cidr.bits)) >>> 0;
  return (ip & mask) === (cidr.base & mask);
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) return true; // unparseable — fail closed
  return BLOCKED_IPV4_RANGES.some((r) => ipv4InRange(n, r));
}

// --- IPv6 -------------------------------------------------------------------

/** Expands any legal textual IPv6 form (`::` shorthand, an embedded IPv4
 * tail, a zone id) into exactly 8 hex groups. `undefined` for anything that
 * doesn't parse. */
function expandIpv6(ip: string): string[] | undefined {
  let addr = ip;
  const zoneIndex = addr.indexOf("%");
  if (zoneIndex !== -1) addr = addr.slice(0, zoneIndex);

  // An embedded IPv4 tail (e.g. "::ffff:127.0.0.1") — fold it into two
  // hextets so the rest of this parser only ever deals with pure IPv6 groups.
  const v4Tail = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(addr);
  if (v4Tail) {
    const prefix = v4Tail[1];
    const embedded = v4Tail[2];
    if (prefix === undefined || embedded === undefined) return undefined;
    const asInt = ipv4ToInt(embedded);
    if (asInt === undefined) return undefined;
    const hex = asInt.toString(16).padStart(8, "0");
    addr = `${prefix}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  const parts = addr.split("::");
  if (parts.length > 2) return undefined; // more than one "::" is never legal

  const first = parts[0] ?? "";
  const head = first ? first.split(":") : [];
  let groups: string[];
  if (parts.length === 2) {
    const second = parts[1] ?? "";
    const tail = second ? second.split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return undefined;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return undefined;
  return groups;
}

function ipv6ToBigInt(ip: string): bigint | undefined {
  const groups = expandIpv6(ip);
  if (!groups) return undefined;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

interface Cidr6 {
  base: bigint;
  bits: number;
}

function cidr6(base: string, bits: number): Cidr6 {
  const n = ipv6ToBigInt(base);
  if (n === undefined) throw new Error(`invalid built-in CIDR base: ${base}`);
  return { base: n, bits };
}

const BLOCKED_IPV6_RANGES: Cidr6[] = [
  cidr6("::", 128), // unspecified
  cidr6("::1", 128), // loopback
  cidr6("fc00::", 7), // unique local (ULA)
  cidr6("fe80::", 10), // link-local
];

function ipv6InRange(ip: bigint, cidr: Cidr6): boolean {
  if (cidr.bits === 0) return true;
  const shift = BigInt(128 - cidr.bits);
  return ip >> shift === cidr.base >> shift;
}

export function isBlockedIpv6(ip: string): boolean {
  const n = ipv6ToBigInt(ip);
  if (n === undefined) return true; // unparseable — fail closed
  if (BLOCKED_IPV6_RANGES.some((r) => ipv6InRange(n, r))) return true;
  // An IPv4-mapped address (::ffff:0:0/96) inherits the embedded IPv4
  // address's own classification, so "::ffff:169.254.169.254" is caught too.
  const top96 = n >> 32n;
  if (top96 === 0xffffn) {
    const embeddedIpv4 = Number(n & 0xffffffffn) >>> 0;
    return BLOCKED_IPV4_RANGES.some((r) => ipv4InRange(embeddedIpv4, r));
  }
  return false;
}

/** Classifies any resolved address string (as `node:dns` returns it) as
 * private/loopback/link-local/unique-local/CGNAT/metadata — fail-closed for
 * anything that doesn't even parse as an IP. */
export function isBlockedIp(ip: string): boolean {
  return ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

// --- host resolution + allowlist ---------------------------------------------

/** `OMAMORISAN_FETCH_ALLOWED_HOSTS` — a comma list of hostnames (matched
 * exactly, case-insensitively) exempted from the private-range check, for a
 * hosted deployment that legitimately needs to reach a non-public host. */
export function getAllowedHostsFromEnv(): Set<string> {
  const raw = process.env.OMAMORISAN_FETCH_ALLOWED_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Resolves `hostname` and throws `BlockedUrlError` if it names an
 * allowlisted-exempt host aside, any resolved address is blocked, or DNS
 * resolution itself fails (fail-closed — an unresolvable host is never
 * treated as safe). */
export async function assertPublicHost(hostname: string, allowedHosts: Set<string>): Promise<void> {
  if (allowedHosts.has(hostname.toLowerCase())) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new BlockedUrlError(`could not resolve host "${hostname}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`host "${hostname}" resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new BlockedUrlError(`host "${hostname}" resolves to a private/reserved address (${address}) — refused`);
    }
  }
}

// --- guarded fetch (manual redirect following, re-checked per hop) ----------

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Fetches `initialUrl`, re-validating the target host before every request —
 * including every redirect hop, since a plain `fetch` with its default
 * `redirect: "follow"` would otherwise walk straight through an unchecked
 * 3xx into a blocked address without this guard ever seeing it.
 */
export async function guardedFetch(initialUrl: string, init: RequestInit = {}, maxRedirects = DEFAULT_MAX_REDIRECTS): Promise<Response> {
  const allowedHosts = getAllowedHostsFromEnv();
  let currentUrl = initialUrl;

  for (let hop = 0; ; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BlockedUrlError(`unsupported URL scheme "${parsed.protocol}" — only http/https are allowed`);
    }
    await assertPublicHost(parsed.hostname, allowedHosts);

    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    if (res.type === "opaqueredirect") {
      throw new BlockedUrlError("redirect response gave no Location to re-validate (opaque redirect)");
    }
    if (!isRedirect) return res;

    const location = res.headers.get("location");
    if (!location) return res; // a 3xx with no Location — nothing to follow, hand it back as-is
    if (hop + 1 >= maxRedirects) {
      throw new BlockedUrlError(`too many redirects (max ${maxRedirects})`);
    }
    void res.body?.cancel().catch(() => {});
    currentUrl = new URL(location, currentUrl).toString();
  }
}
