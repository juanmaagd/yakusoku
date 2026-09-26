# First run (once per human)

This is the one-time path from "just connected" to "the agent can pay." Every step needs the human present; none of it can be automated around them.

## 1. Ask the agent for the first purchase (or intent)

With no credential at all, calling `request_promise` (task, budget, categories, expiry, one merchant origin) creates the account **and** the first intent together under a single World ID approval — there is no separate "connect" step for a new human. `check_promise` resumes a pending request if the tool call returns `pending`.

## 2. Approve in World App

The agent surfaces a `verificationUri` + `userCode`. The human approves on their phone. **The approval window is about 5 minutes** — if it lapses, ask the agent to request again.

## 3. Link the wallet and deploy the smart account

The first payment attempt (or `setup_account`) returns a `setupUrl` — a browser link, valid 30 minutes. The human opens it, connects a wallet, and signs a message. This deploys their `OmamorisanAccount` smart account (the firewall pays the gas) and sets that wallet as the account's owner.

The **wallet** (owner) and the **smart account** are two different addresses with separate balances. The agent pays from the smart account; only the owner can deposit, withdraw, or pause it.

## 4. Fund the smart account

Testnet USDC only, on **Base Sepolia**, from the [Circle faucet](https://faucet.circle.com/) — send to the wallet, then deposit from `/setup` into the smart account. 2-5 USDC is plenty for a demo purchase.

If `/setup` says "Payments are paused," unpause it there (owner-only).

## 5. Register the store, if needed

A `recipient_not_registered` refusal means the target store isn't registered for this account yet. Register it from `/setup` or `/app/account`. One intent is bound to one merchant origin — a different store needs its own intent.

## 6. Retry the purchase

Ask the agent to retry. `list_promises` should show the active intent before it pays; `pay_x402` reuses that intent instead of asking for a new World ID approval, unless a purchase needs a fresh human decision (large amount, or something the pipeline can't decide).

## Verify setup is complete

Open a **fresh session** (new conversation, or reconnect) and call `get_mandate`. If it returns the account with no World ID prompt, the agent key (or hosted session) is wired correctly and setup is done. If it re-asks for World ID, the key/header didn't make it into the client config — see `troubleshooting.md`.
