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
  dashboardRoute: "/app/dashboard",
  /** The current (pre-`/app`) intent-signing screen, still served by the legacy Next.js app. */
  legacySigningUrl: "http://localhost:3000",
  network: "Base Sepolia",
  /** The firewall API this app talks to directly from the browser (P5): wallet
   * sign-in, mandate creation/listing/revocation. Astro only exposes
   * `PUBLIC_`-prefixed env vars to client code. */
  firewallUrl: (import.meta.env.PUBLIC_FIREWALL_URL as string | undefined) ?? "http://localhost:4001",
  /** The MCP server's Streamable HTTP endpoint (apps/mcp/README.md: port 4010,
   * `/mcp` path, agent key as a Bearer token), shown on the key handoff. */
  mcpUrl: (import.meta.env.PUBLIC_MCP_URL as string | undefined) ?? "http://localhost:4010/mcp",
} as const;

/**
 * Categories a mandate can authorize (P5). Matches the demo store's real
 * catalog (`apps/store/catalog.ts`) — the firewall's policy layer treats
 * `TaskIntent.categories` as free-form context for Jev, not a fixed enum, so
 * the wizard also lets a signer add a custom category alongside these.
 */
export const MANDATE_CATEGORY_OPTIONS = [
  { value: "gift_card:amazon", label: "Amazon gift cards" },
  { value: "gift_card:steam", label: "Steam gift cards" },
] as const;

/** Expiry presets offered by the mandate wizard (P5 brief). */
export const MANDATE_EXPIRY_PRESETS = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const;

/** Mirrors apps/mcp/README.md's "Claude Desktop / Cursor (mcpServers JSON)" stdio config exactly.
 * Legacy generic example. The handoff uses lib/mcpSetup.ts for client-specific downloads. */
export function mcpStdioConfigSnippet(agentKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        omamorisan: {
          command: "bun",
          args: ["/absolute/path/to/yakusoku/apps/mcp/index.ts"],
          env: { OMAMORISAN_AGENT_KEY: agentKey, OMAMORISAN_FIREWALL_URL: SITE.firewallUrl },
        },
      },
    },
    null,
    2,
  );
}

/** The landing's "Set up with Claude" section (`SetupClaude.astro`, right
 * after Developers): plain text with backtick-quoted tool/identifier names,
 * copied verbatim and also parsed for inline `<code>` styling — one string,
 * two uses. Interpolates `SITE.mcpUrl` so a deployed build always points at
 * its own MCP server. */
export function claudeSetupPrompt(): string {
  return `Set up ${SITE.name} so you can buy things for me safely. Add the ${SITE.name} MCP server (name \`omamorisan\`, Streamable HTTP transport, URL \`${SITE.mcpUrl}\`), then let me know when you're ready to reload MCP servers. Once it's connected, call \`connect\` and show me the World ID link and code so I can approve on my phone. From then on, whenever I ask you to buy something: call \`request_promise\` first with exactly what I asked for, a budget, and an expiry, wait for my approval, then pay only through \`pay_x402\`. Never retry a refused payment with different wording.`;
}

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
