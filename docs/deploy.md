# Deploying Omamorisan on Dokploy

A shared team-testing instance: all four services (firewall, store, MCP over HTTP, site) as one Docker Compose app on your Dokploy VPS, with Dokploy-generated domains (no custom domain needed). This is a step-by-step guide for the Dokploy UI — you don't need to read the code to deploy.

Related: `odd/tasks/dokploy-deploy.md` (the work item this guide comes from), `docker-compose.yml`, `Dockerfile.bun`, `Dockerfile.site` (repo root).

## Before you start

- A running Dokploy instance on your VPS, with this repo pushed to `juanmaagd/yakusoku` on `main`.
- Your secrets ready (see the [env checklist](#env-checklist) below) — names only here, never values. `.env.hackathon` in this project's working folder (outside the repo) has the real values if you're the original author.

## Step 1 — Create the Compose app

1. In Dokploy, create (or open) a **Project**.
2. Add a new service → **Compose**.
3. Source: **GitHub**, repository `juanmaagd/yakusoku`, branch `main`.
4. Compose path: `./docker-compose.yml` (repo root).
5. Save, but **don't deploy yet** — domains and env come first.

## Step 2 — Generate a domain per service FIRST

Do this before pasting env or deploying. The site's `PUBLIC_FIREWALL_URL`/`PUBLIC_MCP_URL`/`PUBLIC_SITE_URL` are baked into the static build at **build time** (Astro only inlines `PUBLIC_*` vars when the image is built), and the firewall's CORS/SIWE/setup-link origins need the site's real domain too — so every domain must exist before the first build, or you'll rebuild the site image just to fix them.

For each of the four services, in the Compose app's **Domains** tab: **Add Domain** → pick the service → Dokploy assigns a free generated domain (`*.traefik.me` or similar) and handles the Traefik routing for you automatically — you don't need to touch `docker-compose.yml`'s labels ([Domains guide][dokploy-domains]).

| Service | Container port | Example generated domain |
|---|---|---|
| `site` | 4321 | `omamorisan-site.<random>.traefik.me` |
| `firewall` | 4001 | `omamorisan-firewall.<random>.traefik.me` |
| `mcp` | 4010 | `omamorisan-mcp.<random>.traefik.me` |
| `store` | 4000 | `omamorisan-store.<random>.traefik.me` |

Free `traefik.me` domains are **HTTP only** out of the box: Let's Encrypt can't issue certificates for them. Either use the `http://` URLs as they are (enough for a first test), or enable HTTPS by pasting the traefik.me wildcard certificate (Settings → Certificates, provider `None`, valid about 30 days), or point a subdomain you own at the VPS and use Let's Encrypt. If the browser steps (wallet connect, `/setup`) misbehave over plain HTTP, switch to HTTPS first. Write down all four URLs, with the scheme you actually use (the `https://` examples below assume HTTPS). You need them for Step 3.

`docker-compose.yml` already attaches every service to the shared `dokploy-network` and uses `expose` (not `ports`), which is what Dokploy's Domains tab expects to route to ([Docker Compose overview][dokploy-compose-overview], [Domains guide][dokploy-domains]). If you'd rather have Dokploy manage an app-scoped network instead of the shared one, turn on **Isolated Deployments** in the Compose app's Advanced settings and remove the `networks: dokploy-network` lines from `docker-compose.yml` — Dokploy then creates the network and connects Traefik to it for you ([Isolated Deployments][dokploy-utilities]).

## Step 3 — Paste the environment

In the Compose app's **Environment** tab, paste every variable from the [checklist](#env-checklist) below with real values — including the four domains from Step 2 (as full `https://...` URLs, except `OMAMORISAN_SIWE_DOMAINS` which is host[:port] only, no scheme).

## Step 4 — Deploy

Click **Deploy**. Dokploy builds `Dockerfile.bun` once (shared by firewall/store/mcp) and `Dockerfile.site` (with the `PUBLIC_*` build args from Step 3), then starts all four containers. Watch the build/deploy log in the UI for errors (see [Reading logs](#reading-logs) below).

## Step 5 — Smoke-check

From your own machine (replace with your real generated domains):

```bash
curl https://<firewall-domain>/health    # {"ok":true}
curl https://<store-domain>/health       # {"ok":true}
curl https://<mcp-domain>/health         # {"ok":true}
curl https://<store-domain>/catalog      # product list
curl -i https://<store-domain>/giftcard/amazon-1-rehearsal   # 402 Payment Required
curl -i https://<site-domain>/           # 200
```

If the firewall's `/health` is fine but a real `/sign` call fails with `merchant_unreachable`, see the [networking caveat](#networking-caveat-merchant-self-fetch) below.

## Env checklist

Names and where to get them — **never paste actual values into this file or a commit**.

| Variable | Service(s) | Example / where to get it |
|---|---|---|
| `FIREWALL_PRIVATE_KEY` | firewall | Base Sepolia private key of the operator EOA. It needs **Base Sepolia ETH for gas**, because it deploys every tester's smart account. Test USDC ([faucet.circle.com](https://faucet.circle.com)) is only needed for the legacy wallet-mandate path |
| `MERCHANT_KEY` | store, firewall | A separate Base Sepolia private key (the store's `payTo`) |
| `MERCHANT_ADDRESS` | store, firewall | Alternative to `MERCHANT_KEY` — just the address, if you'd rather not give the store a key |
| `TYPESAFE_API_KEY` | firewall | TypeSafe AI dashboard (Jev) |
| `INTERCEPTA_API_KEY` | firewall | Intercepta sandbox key |
| `WORLD_CLIENT_ID` | firewall | World ID for Agents sandbox app |
| `WORLD_CLIENT_SECRET` | firewall | World ID for Agents sandbox app |
| `WORLD_ID_ISSUER` | firewall | Optional — defaults to `https://sandbox.auth.world.org` |
| `BASE_SEPOLIA_RPC_URL` | firewall | Optional — defaults to the public Base Sepolia RPC; set a dedicated endpoint (Alchemy/Infura) if you hit rate limits |
| `OMAMORISAN_SITE_ORIGINS` | firewall | `https://<site-domain>` (Step 2) — CORS allow-list |
| `OMAMORISAN_SIWE_DOMAINS` | firewall | `<site-domain>` (Step 2, **no scheme**) — SIWE sign-in allow-list |
| `OMAMORISAN_SITE_URL` | firewall | `https://<site-domain>` (Step 2) — used in setup-link emails/URLs |
| `PUBLIC_FIREWALL_URL` | site (build arg) | `https://<firewall-domain>` (Step 2) |
| `PUBLIC_MCP_URL` | site (build arg) | `https://<mcp-domain>/mcp` (Step 2) |
| `PUBLIC_SITE_URL` | site (build arg) | `https://<site-domain>` (Step 2) — used for absolute `og:image` URLs |
| `OMAMORISAN_DEFAULT_RECIPIENTS` | firewall | Optional — JSON `[{"address":"0x...","label":"..."}]`; falls back to the store's own address if unset |
| `OMAMORISAN_FETCH_ALLOWED_HOSTS` | mcp | Optional — comma list of hostnames exempted from T2's SSRF guard; leave blank unless you know you need it |
| `WORLD_ID_APPROVAL_TIMEOUT_S`, `WORLD_ID_MAX_AUTH_AGE_S`, `INTERCEPTA_TIMEOUT_MS`, `OMAMORISAN_DEFAULT_PER_PAYMENT_LIMIT_USDC`, `OMAMORISAN_MAX_PROMISE_USDC`, `OMAMORISAN_MAX_PENDING_PROMISES`, `OMAMORISAN_FUNDING_TIMEOUT_MS`, `HUMAN_APPROVAL_OVER_USDC` | firewall | Optional tuning — every one safely falls back to the code's own default when left blank |

**Never set** `OMAMORISAN_ACCOUNT_READER`, `OMAMORISAN_DEV_APPROVALS`, or `OMAMORISAN_ACCOUNT_DEPLOYER=stub` on this deployment — they're dev-only fabrication seams (the firewall prints its own `[SECURITY]` warning on boot if one is set); `docker-compose.yml` deliberately never sets them. `OMAMORISAN_AGENT_KEY` is ignored by the `mcp` service in HTTP mode (it logs a `[SECURITY]` warning if set), because one env key would be shared by every session.

## How teammates connect their MCP client

**Option A — hosted HTTP MCP (the shared server, recommended):**

Point the client at `https://<mcp-domain>/mcp` (Streamable HTTP transport). On first use, ask the agent to "connect my account" (or just ask it to buy something — `request_promise` bootstraps an account in one step) — it shows a World ID link + code to approve in the World App.

Multi-user safe: each MCP session keeps its own credential in memory only, for that session alone — never written to a shared file, never visible to another session (T8, `apps/mcp/session.ts`/`apps/mcp/index.ts`). Two teammates connecting to the same `https://<mcp-domain>/mcp` at the same time each get their own separate World ID account, with no cross-account bleed. `check_approval` likewise refuses (with a plain "not found"-style answer, never confirming or denying that a receipt exists) if it's asked about a payment some other session started.

The one thing to know: a session's credential lives only as long as that session does. If your MCP client's connection drops and reconnects with a brand-new session id (most clients keep one session for as long as the app runs, so this is uncommon in practice), it starts credential-less again — the agent will say so and just needs to call `connect`/`request_promise` once more.

**Option B — stdio, pointed at the VPS firewall (run the MCP server yourself):**

Still available if you'd rather run the process yourself (e.g. to keep your credential in your own local file across restarts):

```json
{
  "mcpServers": {
    "omamorisan": {
      "command": "bun",
      "args": ["/absolute/path/to/yakusoku/apps/mcp/index.ts"],
      "env": { "OMAMORISAN_FIREWALL_URL": "https://<firewall-domain>" }
    }
  }
}
```

This keeps your credential in your own local `~/.omamorisan/credentials.json`, remembered across restarts — unchanged behavior, and no longer needed just to avoid sharing an account (Option A already isolates that).

## Reading logs

Dokploy's Compose app page has a **Logs** tab, per service — pick `firewall`/`store`/`mcp`/`site` from the dropdown to see that container's stdout (the T1 request logs and the firewall's one-line `[sign] receiptId=... verdict=... stage=... reason="..."` decision summaries land here). The **Deployments** tab shows the last 10 build/deploy runs if you need to check what actually got deployed.

## Reporting a bug

Open an issue (or message the team) with:

- The `receiptId` from the failing response (every `/sign` outcome and MCP `pay_x402`/`check_approval` result carries one — never share the response's `paymentSignature` or any bearer key).
- Which service's domain you hit and the exact request (method, path, no secrets in the URL).
- The relevant lines from that service's Dokploy log around the time of the failure.

## Networking caveat: merchant self-fetch

The firewall's `merchant` pipeline stage (`apps/firewall/merchant.ts`) independently re-fetches a payment's `resourceUrl` before signing — for a World ID promise, this **must** be the exact public store origin the human approved (never substituted for an internal service name; doing so would defeat the security property this stage exists for — see H1 in the main README). In this compose deployment, that means the `firewall` container calls back out through the public internet to its own VPS's `store` domain, which round-trips through Traefik.

This needs the Docker host to support NAT hairpin/loopback — a container reaching the VPS's own public IP from the inside. Most Linux Docker hosts support this by default; some cloud providers' network setups (certain security-group/VPC configurations) don't. If `/health` and `/catalog` work fine from outside but a real promise payment refuses with `merchant_unreachable`, check this first:

```bash
docker compose exec firewall bun -e "fetch('https://<store-domain>/catalog').then(r=>console.log(r.status)).catch(e=>console.error(e))"
```

If that fails from inside the `firewall` container but works from your own machine, it's the hairpin issue — the fix is host/network-level (e.g. enabling NAT loopback, or asking your VPS provider), not a code change.

The T2 fetch guard (`apps/mcp/ssrf-guard.ts`) has a known, documented limitation: it resolves DNS and checks the result, then lets `fetch` re-resolve DNS itself a moment later for the actual connection — a DNS answer that changes in between (DNS rebinding) could still slip through; closing that needs pinning the connection to the checked address, out of scope for this pass.

## Admin endpoints (kill switch)

The firewall's operator controls (`GET /control`, `POST /control/pause`, `POST /control/resume`) and the unfiltered admin SSE stream (`GET /events?admin=1`) require a loopback caller (127.0.0.1/::1) **and** the `x-yakusoku-admin: 1` header — by design, Traefik (and any other reverse proxy) never originates a loopback connection to the container, so these are unreachable from `https://<firewall-domain>` no matter what you send. This isn't a bug to route around; it's the same "local-admin-only" bar the code already documents (`apps/firewall/index.ts`'s `isLocalAdminRequest`).

To use them, run `curl` **inside** the firewall container instead, where `localhost` really is loopback:

```bash
# Find the container name/id first:
docker compose ps firewall   # or: docker ps --filter name=firewall

# Read the kill switch's current state:
docker exec <firewall-container> curl -s http://localhost:4001/control -H 'x-yakusoku-admin: 1'

# Pause (refuses every payment fail-closed until resumed):
docker exec <firewall-container> curl -s -X POST http://localhost:4001/control/pause \
  -H 'x-yakusoku-admin: 1' -H 'content-type: application/json' -d '{"reason":"maintenance"}'

# Resume:
docker exec <firewall-container> curl -s -X POST http://localhost:4001/control/resume -H 'x-yakusoku-admin: 1'

# Unfiltered admin event stream (every account's decisions, not just one owner's):
docker exec <firewall-container> curl -sN 'http://localhost:4001/events?admin=1'
```

## Sources

- [Docker Compose overview][dokploy-compose-overview]
- [Domains for Docker Compose][dokploy-domains]
- [Docker Compose example (manual Traefik labels, `expose` vs `ports`)][dokploy-example]
- [Isolated Deployments][dokploy-utilities]
- [Production Hardening Guide][dokploy-hardening] (dokploy-network default, Isolated Deployments)

[dokploy-compose-overview]: https://docs.dokploy.com/docs/core/docker-compose
[dokploy-domains]: https://docs.dokploy.com/docs/core/docker-compose/domains
[dokploy-example]: https://docs.dokploy.com/docs/core/docker-compose/example
[dokploy-utilities]: https://docs.dokploy.com/docs/core/docker-compose/utilities
[dokploy-hardening]: https://docs.dokploy.com/docs/core/guides/production-hardening
