#!/usr/bin/env bun
// Independent post-hoc payment verifier (WU14). Its whole point is to NOT
// trust the firewall's own database: it reads Base Sepolia directly for
// every outgoing USDC transfer the firewall wallet ever sent, reads the
// firewall's DecisionReceipt history over HTTP, and cross-checks the two.
// A receipt claiming "pay" must be backed by a real on-chain transfer with
// the right recipient and amount; a receipt claiming "refuse" must NOT be
// backed by one; and any on-chain transfer the receipts don't explain at
// all (e.g. the private key used outside the firewall) is flagged. Never
// sends a transaction — read-only by construction.

import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_DECIMALS, USDC_SEPOLIA_ADDRESS, verifyStepUpAttestation, type DecisionReceipt } from "@yakusoku/shared";

const BLOCK_CHUNK = 1000n; // eth_getLogs range limit on the public Base Sepolia RPC
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const SIGNED_STALE_MS = 5 * 60 * 1000; // "signed but never settled" grace period
const REFUSED_MATCH_WINDOW_MS = 10 * 60 * 1000; // rule 6: how close a transfer must be to a refusal to count as "anyway"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// --- CLI args ----------------------------------------------------------------

interface Args {
  firewall: string;
  fromBlock?: bigint;
  last: number;
  wallet?: Address;
  json: boolean;
}

function readFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  const fromBlockArg = readFlag(argv, "--from-block");
  const walletArg = readFlag(argv, "--wallet");
  const lastArg = readFlag(argv, "--last");
  const firewallArg = readFlag(argv, "--firewall");
  // Default high so the "pre-persistence" cutoff uses the true earliest receipt.
  const last = lastArg ? Number(lastArg) : 10_000;
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`invalid --last value: ${lastArg}`);
  }
  return {
    firewall: firewallArg ?? "http://localhost:4001",
    fromBlock: fromBlockArg !== undefined ? BigInt(fromBlockArg) : undefined,
    last,
    wallet: walletArg ? (walletArg as Address) : undefined,
    json: argv.includes("--json"),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name} — set it in .env.hackathon, or pass --wallet`);
  return value;
}

// --- chain reads ---------------------------------------------------------------

// A plain `ReturnType<typeof createPublicClient>` resolves to the function's
// generic (unapplied) overload and produces spurious mismatches against the
// concrete client below — go through a factory with fixed chain/transport
// args instead so the alias matches what `createClient()` actually returns.
function createClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
}
type PublicClient = ReturnType<typeof createClient>;

interface OnChainTransfer {
  txHash: Hex;
  blockNumber: bigint;
  to: Address;
  value: bigint;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/** Chunked `eth_getLogs` sweep of every outgoing USDC transfer from `wallet`
 * in `[fromBlock, toBlock]` — the public RPC caps a single call at 1,000
 * blocks. A chunk that still fails after retries is skipped with a warning
 * rather than aborting the whole run (best-effort coverage over a hard stop). */
async function sweepOutgoingTransfers(
  client: PublicClient,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<OnChainTransfer[]> {
  const transfers: OnChainTransfer[] = [];
  for (let start = fromBlock; start <= toBlock; start += BLOCK_CHUNK) {
    const end = start + BLOCK_CHUNK - 1n > toBlock ? toBlock : start + BLOCK_CHUNK - 1n;
    try {
      const logs = await withRetry(
        () =>
          client.getLogs({
            address: USDC_SEPOLIA_ADDRESS,
            event: TRANSFER_EVENT,
            args: { from: wallet },
            fromBlock: start,
            toBlock: end,
          }),
        `getLogs(${start}-${end})`,
      );
      for (const log of logs) {
        if (log.args.to === undefined || log.args.value === undefined) continue; // malformed log, skip defensively
        transfers.push({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          to: log.args.to,
          value: log.args.value,
        });
      }
    } catch (err) {
      console.error(
        `[verifier] WARNING: giving up on block range ${start}-${end} after ${RETRY_ATTEMPTS} attempts — ` +
          `coverage for this window is incomplete.`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return transfers;
}

function decodeUsdcTransfer(log: Log): { from: Address; to: Address; value: bigint } | undefined {
  if (log.address.toLowerCase() !== USDC_SEPOLIA_ADDRESS.toLowerCase()) return undefined;
  try {
    const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    return { from: decoded.args.from, to: decoded.args.to, value: decoded.args.value };
  } catch {
    return undefined; // not a Transfer log (wrong topic0/shape)
  }
}

type SettlementCheck =
  | { status: "confirmed"; transfer: OnChainTransfer }
  | { status: "mismatch"; transfer: OnChainTransfer }
  | { status: "reverted" }
  | { status: "not_found" };

/** Verifies one receipt's reported settlement hash directly against the
 * chain (not just the swept window) — a real tx can exist outside the
 * `--from-block` window and should still be confirmable. */
async function verifySettlement(
  client: PublicClient,
  hash: Hex,
  wallet: Address,
  expectedTo: Address,
  expectedValue: bigint,
): Promise<SettlementCheck> {
  let receipt;
  try {
    receipt = await withRetry(() => client.getTransactionReceipt({ hash }), `getTransactionReceipt(${hash})`);
  } catch {
    return { status: "not_found" };
  }
  if (receipt.status === "reverted") return { status: "reverted" };

  const walletLower = wallet.toLowerCase();
  for (const log of receipt.logs) {
    const decoded = decodeUsdcTransfer(log);
    if (!decoded || decoded.from.toLowerCase() !== walletLower) continue;
    const transfer: OnChainTransfer = { txHash: hash, blockNumber: receipt.blockNumber, to: decoded.to, value: decoded.value };
    const matches = decoded.to.toLowerCase() === expectedTo.toLowerCase() && decoded.value === expectedValue;
    return matches ? { status: "confirmed", transfer } : { status: "mismatch", transfer };
  }
  return { status: "not_found" };
}

// --- StepUp attestation verification (WU12) ------------------------------------
// For a Confirmed receipt (its settlement hash matched on-chain) that also
// carries a StepUp attestation (a World ID-approved payment, approvals.ts),
// independently verify that attestation the same way the on-chain settlement
// itself is verified: never trust the firewall's own "approved: true" —
// recompute the EIP-712 signature and cross-check every field that binds it
// to this exact payment.

async function checkAttestation(receipt: DecisionReceipt, expectedSigner: Address): Promise<Finding> {
  const attestation = receipt.worldId?.attestation;
  if (!attestation) {
    return {
      severity: "WARNING",
      category: "attestation_missing",
      receiptId: receipt.receiptId,
      detail: "receipt claims a human-approved settlement but carries no StepUp attestation",
    };
  }

  const { message } = attestation;
  const signerMatches = message !== undefined && attestation.signer.toLowerCase() === expectedSigner.toLowerCase();
  const fieldsMatch =
    message.receiptId === receipt.receiptId &&
    message.paymentIdentifier === receipt.paymentIdentifier &&
    receipt.payTo !== undefined &&
    message.payTo.toLowerCase() === receipt.payTo.toLowerCase() &&
    receipt.amount !== undefined &&
    BigInt(message.amount) === BigInt(receipt.amount);

  let signatureValid = false;
  try {
    signatureValid = await verifyStepUpAttestation(attestation);
  } catch {
    signatureValid = false; // malformed attestation — never treat as valid
  }

  if (signerMatches && fieldsMatch && signatureValid) {
    return {
      severity: "INFO",
      category: "attestation_valid",
      receiptId: receipt.receiptId,
      payTo: receipt.payTo,
      amount: receipt.amount,
      detail: `StepUp attestation signed by ${attestation.signer} matches payTo/amount/paymentIdentifier and verifies against the domain/types`,
    };
  }
  return {
    severity: "CRITICAL",
    category: "attestation_invalid",
    receiptId: receipt.receiptId,
    payTo: receipt.payTo,
    amount: receipt.amount,
    detail: `StepUp attestation failed verification (signerMatches=${signerMatches}, fieldsMatch=${fieldsMatch}, signatureValid=${signatureValid})`,
  };
}

// --- firewall reads ------------------------------------------------------------

async function fetchReceipts(firewallUrl: string, last: number): Promise<DecisionReceipt[]> {
  // Operator read: the auditor runs next to the firewall and needs every
  // owner's receipts (owner sessions only see their own since P3).
  const res = await fetch(`${firewallUrl}/receipts?limit=${last}`, { headers: { "x-yakusoku-admin": "1" } });
  if (!res.ok) throw new Error(`GET ${firewallUrl}/receipts failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as DecisionReceipt[];
}

// --- classification ------------------------------------------------------------

type Severity = "CRITICAL" | "WARNING" | "INFO";

interface Finding {
  severity: Severity;
  category: string;
  receiptId?: string;
  txHash?: string;
  payTo?: string;
  amount?: string;
  detail: string;
}

