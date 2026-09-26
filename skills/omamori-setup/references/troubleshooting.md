# Troubleshooting map

Match the symptom to its row; don't guess at a cause this table already answers. Run `node ../scripts/omamori-doctor.mjs` first — it rules out endpoint/config problems before you dig into the account itself.

| Symptom | Cause | Fix |
|---|---|---|
| Every new session asks for World ID again | No agent key configured, or the header didn't reach the client | Mint a key at `/app/settings` and add it per `clients.md`; verify with the doctor script that the config carries an `Authorization` header (present/absent only, never the value) |
| `401` / unauthorized | Key revoked, or a typo in the header/env var | Mint a fresh key at `/app/settings`; re-check the exact header name (`Authorization: Bearer <key>`) and env var name (Codex) |
| `recipient_not_registered` | The target store isn't registered on this account | Register it from `/setup` or `/app/account` |
| `insufficient_funds` | The **smart account** has no USDC (not the owner wallet) | Fund the owner wallet from the [Circle faucet](https://faucet.circle.com/), then deposit from `/setup` into the smart account |
| `paused` | The account's owner paused payments | Unpause from `/setup` (owner-only) |
| `merchant_mismatch` | The intent is bound to a different store's origin | Request a new intent for that store; one intent = one merchant origin |
| Approval window elapsed | World ID approvals expire after ~5 minutes | Ask the agent to request the approval again |
| `account_not_set_up` | The wallet-link step (`setupUrl`) was never completed | Call `setup_account` (or wait for the next tool response) for a fresh `setupUrl`, then follow `first-run.md` step 3 |
| `fetch_url` refuses a URL | The hosted MCP blocks private/internal addresses by design (SSRF guard) | This is expected — only public http(s) URLs are fetchable |
| Doctor script reports a service unhealthy | That endpoint is down or `instance.json` points at the wrong URL | Check the URL against `../assets/instance.example.json` / the team's current deployment, retry `GET /health` directly |
| Doctor script can't find a client's config | The client isn't installed, or its config lives somewhere else on this OS | Confirm the client is installed; see `clients.md` for the exact path per client and OS |
| Doctor script finds a config entry but no `Authorization` header | The key was never added, or was added under the wrong client/section | Re-run the connection step for that client in `clients.md` |

If none of these match, report the exact tool name, error string, and (if present) `receiptId`/`promiseId` to the human — that's what a bug report needs (see the repo's `docs/testing.md`), never a guess dressed up as a diagnosis.
