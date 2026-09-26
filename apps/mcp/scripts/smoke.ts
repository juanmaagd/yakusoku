#!/usr/bin/env bun
// Smoke test for the Omamorisan MCP server — drives it as a real MCP client
// would, over stdio, using the SDK's own Client. Spawns its OWN isolated
// store (:4040) and firewall (:4041, temp FIREWALL_DATA_DIR,
// OMAMORISAN_DEV_APPROVALS=1) so it never touches the developer's live
// :4000/:4001/:4010 servers or their sqlite data — same discipline as
// apps/firewall/scripts/scenarios.ts. Never settles a payment onchain.
//
// Covers THREE credential paths:
//   1. Legacy wallet mandate (`yk_`, WU-P2): mint via apps/agent's
//      dev-intent script, then get_mandate/fetch_url/pay_x402/check_approval.
//   2. World ID account (`ya_`, P9.3): connect -> (dev-approve) ->
//      check_connection -> get_mandate -> setup_account (P11.3a) ->
//      request_promise -> (dev-approve) -> check_promise -> list_promises ->
//      pay_x402 (legit, escalates to needs_human_approval — no
//      INTERCEPTA_API_KEY here) -> a second promise -> pay_x402 (steam-1,
//      KEY CASE, refused by Jev regardless of budget).
//   3. First-time no-credential request_promise (P9.6): request_promise with
//      NO prior connect creates the account AND activates this promise
//      together under one dev-approved World ID gate -> check_promise ->
//      get_mandate -> setup_account.
//   Dev-approval uses the isolated firewall's operator-only
//   `/dev/connect/:id/approve` / `/dev/promises/:id/approve` /
//   `/dev/promises/first/:id/approve` seams (never available on a live
//   firewall) instead of a real phone. `setup_account` only mints a link
//   here — it never posts a signature or deploys anything (that's
//   account-setup.test.ts's and scenarios.ts's S39-S42's job).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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

/**
 * P11.2 — a world_id promise now pays from its account's own smart account
 * (payer.ts's `resolvePayer`), so this smoke test must deploy one before
 * `pay_x402` can reach the same Intercepta/Jev/World-ID verdict it always
 * has. Direct HTTP calls, never an MCP tool: `setup_account` only mints the
 * link (P11.3a) — posting the owner's signature is the SITE's job in
 * reality, out of scope for the agent-facing MCP surface this file smoke-
 * tests. Reuses `setupUrl`'s own token rather than minting a second link.
 * Stub deployer + stub reader only (`main`'s spawned env below) — never on
 * the live firewall, no gas, no real chain state.
 */