function classify(
  receipts: DecisionReceipt[],
  transfers: OnChainTransfer[],
  blockTimestampsMs: Map<string, number>,
): Finding[] {
  const findings: Finding[] = [];

  const earliestReceiptMs = receipts.length
    ? Math.min(...receipts.map((r) => new Date(r.createdAt).getTime()))
    : undefined;

  const claimedTxHashes = new Set(
    receipts.flatMap((r) => (r.verdict === "pay" && r.settlement?.txHash ? [r.settlement.txHash.toLowerCase()] : [])),
  );

  // 5. signed but never settled
  const now = Date.now();
  for (const r of receipts) {
    if (r.verdict === "pay" && r.state === "signed" && !r.settlement) {
      const ageMs = now - new Date(r.createdAt).getTime();
      if (ageMs > SIGNED_STALE_MS) {
        findings.push({
          severity: "INFO",
          category: "signed_not_settled",
          receiptId: r.receiptId,
          payTo: r.payTo,
          amount: r.amount,
          detail: `signed ${Math.round(ageMs / 60_000)} min ago, no settlement reported yet`,
        });
      }
    }
  }

  // 6. refused/blocked receipts (verdict === "refuse") with a matching, still-unclaimed on-chain transfer.
  // payTo+amount alone is a weak identity (the demo repeatedly buys the same
  // $1 card from the same merchant, so unrelated attempts collide on both) —
  // require the transfer to have also happened close to the refusal in wall
  // clock time, or every refuse receipt matches whatever unrelated real
  // payment happens to share its price. A transfer with no known block
  // timestamp is never matched here (fails closed into the "unexplained on
  // -chain transfer" bucket below instead of a possibly-wrong CRITICAL here).
  const unclaimed = transfers.filter((t) => !claimedTxHashes.has(t.txHash.toLowerCase()));
  const matchedTransferHashes = new Set<string>();
  for (const r of receipts) {
    if (r.verdict !== "refuse" || !r.payTo || !r.amount) continue;
    const amount = BigInt(r.amount);
    const receiptMs = new Date(r.createdAt).getTime();
    const match = unclaimed.find((t) => {
      if (matchedTransferHashes.has(t.txHash.toLowerCase())) return false;
      if (t.to.toLowerCase() !== r.payTo?.toLowerCase() || t.value !== amount) return false;
      const blockTimeMs = blockTimestampsMs.get(t.blockNumber.toString());
      return blockTimeMs !== undefined && Math.abs(blockTimeMs - receiptMs) <= REFUSED_MATCH_WINDOW_MS;
    });
    if (match) {
      matchedTransferHashes.add(match.txHash.toLowerCase());
      findings.push({
        severity: "CRITICAL",
        category: "refused_with_payment",
        receiptId: r.receiptId,
        txHash: match.txHash,
        payTo: r.payTo,
        amount: r.amount,
        detail: `receipt state=${r.state} verdict=refuse, but a matching on-chain payment was sent anyway`,
      });
    }
  }

  // 4. unexplained on-chain transfers — not a claimed settlement, not matched to a refused receipt
  for (const t of transfers) {
    const hashLower = t.txHash.toLowerCase();
    if (claimedTxHashes.has(hashLower) || matchedTransferHashes.has(hashLower)) continue;
    const blockTimeMs = blockTimestampsMs.get(t.blockNumber.toString());
    const isPrePersistence =
      earliestReceiptMs !== undefined && blockTimeMs !== undefined && blockTimeMs < earliestReceiptMs;
    if (isPrePersistence) {
      findings.push({
        severity: "INFO",
        category: "pre_persistence_history",
        txHash: t.txHash,
        payTo: t.to,
        amount: t.value.toString(),
        detail: `block #${t.blockNumber} predates the earliest receipt in the DB — no receipt system was recording yet`,
      });
    } else {
      findings.push({
        severity: "CRITICAL",
        category: "unexplained_transfer",
        txHash: t.txHash,
        payTo: t.to,
        amount: t.value.toString(),
        detail: `outgoing transfer has no firewall receipt referencing it — possible signing outside the firewall`,
      });
    }
  }

  return findings;
}

// --- reporting -------------------------------------------------------------

