# Verdicts and refusals

Every outcome `pay_x402`/`check_approval`/`request_promise`/`check_promise`/`connect`/`check_connection` can return, what it means, what to tell the human, and the next action. Refusal reasons come from `apps/firewall/pipeline.ts`'s stage order: `merchant → funding → provenance → Intercepta → Jev → World ID threshold` (idempotency and policy run before these). A `refuse` from any stage is final for that request; an `ask_human` from an earlier stage does not stop later stages from still refusing.

## `pay_x402` / `check_approval` top-level status

| `status` | Meaning | Tell the human | Next action |
|---|---|---|---|
| `paid` | Firewall signed and the store settled | Purchase done; for a gift card, `revealUrl` reveals the code once they sign in with their linked wallet | Report `receiptId`/`txHash`/`explorerUrl`; never ask for the code in chat |
| `no_payment_required` | The URL wasn't a 402 at all | The resource was free / already available | Use the returned body directly, no payment happened |
| `needs_human_approval` | A stage escalated; a fresh World ID approval is running | Open `verificationUri` in World App, code `userCode` (~5 min window) | Call `check_approval({ receiptId })` after they approve |
| `refused` | A stage refused outright, or the human denied/expired an approval | The reason below, plus `actionableHint` when present | **Final** — do not retry this request; act on the hint or ask the human what they want instead |

## Refusal reasons (`reason`, prefixed `"<stage>: ..."`)

| Reason (prefix stripped) | Stage | What it means | Tell the human | Next action |
|---|---|---|---|---|
| `unknown intentId` | policy | The `promiseId`/mandate no longer exists | This intent isn't valid anymore | Call `list_promises`, pick a live one, or `request_promise` |
| `intent not active (status: ...)` | policy | Intent is `pending_approval`/`denied`/`expired`/`revoked` | State the actual status | `check_promise` if pending; otherwise `request_promise` a new one |
| `intent revoked` / `paused by owner: ...` | policy | The owner revoked the intent or paused the account | The owner turned this off | Ask the owner to re-enable it, or request a new intent |
| `intent expired` | policy | Past its `expiresInMinutes` | The spending rules expired | `request_promise` a fresh one |
| `unsupported network: ...` / `unsupported asset: ...` | policy | Store quoted a network/asset Omamori doesn't support | This store isn't compatible yet | Stop; not fixable by retrying |
| `amount ... exceeds remaining budget ...` | policy | Price is more than what's left on the intent | Over budget by this much | Ask the human to approve a bigger budget (`request_promise` + `replaces`), or buy something cheaper |
| `payee_mismatch: ...` | merchant | The store's own 402 names a different payout address than what was forwarded | A payment-address mismatch was caught and blocked | **Never retry** — this is exactly the attack the firewall exists to catch; report it |
| `requirement_mismatch: ...` | merchant | Store's self-fetched requirement differs (asset/amount/network/scheme), or a malformed/non-402 response | The store's terms changed or answered unexpectedly | Re-fetch `/catalog`, confirm the price, try again fresh (not a retry of the same call) |
| `merchant_unreachable: ...` | merchant | Firewall's own fetch to the store failed, timed out, or redirected | The store didn't respond | Check the store is up; try later |
| `merchant_mismatch: ...` | merchant | This resource's origin isn't the intent's bound merchant (or the intent has none) | Wrong store for this intent | Never switch stores to route around this — request a new/replaced intent bound to the right store |
| `account_not_set_up: ...` | funding | No smart account resolvable yet | Setup isn't finished | Call `setup_account` for a fresh `setupUrl` |
| `not_deployed: ...` | funding | Smart account address has no on-chain code | The smart account was never deployed | Send them `setupUrl` (from the `actionableHint`) to finish linking |
| `paused: ...` | funding | Owner paused the smart account | Payments are paused | Owner unpauses at `setupUrl` |
| `recipient_not_registered: ...` | funding | Store's payout address isn't on the account's allow-list | This merchant isn't registered yet | Owner registers it at `setupUrl` |
| `over_account_limit: ...` | funding | Price exceeds the account's on-chain per-payment limit | Exceeds the account's payment limit | Owner raises the limit, or buy something cheaper |
| `insufficient_funds: ...` | funding | Smart account's USDC balance is too low | Needs more USDC | Owner deposits via `setupUrl` |
| `funding_check_failed: ...` | funding | Couldn't read on-chain state (RPC error, malformed address) | A transient funding check failed | Try again shortly; not the human's fault |
| `recipient address only appears in untrusted content (...)` | provenance | The payout address was only ever seen in a fetched page, never in the human's signed request | The store/page tried to redirect the money somewhere never approved | **Never retry** — this is a provenance/injection catch |
| Intercepta toxic-score / token-risk text | Intercepta | Destination address or token flagged (sanctions/scam/drainer) | The destination looks unsafe | **Never retry**; this is a security block |
| `Intercepta not configured` | Intercepta | Screening service has no API key | Operational gap, not a security finding | Escalates to human approval instead of blocking outright |
| `does not match the signed intent` | Jev | Semantic mismatch: clean address, in budget, but not what was approved | This purchase doesn't match what you authorized | **Never retry as-is.** If the human wants it anyway, confirm, then `request_promise` with `replaces` describing the new scope — never resubmit under the old intent |
| `model recommends refuse with high confidence` | Jev | Jev's own judgment says this looks wrong | Jev flagged this purchase as a bad match | Ask the human what they actually want; don't reword and resend |
| `amount ... exceeds the ... USDC human-approval threshold` | world_id | Payment is large enough to always ask a human, even if everything else passed | Needs a fresh approval because of size | Treat like any `needs_human_approval` — share the link, `check_approval` after |

## `request_promise` / `check_promise` status

| `status` | Meaning | Next action |
|---|---|---|
| `active` | Intent approved and usable | `pay_x402` may spend against it |
| `pending` | Waiting on World App | `check_promise({ promiseId })` again shortly |
| `denied` | Human declined | Ask what scope they'd actually approve, then try a narrower `request_promise` |
| `expired` | ~5 minute approval window elapsed | Ask the agent (you) to request again — this is not a refusal, just a lapsed window |

## `connect` / `check_connection` status

| `status` | Meaning | Next action |
|---|---|---|
| `connected` / `already_connected` | Linked to an existing account | `get_mandate` to see what it can do |
| `pending` | Waiting on World App | `check_connection()` again shortly |
| `denied` / `expired` | Declined or lapsed | For a brand-new user, use `request_promise` instead — it creates the account and first intent together and never needs `connect` |
