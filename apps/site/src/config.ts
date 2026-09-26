// Single source of truth for product identity and cross-cutting links.
// Every mention of the product name or an external URL on the site reads
// from here, so a rename or a domain change touches exactly one file.

export const SITE = {
  name: "Omamorisan",
  tagline: "Your agent pays only for what you promised.",
  description:
    "A pre-signature firewall for AI agent payments. The agent never holds a key: every payment is checked against the intent you signed, before anything is signed.",
  githubUrl: "https://github.com/juanmaagd/yakusoku",
  appRoute: "/app",
  /** The current (pre-`/app`) intent-signing screen, still served by the legacy Next.js app. */
  legacySigningUrl: "http://localhost:3000",
  network: "Base Sepolia",
} as const;

export function basescanTx(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

// Verified on-chain evidence (PRODUCT.md, "Evidence on Hand"). Nothing else
// may be claimed as proof anywhere on the site.
export const EVIDENCE = {
  firstFirewallSignedPayment: "0xa6e1d2e08390e47654e3c64523f1fc16695633ce9bdeaf5f90b8e5f4acc26ac6",
  humanSignedIntentPurchase: "0xc85d39e616d1dbbd97d66606f12418c92d13843b2a73d5815b841fdd60e2059e",
  worldIdApprovedPayment: "0xbc77ac5b547301ade87d09651f15f550a2f5b5b3003befa310d5eab9d9280897",
} as const;
