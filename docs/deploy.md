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

Enable HTTPS on each domain (Let's Encrypt, one click in the same tab). Write down all four URLs — you need them for Step 3.

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
curl -i https://<store-domain>/giftcard/amazon-1   # 402 Payment Required
curl -i https://<site-domain>/           # 200
```

If the firewall's `/health` is fine but a real `/sign` call fails with `merchant_unreachable`, see the [networking caveat](#networking-caveat-merchant-self-fetch) below.

## Env checklist

Names and where to get them — **never paste actual values into this file or a commit**.

| Variable | Service(s) | Example / where to get it |
|---|---|---|
| `FIREWALL_PRIVATE_KEY` | firewall | Base Sepolia private key, funded with test USDC ([faucet.circle.com](https://faucet.circle.com)) |
| `MERCHANT_KEY` | store, firewall | A separate Base Sepolia private key (the store's `payTo`) |
| `MERCHANT_ADDRESS` | store, firewall | Alternative to `MERCHANT_KEY` — just the address, if you'd rather not give the store a key |
| `TYPESAFE_API_KEY` | firewall | TypeSafe AI dashboard (Jev) |
| `INTERCEPTA_API_KEY` | firewall | Intercepta sandbox key |
| `WORLD_CLIENT_ID` | firewall | World ID for Agents sandbox app |
| `WORLD_CLIENT_SECRET` | firewall | World ID for Agents sandbox app |
| `WORLD_ID_ISSUER` | firewall | World ID sandbox OIDC issuer URL |
| `BASE_SEPOLIA_RPC_URL` | firewall | Any Base Sepolia RPC (e.g. a free Alchemy/Infura endpoint) |
| `OMAMORISAN_SITE_ORIGINS` | firewall | `https://<site-domain>` (Step 2) — CORS allow-list |
| `OMAMORISAN_SIWE_DOMAINS` | firewall | `<site-domain>` (Step 2, **no scheme**) — SIWE sign-in allow-list |
| `OMAMORISAN_SITE_URL` | firewall | `https://<site-domain>` (Step 2) — used in setup-link emails/URLs |
| `PUBLIC_FIREWALL_URL` | site (build arg) | `https://<firewall-domain>` (Step 2) |
| `PUBLIC_MCP_URL` | site (build arg) | `https://<mcp-domain>/mcp` (Step 2) |
| `PUBLIC_SITE_URL` | site (build arg) | `https://<site-domain>` (Step 2) — used for absolute `og:image` URLs |
| `OMAMORISAN_DEFAULT_RECIPIENTS` | firewall | Optional — JSON `[{"address":"0x...","label":"..."}]`; falls back to the store's own address if unset |
| `OMAMORISAN_FETCH_ALLOWED_HOSTS` | mcp | Optional — comma list of hostnames exempted from T2's SSRF guard; leave blank unless you know you need it |
| `WORLD_ID_APPROVAL_TIMEOUT_S`, `WORLD_ID_MAX_AUTH_AGE_S`, `INTERCEPTA_TIMEOUT_MS`, `OMAMORISAN_DEFAULT_PER_PAYMENT_LIMIT_USDC`, `OMAMORISAN_MAX_PROMISE_USDC`, `OMAMORISAN_MAX_PENDING_PROMISES`, `OMAMORISAN_FUNDING_TIMEOUT_MS`, `HUMAN_APPROVAL_OVER_USDC` | firewall | Optional tuning — every one safely falls back to the code's own default when left blank |

**Never set** `OMAMORISAN_ACCOUNT_READER`, `OMAMORISAN_DEV_APPROVALS`, or `OMAMORISAN_ACCOUNT_DEPLOYER=stub` on this deployment — they're dev-only fabrication seams (the firewall prints its own `[SECURITY]` warning on boot if one is set); `docker-compose.yml` deliberately never sets them. Also never set `OMAMORISAN_AGENT_KEY` on the `mcp` service — see the next section for why.

## How teammates connect their MCP client

**Option A — hosted HTTP MCP (the shared server, simplest to configure):**

Point the client at `https://<mcp-domain>/mcp` (Streamable HTTP transport). On first use, ask the agent to "connect my account" — it calls the `connect` tool, which shows a World ID link + code to approve in the World App.

Known limitation today: a **brand-new** MCP session with no `Authorization` header falls back to whatever account last connected on this shared server (`apps/mcp/credentials.ts` keys its stored credential only by firewall URL, not by session — see the parent report for the exact fix). In practice this means: as long as your MCP client keeps the same session alive (most do, for the life of the app), you keep your own account; but a session that gets dropped and reconnects with no header may pick up a teammate's account instead of starting fresh. If you want a hard guarantee of your own separate account, use Option B.

**Option B — stdio, pointed at the VPS firewall (one teammate, one account, no sharing):**

Each teammate runs the MCP server themselves, on their own machine, in stdio mode, pointed at the hosted firewall:

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

This keeps each teammate's credential in their own local `~/.omamorisan/credentials.json` — no sharing, no cross-session risk. This was the anticipated answer in the original task doc's open question, and is the one to recommend for now.

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
