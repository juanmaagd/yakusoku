// DEV-ONLY mock of the firewall's `/setup/:token` contract (P11.4 QA only —
// never imported by the shipped page). The real routes are built in parallel
// on `apps/firewall`; this exists only so `/setup` can be exercised before
// that lands. Run standalone:
//
//   cd apps/site && bun run scripts/mock-setup-api.ts
//   PUBLIC_FIREWALL_URL=http://localhost:4052 bunx astro dev --port 4323
//
// Excluded from `astro check` (see ../tsconfig.json) so Bun-only globals here
// don't need `@types/bun` added to this package's real dependencies.

import { getAddress, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from "viem";

const PORT = 4052;
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const FACTORY = "0xadBe165CCc90e59e38A3dE68a25E99Ec807501cc" as const;

/** Deterministic fake address from a seed string — dev-only, never a real deployment. */
function fakeAddress(seed: string): Address {
  return getAddress(`0x${keccak256(stringToHex(seed)).slice(-40)}`);
}

const OPERATOR = fakeAddress("mock-operator");
/** Owner of the `demo-deployed` seed record — overridable so a QA session's
 * throwaway wallet shows up as the owner (unlocking withdraw/pause) without
 * hardcoding one specific address into committed source. */
const DEMO_OWNER = (process.env.DEMO_OWNER_ADDRESS as Address | undefined) ?? fakeAddress("demo-owner");

interface SetupRecord {
  status: "needs_owner" | "deployed";
  accountId: string;
  perPaymentLimitUsdc: string;
  recipients: { address: Address; label: string }[];
  /** Contains the literal `{owner}` placeholder, exactly like the real contract. */
  messageTemplate: string;
  owner?: Address;
  smartAccount?: Address;
  balanceUsdc?: string;
  expiresAt: string;
}

function inThirtyMinutes(): string {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

// Seed a couple of fixed demo tokens for manual QA. Any other token 404s.
const store = new Map<string, SetupRecord>([
  [
    "demo-needs-owner",
    {
      status: "needs_owner",
      accountId: "acct_demo_needs_owner",
      perPaymentLimitUsdc: "5.00",
      recipients: [
        { address: fakeAddress("merchant-gift-cards"), label: "Demo Gift Card Store" },
        { address: fakeAddress("merchant-amazon"), label: "Amazon Gift Cards (demo)" },
      ],
      messageTemplate:
        "I authorize {owner} as the owner of my Omamori smart account (acct_demo_needs_owner) on Base Sepolia (chain 84532). Omamori may pay only the merchants I've registered, up to 5.00 USDC per payment, until I pause or withdraw.",
      expiresAt: inThirtyMinutes(),
    },
  ],
  [
    "demo-deployed",
    {
      status: "deployed",
      accountId: "acct_demo_deployed",
      perPaymentLimitUsdc: "5.00",
      recipients: [{ address: fakeAddress("merchant-gift-cards"), label: "Demo Gift Card Store" }],
      messageTemplate: "I authorize {owner} as the owner of my Omamori smart account (acct_demo_deployed) on Base Sepolia (chain 84532).",
      owner: DEMO_OWNER,
      smartAccount: fakeAddress("demo-deployed-account"),
      balanceUsdc: "0.00",
      expiresAt: inThirtyMinutes(),
    },
  ],
]);

function cors(headers: HeadersInit = {}): HeadersInit {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", ...headers };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: cors({ "content-type": "application/json" }) });
}

function setupPayload(record: SetupRecord) {
  return {
    status: record.status,
    accountId: record.accountId,
    chainId: CHAIN_ID,
    usdc: USDC,
    factory: FACTORY,
    operator: OPERATOR,
    perPaymentLimitUsdc: record.perPaymentLimitUsdc,
    recipients: record.recipients,
    message: record.messageTemplate,
    ...(record.status === "deployed" ? { smartAccount: record.smartAccount, owner: record.owner, balanceUsdc: record.balanceUsdc } : {}),
    expiresAt: record.expiresAt,
  };
}

/** Artificial delay so the client's "Deploying your account…" progress state
 * is actually observable during manual/QA review instead of resolving instantly. */
const DEPLOY_DELAY_MS = 1200;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const getMatch = /^\/setup\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && getMatch) {
      const record = store.get(decodeURIComponent(getMatch[1]!));
      if (!record) return json({ error: "not_found" }, 404);
      return json(setupPayload(record));
    }

    const postMatch = /^\/setup\/([^/]+)\/owner$/.exec(url.pathname);
    if (req.method === "POST" && postMatch) {
      const token = decodeURIComponent(postMatch[1]!);
      const record = store.get(token);
      if (!record) return json({ error: "not_found" }, 404);

      const body = (await req.json().catch(() => undefined)) as { owner?: string; signature?: string } | undefined;
      if (!body?.owner || !body.signature?.startsWith("0x")) {
        return json({ error: "invalid_request", message: "owner and signature are required" }, 400);
      }

      const expectedMessage = record.messageTemplate.replace("{owner}", body.owner);
      try {
        const recovered = await recoverMessageAddress({ message: expectedMessage, signature: body.signature as Hex });
        if (recovered.toLowerCase() !== body.owner.toLowerCase()) return json({ error: "invalid_signature" }, 401);
      } catch {
        return json({ error: "invalid_signature" }, 401);
      }

      if (record.status !== "deployed") {
        await Bun.sleep(DEPLOY_DELAY_MS);
        record.owner = getAddress(body.owner);
        record.smartAccount = fakeAddress(`deployed-${token}`);
        record.balanceUsdc = "0.00";
        record.status = "deployed";
      }

      return json({ status: "deployed", smartAccount: record.smartAccount, owner: record.owner, txHash: fakeAddress(`tx-${token}-${Date.now()}`).padEnd(66, "0") });
    }

    return json({ error: "not_found" }, 404);
  },
});

console.log(`[mock-setup-api] DEV ONLY — listening on http://localhost:${PORT}`);
console.log(`[mock-setup-api] GET  http://localhost:${PORT}/setup/demo-needs-owner`);
console.log(`[mock-setup-api] GET  http://localhost:${PORT}/setup/demo-deployed`);
console.log(`[mock-setup-api] Point the site at it: PUBLIC_FIREWALL_URL=http://localhost:${PORT}`);