function printReport(findings: Finding[], args: Args): void {
  if (args.json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  console.log("\n=== Omamori independent verifier — findings ===\n");
  if (findings.length === 0) {
    console.log("(no findings — no pay receipts with a settlement hash, no on-chain transfers in window)");
  } else {
    console.table(
      findings.map((f) => ({
        severity: f.severity,
        category: f.category,
        receiptId: f.receiptId ?? "-",
        txHash: f.txHash ? `${f.txHash.slice(0, 12)}…` : "-",
        payTo: f.payTo ? `${f.payTo.slice(0, 10)}…` : "-",
        amount: f.amount ? formatUnits(BigInt(f.amount), USDC_DECIMALS) : "-",
        detail: f.detail,
      })),
    );
  }

  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.severity} ${f.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log("--- summary ---");
  for (const [key, count] of [...counts.entries()].sort()) {
    console.log(`${key}: ${count}`);
  }

  const critical = findings.filter((f) => f.severity === "CRITICAL").length;
  const warnings = findings.filter((f) => f.severity === "WARNING").length;
  console.log(`\n${critical} CRITICAL, ${warnings} WARNING finding(s).`);
  console.log(
    critical > 0
      ? "VERDICT: FAIL — unexplained or mismatched on-chain activity detected."
      : "VERDICT: OK — every settled payment traces back to a firewall `pay` receipt.",
  );
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wallet = args.wallet ?? privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex).address;

  const client = createClient();

  const latestBlock = await withRetry(() => client.getBlockNumber(), "getBlockNumber");
  const fromBlock = args.fromBlock ?? (latestBlock > 20_000n ? latestBlock - 20_000n : 0n);

  console.log(
    `[verifier] wallet=${wallet} window=[${fromBlock}, ${latestBlock}] firewall=${args.firewall} last=${args.last}`,
  );

  const [transfers, receipts] = await Promise.all([
    sweepOutgoingTransfers(client, wallet, fromBlock, latestBlock),
    fetchReceipts(args.firewall, args.last),
  ]);
  console.log(
    `[verifier] found ${transfers.length} outgoing USDC transfer(s) on-chain, ${receipts.length} receipt(s) from the firewall.`,
  );

  // Verify every pay receipt's reported settlement hash directly (not
  // limited to the swept window — see verifySettlement's doc comment).
  const settlementFindings: Finding[] = [];
  for (const r of receipts) {
    if (r.verdict !== "pay" || !r.settlement?.txHash) continue;
    if (!r.payTo || !r.amount) {
      settlementFindings.push({
        severity: "WARNING",
        category: "settlement_not_found",
        receiptId: r.receiptId,
        txHash: r.settlement.txHash,
        detail: "receipt has a settlement hash but no payTo/amount recorded to verify it against",
      });
      continue;
    }
    const check = await verifySettlement(client, r.settlement.txHash as Hex, wallet, r.payTo as Address, BigInt(r.amount));
    if (check.status === "confirmed") {
      settlementFindings.push({
        severity: "INFO",
        category: "confirmed",
        receiptId: r.receiptId,
        txHash: r.settlement.txHash,
        payTo: r.payTo,
        amount: r.amount,
        detail: "on-chain transfer matches the receipt's payTo and amount",
      });
      // WU12: only Confirmed receipts that carry a StepUp attestation get
      // checked — most receipts have none (auto-pay, never went through
      // World ID), and that's not itself a finding.
      if (r.worldId?.attestation) {
        settlementFindings.push(await checkAttestation(r, wallet));
      }
    } else if (check.status === "mismatch") {
      settlementFindings.push({
        severity: "CRITICAL",
        category: "mismatch",
        receiptId: r.receiptId,
        txHash: r.settlement.txHash,
        payTo: r.payTo,
        amount: r.amount,
        detail: `on-chain transfer to=${check.transfer.to} value=${check.transfer.value} does not match the receipt`,
      });
    } else {
      settlementFindings.push({
        severity: "WARNING",
        category: "settlement_not_found",
        receiptId: r.receiptId,
        txHash: r.settlement.txHash,
        payTo: r.payTo,
        amount: r.amount,
        detail:
          check.status === "reverted"
            ? "the reported transaction reverted on-chain"
            : "no on-chain transaction/transfer matches this reported hash",
      });
    }
  }

  // Block timestamps for the swept transfers (dedup by block), used only to
  // tell "pre-persistence history" apart from a genuinely unexplained
  // transfer in classify().
  const uniqueBlocks = [...new Set(transfers.map((t) => t.blockNumber))];
  const blockTimestampsMs = new Map<string, number>();
  for (const blockNumber of uniqueBlocks) {
    try {
      const block = await withRetry(() => client.getBlock({ blockNumber }), `getBlock(${blockNumber})`);
      blockTimestampsMs.set(blockNumber.toString(), Number(block.timestamp) * 1000);
    } catch (err) {
      console.error(`[verifier] WARNING: could not fetch block #${blockNumber} timestamp`, err instanceof Error ? err.message : err);
    }
  }

  const findings = [...settlementFindings, ...classify(receipts, transfers, blockTimestampsMs)];
  printReport(findings, args);

  const hasCritical = findings.some((f) => f.severity === "CRITICAL");
  process.exit(hasCritical ? 1 : 0);
}

main().catch((err) => {
  console.error("[verifier] crashed:", err);
  process.exit(1);
});
