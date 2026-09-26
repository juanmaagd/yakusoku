#!/usr/bin/env bun
// Smoke test for the Omamorisan MCP server (WU-P2) — drives it as a real MCP
// client would, over stdio, using the SDK's own Client. Mints its own 1 USDC
// mandate via apps/agent's dev-intent script against the LIVE firewall
// (:4001, owned by the parent session — this script never spawns its own
// store/firewall), then exercises all four tools against the LIVE store
// (:4000). Never settles a payment: tonight has no INTERCEPTA_API_KEY, so
// the "legit" purchase escalates to a pending World ID approval instead of
// paying, and check_approval is polled exactly once while it's still pending.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_DIR = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = join(MCP_DIR, "..", "agent");
const STORE_URL = process.env.STORE_URL ?? "http://localhost:4000";
const FIREWALL_URL = process.env.OMAMORISAN_FIREWALL_URL ?? "http://localhost:4001";

interface Mandate {
  intentId: string;
  agentKey: string;
}

/** Signs and registers a fresh 1 USDC "Amazon gift card (rehearsal)" mandate
 * against the live firewall, the same way a human would via apps/web —
 * apps/agent/scripts/dev-intent.ts already does exactly this. */
async function mintMandate(): Promise<Mandate> {
  const proc = Bun.spawn(
    ["bun", "run", "dev-intent", "--", "Buy a $1 Amazon gift card (rehearsal)", "1", "gift_card:amazon"],
    { cwd: AGENT_DIR, env: { ...process.env, FIREWALL_URL }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`dev-intent failed (exit ${exitCode}): ${stderr || stdout}`);

  const idMatch = /\[dev-intent\] intent id: (\S+)/.exec(stdout);
  const keyMatch = /agent key \([^)]*\): (\S+)/.exec(stdout);
  if (!idMatch?.[1] || !keyMatch?.[1]) throw new Error(`could not parse dev-intent output:\n${stdout}`);
  return { intentId: idMatch[1], agentKey: keyMatch[1] };
}

function printStep(title: string): void {
  console.log(`\n=== ${title} ===`);
}

interface ToolCallResult {
  isError: boolean;
  data: unknown;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = first && first.type === "text" ? first.text : JSON.stringify(result.content);
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Error results are plain text, not JSON — kept as-is.
  }
  console.log(`[${name}] isError=${Boolean(result.isError)}`);
  console.log(JSON.stringify(data, null, 2));
  return { isError: Boolean(result.isError), data };
}

async function main(): Promise<void> {
  printStep("minting a 1 USDC mandate via dev-intent (live firewall)");
  const mandate = await mintMandate();
  console.log(`intent=${mandate.intentId}`);

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["index.ts", "--stdio"],
    cwd: MCP_DIR,
    env: {
      ...(process.env as Record<string, string>),
      OMAMORISAN_AGENT_KEY: mandate.agentKey,
      OMAMORISAN_FIREWALL_URL: FIREWALL_URL,
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "omamorisan-smoke", version: "0.1.0" });
  await client.connect(transport);

  try {
    printStep("tools/list");
    const { tools } = await client.listTools();
    console.log(tools.map((t) => t.name).join(", "));

    printStep("get_mandate");
    await callTool(client, "get_mandate", {});

    printStep("fetch_url — store catalog");
    await callTool(client, "fetch_url", { url: `${STORE_URL}/catalog` });

    printStep("fetch_url — amazon-1-rehearsal promo page (KEY CASE #9 trap)");
    await callTool(client, "fetch_url", { url: `${STORE_URL}/promo/amazon-1-rehearsal` });

    printStep("pay_x402 — steam-1 (expect refused: wrong item, caught by Jev)");
    const steam = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/steam-1`,
      justification: "The checkout page offered to add a Steam gift card to the same order.",
    });
    const steamStatus = (steam.data as { status?: string }).status;
    console.log(steamStatus === "refused" ? "PASS: refused as expected" : `FAIL: expected refused, got ${steamStatus}`);

    printStep("pay_x402 — amazon-1-rehearsal (expect needs_human_approval: no Intercepta key tonight)");
    const amazon = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/amazon-1-rehearsal`,
      justification: "Exact match for the signed intent.",
    });
    const amazonData = amazon.data as { status?: string; receiptId?: string; verificationUri?: string };
    console.log(
      amazonData.status === "needs_human_approval" && amazonData.verificationUri
        ? "PASS: needs_human_approval with a real verificationUri"
        : `FAIL: expected needs_human_approval with a verificationUri, got ${JSON.stringify(amazonData)}`,
    );

    if (amazonData.receiptId) {
      printStep("check_approval — poll once (expect still pending; never settles)");
      const approval = await callTool(client, "check_approval", { receiptId: amazonData.receiptId });
      const approvalStatus = (approval.data as { status?: string }).status;
      console.log(approvalStatus === "pending" ? "PASS: still pending" : `FAIL: expected pending, got ${approvalStatus}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
