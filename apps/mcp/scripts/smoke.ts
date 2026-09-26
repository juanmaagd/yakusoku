#!/usr/bin/env bun
// Smoke test for the Omamorisan MCP server — drives it as a real MCP client
// would, over stdio, using the SDK's own Client. Spawns its OWN isolated
// store (:4040) and firewall (:4041, temp FIREWALL_DATA_DIR,
// OMAMORISAN_DEV_APPROVALS=1) so it never touches the developer's live
// :4000/:4001/:4010 servers or their sqlite data — same discipline as
// apps/firewall/scripts/scenarios.ts. Never settles a payment onchain.
//
// Covers TWO credential paths:
//   1. Legacy wallet mandate (`yk_`, WU-P2): mint via apps/agent's
//      dev-intent script, then get_mandate/fetch_url/pay_x402/check_approval.
//   2. World ID account (`ya_`, P9.3): connect -> (dev-approve) ->
//      check_connection -> get_mandate -> request_promise -> (dev-approve) ->
//      check_promise -> list_promises -> pay_x402 (legit, escalates to
//      needs_human_approval — no INTERCEPTA_API_KEY here) -> a second promise
//      -> pay_x402 (steam-1, KEY CASE, refused by Jev regardless of budget).
//   Dev-approval uses the isolated firewall's operator-only
//   `/dev/connect/:id/approve` / `/dev/promises/:id/approve` seam (never
//   available on a live firewall) instead of a real phone.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_DIR = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = join(MCP_DIR, "..", "agent");
const REPO_ROOT = join(MCP_DIR, "..", "..");
const STORE_DIR = join(REPO_ROOT, "apps", "store");
const FIREWALL_DIR = join(REPO_ROOT, "apps", "firewall");

const STORE_PORT = 4040;
const FIREWALL_PORT = 4041;
const STORE_URL = `http://localhost:${STORE_PORT}`;
const FIREWALL_URL = `http://localhost:${FIREWALL_PORT}`;
const ADMIN_HEADERS = { "x-yakusoku-admin": "1", "content-type": "application/json" };

function printStep(title: string): void {
  console.log(`\n=== ${title} ===`);
}

interface ToolCallResult {
  isError: boolean;
  data: Record<string, unknown>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = first && first.type === "text" ? first.text : JSON.stringify(result.content);
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Error results are plain text, not JSON — kept as a { message } shape.
    data = { message: text };
  }
  console.log(`[${name}] isError=${Boolean(result.isError)}`);
  console.log(JSON.stringify(data, null, 2));
  return { isError: Boolean(result.isError), data: data as Record<string, unknown> };
}

function connectClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: "bun", args: ["index.ts"], cwd: MCP_DIR, env, stderr: "inherit" });
  const client = new Client({ name: "omamorisan-smoke", version: "0.1.0" });
  return client.connect(transport).then(() => client);
}

// --- legacy wallet mandate path (WU-P2, unchanged behavior) ------------------

interface Mandate {
  intentId: string;
  agentKey: string;
}

/** Signs and registers a fresh 1 USDC "Amazon gift card (rehearsal)" mandate
 * against THIS isolated firewall, the same way a human would via the site's
 * /app — apps/agent/scripts/dev-intent.ts already does exactly this. */
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