async function deploySmartAccountFromSetupUrl(setupUrl: string, accountId: string): Promise<string> {
  const token = new URL(setupUrl).searchParams.get("token");
  if (!token) throw new Error(`setupUrl has no token query param: ${setupUrl}`);

  const statusRes = await fetch(`${FIREWALL_URL}/setup/${token}`);
  const status = (await statusRes.json().catch(() => ({}))) as { message?: string };
  if (statusRes.status !== 200 || !status.message) throw new Error(`GET /setup/${token} failed: HTTP ${statusRes.status}`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const signature = await owner.signMessage({ message: status.message.replace("{owner}", owner.address) });

  const deployRes = await fetch(`${FIREWALL_URL}/setup/${token}/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner.address, signature }),
  });
  const deployed = (await deployRes.json().catch(() => ({}))) as { smartAccount?: string; error?: string };
  if (deployRes.status !== 200 || !deployed.smartAccount) {
    throw new Error(`POST /setup/${token}/owner failed: HTTP ${deployRes.status} ${JSON.stringify(deployed)}`);
  }

  // Mark it healthy for the stub reader — the DEFAULT deployed recipient
  // allow-list is empty in this smoke test (no MERCHANT_ADDRESS/_KEY or
  // OMAMORISAN_DEFAULT_RECIPIENTS override for its spawned firewall), so
  // without this override every pay_x402 call below would refuse
  // `recipient_not_registered` instead of reaching Intercepta/Jev/World ID.
  const healthRes = await fetch(`${FIREWALL_URL}/dev/accounts/${accountId}/health`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ recipientAllowed: true }),
  });
  if (healthRes.status !== 200) throw new Error(`POST /dev/accounts/${accountId}/health failed: HTTP ${healthRes.status}`);

  return deployed.smartAccount;
}

/** P9.6's combined connect+promise gate — a nested path, so its own helper
 * rather than widening `devApprove`'s `kind` union. */
async function devApproveFirstPromise(id: string, subject: string): Promise<void> {
  const res = await fetch(`${FIREWALL_URL}/dev/promises/first/${id}/approve`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ subject }),
  });
  if (res.status !== 200) throw new Error(`dev-approve promises/first/${id} failed: HTTP ${res.status}`);
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

    printStep("[account] setup_account (P11.3a — expect a setupUrl, no smart account deployed yet)");
    const setup = await callTool(client, "setup_account", {});
    const setupUrl = typeof setup.data.setupUrl === "string" ? (setup.data.setupUrl as string) : undefined;
    console.log(setupUrl?.includes("/setup?token=") ? "PASS: got a setup link" : `FAIL: expected a setupUrl, got ${JSON.stringify(setup.data)}`);

    printStep("[account] deploying + funding-marking-healthy the smart account (P11.2, out-of-band — the site's job in reality)");
    if (!setupUrl) throw new Error("no setupUrl to deploy from");
    const accountId = connected.data.accountId as string;
    const smartAccount = await deploySmartAccountFromSetupUrl(setupUrl, accountId);
    console.log(`PASS: deployed ${smartAccount} (stub — never really on-chain) and marked healthy`);

    printStep("[account] request_promise (expect pending — nobody has dev-approved yet)");
    const promiseStart = await callTool(client, "request_promise", {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budgetUsdc: 1,
      categories: ["gift_card:amazon"],
      expiresInMinutes: 30,
      merchant: STORE_URL,
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
      merchant: STORE_URL,
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

// --- P9.6 no-credential request_promise (single-approval account+promise) ---

async function runFirstTimePromiseSmoke(credentialsDir: string): Promise<void> {
  const credentialsFile = join(credentialsDir, "credentials-first-time.json");
  const subject = `smoke-subject-first-time-${crypto.randomUUID()}`;

  const env: Record<string, string> = { ...(process.env as Record<string, string>), OMAMORISAN_FIREWALL_URL: FIREWALL_URL, OMAMORISAN_CREDENTIALS_FILE: credentialsFile };
  delete env.OMAMORISAN_AGENT_KEY; // this session starts with no credential at all — connect is never called
  const client = await connectClient(env);
  try {
    printStep("[first-time] request_promise with NO credential at all (expect pending — one World ID approval creates the account AND this promise together)");
    const start = await callTool(client, "request_promise", {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budgetUsdc: 1,
      categories: ["gift_card:amazon"],
      expiresInMinutes: 30,
      merchant: STORE_URL,
    });
    const promiseId = start.data.promiseId as string | undefined;
    if (start.data.status !== "pending" || !promiseId) {
      throw new Error(`expected request_promise (no credential) to return pending+promiseId, got ${JSON.stringify(start.data)}`);
    }

    printStep("[first-time] dev-approving the combined connect+promise request");
    await devApproveFirstPromise(promiseId, subject);

    printStep("[first-time] check_promise (expect active — the account was created and this promise activated in ONE approval)");
    const active = await callTool(client, "check_promise", { promiseId });
    console.log(active.data.status === "active" ? "PASS: active" : `FAIL: expected active, got ${active.data.status}`);

    printStep("[first-time] get_mandate (expect the freshly created account with this one promise)");
    await callTool(client, "get_mandate", {});

    printStep("[first-time] setup_account (expect a setupUrl now that this session holds an account credential)");
    const setup = await callTool(client, "setup_account", {});
    console.log(
      typeof setup.data.setupUrl === "string" && (setup.data.setupUrl as string).includes("/setup?token=")
        ? "PASS: got a setup link"
        : `FAIL: expected a setupUrl, got ${JSON.stringify(setup.data)}`,
    );

    printStep("[first-time] credentials file — confirming the account key delivered by check_promise was persisted");
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
    // Every `pay_x402` call below expects `needs_human_approval` (this
    // suite's stub-deployed smart account has no real on-chain code, so a
    // `pay` verdict would try to actually settle a signature nothing can
    // verify) — deterministic regardless of whether the shell this script
    // itself was launched from (`bun run smoke`'s `--env-file`) happens to
    // export a real INTERCEPTA_API_KEY.
    INTERCEPTA_API_KEY: "",
    // Only ever enabled on THIS isolated, temp-data-dir firewall — never on
    // the live :4001 firewall (index.ts logs a loud boot warning either
    // way). Lets this smoke test dev-approve connect/promise requests
    // without a real phone.
    OMAMORISAN_DEV_APPROVALS: "1",
    // P11.2: the account path deploys a smart account (no gas) and drives
    // its funding-stage health via the stub reader instead of real chain
    // state — same discipline as apps/firewall/scripts/scenarios.ts.
    OMAMORISAN_ACCOUNT_DEPLOYER: "stub",
    OMAMORISAN_ACCOUNT_READER: "stub",
  });

  let exitCode = 0;
  try {
    await waitForHttp(`${STORE_URL}/catalog`);
    await waitForHttp(`${FIREWALL_URL}/intents`);
    console.log("[smoke] store + firewall are up\n");

    await runWalletPathSmoke();
    await runAccountPathSmoke(credentialsDir);
    await runFirstTimePromiseSmoke(credentialsDir);
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
