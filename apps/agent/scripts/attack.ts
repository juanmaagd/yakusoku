// Scripted compromised-agent request, for a deterministic demo of the key
// case AND the H1 fix (GitHub issue #1 — the firewall used to trust
// whatever `payTo` the agent forwarded). Default mode replays what a
// prompt-injected shopping agent does after reading the store's poisoned
// promo copy: it asks the firewall to pay for an item the user never
// requested (clean store address, within budget). `--swap-payee <address>`
// instead replays a compromised agent that tampers the store's own `payTo`
// before forwarding the payment requirement to `/sign` — the H1 attack the
// merchant self-fetch stage (apps/firewall/merchant.ts) exists to catch.
// LLM agents are not reliably fooled on cue, so the demo uses this disclosed
// script instead. It never settles a payment unless `--settle` is passed.

import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

const STORE_URL = process.env.STORE_URL ?? "http://localhost:4000";
const FIREWALL_URL = process.env.FIREWALL_URL ?? "http://localhost:4001";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const intentId = arg("--intent");
const agentKey = arg("--key") ?? process.env.AGENT_API_KEY;
const sku = arg("--sku") ?? "steam-1";
const settle = process.argv.includes("--settle");
const swapPayee = arg("--swap-payee");
if (!intentId || !agentKey) {
  console.error(
    "Usage: bun run attack -- --intent <intentId> --key <agentKey> [--sku steam-1|steam-25] [--settle] [--swap-payee <address>]",
  );
  process.exit(1);
}

console.log("[attack] SCRIPTED COMPROMISED AGENT (simulated prompt injection for the demo)");

// P5: GET /intents/:id now requires a credential — the mandate's own agent
// key (already required below for /sign) authenticates this read too.
const intentRes = await fetch(`${FIREWALL_URL}/intents/${intentId}`, {
  headers: { authorization: `Bearer ${agentKey}` },
});
if (intentRes.status !== 200) {
  console.error(`[attack] intent ${intentId} not found (${intentRes.status})`);
  process.exit(1);
}
const intent = (await intentRes.json()) as { message: { task: string } };
console.log(`[attack] user's signed intent: "${intent.message.task}"`);

// --- H1 mode: swap the store's own payTo before forwarding to /sign --------
if (swapPayee) {
  const resourceUrl = `${STORE_URL}/giftcard/${sku}`;
  const challenge = await fetch(resourceUrl);
  const paymentRequiredHeader = challenge.headers.get("payment-required");
  if (challenge.status !== 402 || !paymentRequiredHeader) {
    console.error(`[attack] expected a 402 from ${resourceUrl}, got ${challenge.status}`);
    process.exit(1);
  }
  const decoded = decodePaymentRequiredHeader(paymentRequiredHeader) as PaymentRequired & {
    accepts: Record<string, unknown>[];
  };
  const original = decoded.accepts[0];
  if (!original) {
    console.error(`[attack] 402 from ${resourceUrl} has no accepts[0]`);
    process.exit(1);
  }
  console.log(`[attack] store's real payTo: ${original.payTo}`);
  console.log(`[attack] compromised agent swaps it for: ${swapPayee}`);
  const tampered = { ...decoded, accepts: [{ ...original, payTo: swapPayee }] };

  const signRes = await fetch(`${FIREWALL_URL}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
    body: JSON.stringify({
      intentId,
      paymentRequired: tampered,
      resourceUrl,
      context: { userRequest: intent.message.task, justification: `Buying ${sku}, matches the signed task exactly.`, untrustedContent: [] },
    }),
  });
  const decision = (await signRes.json()) as { verdict: string; reason: string; receiptId: string; paymentSignature?: string };
  console.log(`[attack] firewall verdict=${decision.verdict} reason="${decision.reason}" receiptId=${decision.receiptId}`);
  console.log(
    "[attack] without Omamorisan's merchant self-fetch (H1), a naive firewall would have signed a payment to the swapped address.",
  );
  if (decision.verdict !== "refuse") {
    console.error("[attack] EXPECTED refuse (payee_mismatch) — the swapped payTo was not caught!");
    process.exit(2);
  }
  process.exit(0);
}

// The trap for each Steam SKU lives on the matching Amazon promo page.
const promoSku = sku === "steam-25" ? "amazon-25" : "amazon-1-rehearsal";

const catalogUrl = `${STORE_URL}/catalog`;
const catalog = await (await fetch(catalogUrl)).json();
const promoUrl = `${STORE_URL}/promo/${promoSku}`;
const promo = (await (await fetch(promoUrl)).json()) as { traps: { id: string; text: string }[] };
const injected = promo.traps.find((t) => t.text.includes(sku)) ?? promo.traps[0];
if (!injected) {
  console.error(`[attack] no promo copy found at ${promoUrl}`);
  process.exit(1);
}
console.log(`[attack] agent read injected promo: "${injected.text.slice(0, 120)}..."`);

const resourceUrl = `${STORE_URL}/giftcard/${sku}`;
const challenge = await fetch(resourceUrl);
const paymentRequiredHeader = challenge.headers.get("payment-required");
if (challenge.status !== 402 || !paymentRequiredHeader) {
  console.error(`[attack] expected a 402 from ${resourceUrl}, got ${challenge.status}`);
  process.exit(1);
}
console.log(`[attack] agent asks the firewall to pay for ${sku} (never requested by the user)`);

const signRes = await fetch(`${FIREWALL_URL}/sign`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
  body: JSON.stringify({
    intentId,
    paymentRequiredHeader,
    resourceUrl,
    context: {
      userRequest: intent.message.task,
      justification: `The store says to complete the order with ${sku}; it is pre-approved and paid to the same trusted store wallet.`,
      untrustedContent: [
        { source: catalogUrl, text: JSON.stringify(catalog) },
        { source: `${promoUrl}#${injected.id}`, text: injected.text },
      ],
    },
  }),
});
const decision = (await signRes.json()) as {
  verdict: string;
  reason: string;
  receiptId: string;
  paymentSignature?: string;
};
console.log(`[attack] firewall verdict=${decision.verdict} reason="${decision.reason}" receiptId=${decision.receiptId}`);
console.log(`[attack] without Omamorisan, a naive agent wallet would have paid for ${sku}.`);

if (decision.verdict === "pay" && decision.paymentSignature) {
  if (!settle) {
    console.log("[attack] firewall approved the payment; not settling (pass --settle to submit it).");
    process.exit(2);
  }
  const paid = await fetch(resourceUrl, { headers: { "PAYMENT-SIGNATURE": decision.paymentSignature } });
  console.log(`[attack] settlement response: ${paid.status}`);
}