async function runWalletPathSmoke(): Promise<void> {
  printStep("[wallet] minting a 1 USDC mandate via dev-intent");
  const mandate = await mintMandate();
  console.log(`intent=${mandate.intentId}`);

  const client = await connectClient({
    ...(process.env as Record<string, string>),
    OMAMORISAN_AGENT_KEY: mandate.agentKey,
    OMAMORISAN_FIREWALL_URL: FIREWALL_URL,
  });
  try {
    printStep("[wallet] tools/list");
    const { tools } = await client.listTools();
    console.log(tools.map((t) => t.name).join(", "));

    printStep("[wallet] get_mandate");
    await callTool(client, "get_mandate", {});

    printStep("[wallet] fetch_url — store catalog");
    await callTool(client, "fetch_url", { url: `${STORE_URL}/catalog` });

    printStep("[wallet] fetch_url — amazon-1-rehearsal promo page (KEY CASE #9 trap)");
    await callTool(client, "fetch_url", { url: `${STORE_URL}/promo/amazon-1-rehearsal` });

    printStep("[wallet] pay_x402 — steam-1 (expect refused: wrong item, caught by Jev)");
    const steam = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/steam-1`,
      justification: "The checkout page offered to add a Steam gift card to the same order.",
    });
    console.log(steam.data.status === "refused" ? "PASS: refused as expected" : `FAIL: expected refused, got ${steam.data.status}`);

    printStep("[wallet] pay_x402 — amazon-1-rehearsal (expect needs_human_approval: no Intercepta key here)");
    const amazon = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/amazon-1-rehearsal`,
      justification: "Exact match for the signed intent.",
    });
    console.log(
      amazon.data.status === "needs_human_approval" && amazon.data.verificationUri
        ? "PASS: needs_human_approval with a real verificationUri"
        : `FAIL: expected needs_human_approval with a verificationUri, got ${JSON.stringify(amazon.data)}`,
    );

    if (amazon.data.receiptId) {
      printStep("[wallet] check_approval — poll once (expect still pending; never settles)");
      const approval = await callTool(client, "check_approval", { receiptId: amazon.data.receiptId as string });
      console.log(approval.data.status === "pending" ? "PASS: still pending" : `FAIL: expected pending, got ${approval.data.status}`);
    }
  } finally {
    await client.close();
  }
}

// --- P9.3 World ID account path ----------------------------------------------

async function devApprove(kind: "connect" | "promises", id: string, subject: string): Promise<void> {
  const res = await fetch(`${FIREWALL_URL}/dev/${kind}/${id}/approve`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ subject }),
  });
  if (res.status !== 200) throw new Error(`dev-approve ${kind}/${id} failed: HTTP ${res.status}`);
}

async function runAccountPathSmoke(credentialsDir: string): Promise<void> {
  const credentialsFile = join(credentialsDir, "credentials.json");
  const subject = `smoke-subject-${crypto.randomUUID()}`;

  const env: Record<string, string> = { ...(process.env as Record<string, string>), OMAMORISAN_FIREWALL_URL: FIREWALL_URL, OMAMORISAN_CREDENTIALS_FILE: credentialsFile };
  delete env.OMAMORISAN_AGENT_KEY; // this session starts with no credential at all — the whole point of this path
  const client = await connectClient(env);
  try {
    printStep("[account] get_mandate before connect (expect a clear 'call connect' error)");
    const before = await callTool(client, "get_mandate", {});
    console.log(before.isError ? "PASS: no credential yet" : "FAIL: expected an error before connect");

    printStep("[account] connect (expect pending — nobody has dev-approved yet)");
    const connectStart = await callTool(client, "connect", {});
    const connectId = connectStart.data.connectId as string | undefined;
    if (connectStart.data.status !== "pending" || !connectId) {
      throw new Error(`expected connect to return pending+connectId, got ${JSON.stringify(connectStart.data)}`);
    }

    printStep("[account] dev-approving the connect request");
    await devApprove("connect", connectId, subject);

    printStep("[account] check_connection (expect connected — account key stored in the credentials file)");
    const connected = await callTool(client, "check_connection", {});
    console.log(connected.data.status === "connected" ? "PASS: connected" : `FAIL: expected connected, got ${connected.data.status}`);

    printStep("[account] get_mandate (account path — expect {accountId, createdAt, promises: []})");
    await callTool(client, "get_mandate", {});

    printStep("[account] request_promise (expect pending — nobody has dev-approved yet)");
    const promiseStart = await callTool(client, "request_promise", {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budgetUsdc: 1,
      categories: ["gift_card:amazon"],
      expiresInMinutes: 30,
    });
    const promiseId = promiseStart.data.promiseId as string | undefined;
    if (promiseStart.data.status !== "pending" || !promiseId) {
      throw new Error(`expected request_promise to return pending+promiseId, got ${JSON.stringify(promiseStart.data)}`);
    }

    printStep("[account] dev-approving the promise (SAME subject as connect — must match the account's own World ID sub)");
    await devApprove("promises", promiseId, subject);

    printStep("[account] check_promise (expect active)");
    const promiseActive = await callTool(client, "check_promise", { promiseId });
    console.log(promiseActive.data.status === "active" ? "PASS: promise active" : `FAIL: expected active, got ${promiseActive.data.status}`);

    printStep("[account] list_promises (expect exactly this one, active)");
    await callTool(client, "list_promises", {});

    printStep("[account] pay_x402 — legit resource, promiseId omitted (auto-selects the one active promise)");
    const legit = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/amazon-1-rehearsal`,
      justification: "The human asked for a $1 Amazon gift card (rehearsal) — matches the promise task exactly.",
    });
    console.log(
      legit.data.status === "needs_human_approval" && legit.data.autoSelectedPromise === true
        ? "PASS: needs_human_approval (no Intercepta key here), auto-selected the one active promise"
        : `FAIL: expected needs_human_approval with autoSelectedPromise, got ${JSON.stringify(legit.data)}`,
    );

    // A second, independent promise so the steam-1 KEY CASE below is refused
    // by Jev (task mismatch), not by the first promise's budget already
    // being reserved behind its own pending World ID approval.
    printStep("[account] request_promise #2 (for the KEY CASE test)");
    const promise2Start = await callTool(client, "request_promise", {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budgetUsdc: 1,
      categories: ["gift_card:amazon"],
      expiresInMinutes: 30,
    });
    const promise2Id = promise2Start.data.promiseId as string | undefined;
    if (!promise2Id) throw new Error(`expected a promiseId, got ${JSON.stringify(promise2Start.data)}`);
    await devApprove("promises", promise2Id, subject);
    await callTool(client, "check_promise", { promiseId: promise2Id });

    printStep("[account] pay_x402 — steam-1 under promise #2 (KEY CASE, expect refused by Jev)");
    const steam = await callTool(client, "pay_x402", {
      url: `${STORE_URL}/giftcard/steam-1`,
      justification: "The checkout page offered to add a Steam gift card to the same order.",
      promiseId: promise2Id,
    });
    console.log(steam.data.status === "refused" ? "PASS: refused as expected" : `FAIL: expected refused, got ${steam.data.status}`);

    printStep("[account] credentials file — confirming the account key was persisted (never echoed by any tool above)");
    console.log(await Bun.file(credentialsFile).text());
  } finally {
    await client.close();
  }
}

// --- process orchestration (isolated store + firewall, mirrors scenarios.ts) -

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server at ${url} did not become ready in time: ${String(lastErr)}`);
}

