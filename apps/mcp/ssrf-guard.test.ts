// IP-classification unit tests for the T2 SSRF guard (odd/tasks/dokploy-deploy.md).
// `assertPublicHost`/`guardedFetch` do real DNS/network I/O and are exercised
// through fetch_url/pay_x402 manually per that task's smoke test instead —
// this file only pins down `isBlockedIp`'s range boundaries.

import { describe, expect, test } from "bun:test";
import { isBlockedIp } from "./ssrf-guard";

function expectBlocked(cases: readonly [ip: string, why: string][]): void {
  for (const [ip, why] of cases) {
    test(`blocks ${ip} (${why})`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }
}

function expectAllowed(cases: readonly [ip: string, why: string][]): void {
  for (const [ip, why] of cases) {
    test(`allows ${ip} (${why})`, () => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  }
}

describe("isBlockedIp — IPv4", () => {
  expectBlocked([
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "private 10/8"],
    ["172.16.0.1", "private 172.16/12 (low end)"],
    ["172.31.255.255", "private 172.16/12 (high end)"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "link-local metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT (low end)"],
    ["100.127.255.255", "CGNAT (high end)"],
    ["0.0.0.0", "unspecified"],
  ]);

  expectAllowed([
    ["8.8.8.8", "public DNS"],
    ["1.1.1.1", "public DNS"],
    ["172.15.255.255", "just below the 172.16/12 private range"],
    ["172.32.0.0", "just above the 172.16/12 private range"],
    ["100.63.255.255", "just below the CGNAT range"],
    ["100.128.0.0", "just above the CGNAT range"],
    ["9.255.255.255", "just below 10/8"],
    ["11.0.0.0", "just above 10/8"],
  ]);
});

describe("isBlockedIp — IPv6", () => {
  expectBlocked([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local (ULA)"],
    ["fd12:3456:789a::1", "unique-local (ULA)"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::a9fe:a9fe", "NAT64 well-known /96, embedded metadata (169.254.169.254)"],
    ["64:ff9b::7f00:1", "NAT64 well-known /96, embedded loopback (127.0.0.1)"],
    ["64:ff9b:1:a9fe:a9:fe00::", "NAT64 local-use /48, embedded metadata (169.254.169.254)"],
  ]);

  expectAllowed([
    ["2606:4700:4700::1111", "public (Cloudflare)"],
    ["2001:4860:4860::8888", "public (Google)"],
    ["::ffff:8.8.8.8", "IPv4-mapped public"],
    ["64:ff9b::808:808", "NAT64 well-known /96, embedded public (8.8.8.8)"],
    ["64:ff9b:1:808:8:800::", "NAT64 local-use /48, embedded public (8.8.8.8)"],
  ]);
});

describe("isBlockedIp — malformed input fails closed", () => {
  expectBlocked([
    ["not-an-ip", "not an IP at all"],
    ["999.999.999.999", "out-of-range octets"],
    ["", "empty string"],
  ]);
});