function spawnService(label: string, cwd: string, env: Record<string, string>): Bun.Subprocess {
  console.log(`[smoke] starting ${label} (cwd=${cwd})...`);
  return Bun.spawn(["bun", "index.ts"], { cwd, env: { ...process.env, ...env } as Record<string, string>, stdout: "inherit", stderr: "inherit" });
}

async function main(): Promise<void> {
  const firewallDataDir = mkdtempSync(join(tmpdir(), "yakusoku-mcp-smoke-firewall-"));
  const credentialsDir = mkdtempSync(join(tmpdir(), "yakusoku-mcp-smoke-credentials-"));
  console.log(`[smoke] temp FIREWALL_DATA_DIR: ${firewallDataDir}`);
  console.log(`[smoke] temp credentials dir: ${credentialsDir}`);

  const storeProc = spawnService("store", STORE_DIR, { PORT: String(STORE_PORT) });
  const firewallProc = spawnService("firewall", FIREWALL_DIR, {
    PORT: String(FIREWALL_PORT),
    FIREWALL_DATA_DIR: firewallDataDir,
    WORLD_ID_APPROVAL_TIMEOUT_S: "60",
    // Only ever enabled on THIS isolated, temp-data-dir firewall — never on
    // the live :4001 firewall (index.ts logs a loud boot warning either
    // way). Lets this smoke test dev-approve connect/promise requests
    // without a real phone.
    OMAMORISAN_DEV_APPROVALS: "1",
  });

  let exitCode = 0;
  try {
    await waitForHttp(`${STORE_URL}/catalog`);
    await waitForHttp(`${FIREWALL_URL}/intents`);
    console.log("[smoke] store + firewall are up\n");

    await runWalletPathSmoke();
    await runAccountPathSmoke(credentialsDir);
  } catch (err) {
    console.error("[smoke] failed:", err);
    exitCode = 1;
  } finally {
    console.log("\n[smoke] cleaning up...");
    storeProc.kill();
    firewallProc.kill();
    await Promise.all([storeProc.exited, firewallProc.exited]);
    rmSync(firewallDataDir, { recursive: true, force: true });
    rmSync(credentialsDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main();
