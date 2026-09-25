# wagmi + viem reference — Yakusoku `apps/web` and `apps/firewall`

> Scope: only wagmi/viem/Next.js integration for signing and verifying the `TaskIntent` EIP-712
> typed data described in `plan-tecnico.md` §2.2, plus the viem calls `apps/firewall` needs on
> Base Sepolia. Does not cover x402 (`@x402/*`), Jev, Intercepta, or World ID — see the other
> `research/` docs for those.
>
> Sources checked, in the order specified: (1) Context7 (`resolve-library-id` + `query-docs`) for
> `/wevm/wagmi`, `/wevm/viem`, `/vercel/next.js` — all three returned usable, current snippets;
> (2) `wagmi.sh` / `viem.sh` live pages via `wigolo fetch`, used to double-check anything Context7
> didn't fully cover (SSR guide, `injected` connector, `baseSepolia` chain id); (3) the actual
> `create-wagmi@2.0.19` npm tarball, unpacked and read directly — this is what WU0's
> `scaffold.sh` runs (`bunx create-wagmi@2.0.19 apps/web --template next --bun`), so its file
> contents below are ground truth for what WU5 will find in the repo, not a guess from docs.

## 1. What `create-wagmi@2.0.19 --template next` actually scaffolds

**SOURCE: npm tarball `create-wagmi@2.0.19` (`npm pack`), `templates/next/`, read directly.**

Files (`apps/web/` after scaffold):

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx       # Server Component: builds cookie-based initialState
│   │   ├── providers.tsx    # 'use client': WagmiProvider + QueryClientProvider
│   │   ├── page.tsx         # 'use client': connect/disconnect demo UI
│   │   └── globals.css
│   └── wagmi.ts              # getConfig(): chains, transports, cookieStorage
├── next.config.ts            # empty NextConfig
├── package.json               # deps pinned to "latest" (see below)
└── tsconfig.json
```

`package.json` dependencies are all `"latest"` — not pinned versions — so `bun install` resolves
whatever is current at scaffold time (fri 21:00 JST). At research time (2026-09-25) `npm view`
resolves: `wagmi@3.7.7`, `viem@2.56.9`, `next@16.3.6`, `@tanstack/react-query@5.103.2`. Re-check
right before WU0 runs, since these move fast; the snippets below match the current (v3) wagmi API.

`src/wagmi.ts` as generated:

```ts
import { cookieStorage, createConfig, createStorage, http } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'

export function getConfig() {
  return createConfig({
    chains: [mainnet, sepolia],
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
    transports: { [mainnet.id]: http(), [sepolia.id]: http() },
  })
}

declare module 'wagmi' {
  interface Register { config: ReturnType<typeof getConfig> }
}
```

No connectors array is set by the template (wagmi falls back to injected/EIP-6963 discovery by
default); `page.tsx` uses `useConnection()` + `useConnectors()` + `useConnect()` +
`useDisconnect()` — note `useConnection` (not `useAccount`) is the current wagmi v3 hook name for
reading the active connection (`address`, `addresses`, `status`, `chainId`, `chain`).
**SOURCE: wagmi.sh `/react/api/hooks/useConnection` (fetched live) — confirms this hook exists and
matches the template's usage exactly.**

## 2. Restricting to Base Sepolia only + injected connector only

Edit `apps/web/src/wagmi.ts`:

```ts
import { cookieStorage, createConfig, createStorage, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export function getConfig() {
  return createConfig({
    chains: [baseSepolia],                 // only chain — single-element tuple, not []
    connectors: [injected()],              // MetaMask / any EIP-1193 injected provider
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
    transports: { [baseSepolia.id]: http() },
  })
}

declare module 'wagmi' {
  interface Register { config: ReturnType<typeof getConfig> }
}
```

- `baseSepolia` from `viem/chains` (wagmi re-exports viem chains under `wagmi/chains`): `id: 84532`,
  default RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`. **SOURCE:
  viem source, `chains/definitions/baseSepolia.ts` on GitHub (fetched raw) — matches the
  `chainId 84532` already verified in `plan-tecnico.md`.**
- `injected()` from `wagmi/connectors`, no options needed for MetaMask; `shimDisconnect` defaults
  to `true` (injected providers like MetaMask have no real programmatic disconnect). **SOURCE:
  wagmi.sh `/react/api/connectors/injected` (fetched live).**
- `chains` is typed as a non-empty tuple in wagmi/viem — `[baseSepolia]` satisfies that;
  `[]` does not typecheck. **SOURCE: `/wevm/wagmi` Context7 snippets (createConfig usage
  throughout all examples pass at least one chain).**

## 3. `useSignTypedData` with the `TaskIntent` shape

Base hook shape. **SOURCE: `/wevm/wagmi` Context7 (`useSignTypedData` doc + "Sign Typed Data
with Domain" `@wagmi/core` snippet — same `domain`/`types`/`primaryType`/`message` shape applies
to the React hook's `.mutate()` argument).**

```ts
'use client'
import { useSignTypedData } from 'wagmi'

const TaskIntentTypes = {
  TaskIntent: [
    { name: 'task', type: 'string' },
    { name: 'budget', type: 'uint256' },
    { name: 'categories', type: 'string[]' },   // dynamic array field — valid EIP-712 type
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const domain = { name: 'Yakusoku', version: '1', chainId: 84532 } as const
// no verifyingContract — matches plan-tecnico.md §2.2

function useSignTaskIntent() {
  const { signTypedDataAsync } = useSignTypedData()
  return (intent: { task: string; budget: bigint; categories: string[]; expiry: bigint; nonce: `0x${string}` }) =>
    signTypedDataAsync({
      domain,
      types: TaskIntentTypes,
      primaryType: 'TaskIntent',
      message: intent,
    })
}
```

Field-shape notes, all **SOURCE: EIP-712 spec + Context7 `/wevm/viem` typed-data snippets**
(abitype's `TypedData` typing, which wagmi/viem share, accepts array-suffixed types like
`string[]`/`uint256[]` as ordinary struct field types — same mechanism used for `Person[]` etc. in
the standard `Mail` example):

- `budget` / `expiry` (`uint256`): pass as **`bigint`**, e.g. `25_000_000n` for 25 USDC (6
  decimals) or `BigInt(Math.floor(Date.now() / 1000) + 3600)` for expiry. Passing a `number` for a
  `uint256` field works for small values but risks precision loss above `2**53`; `bigint` is the
  correct type for wagmi/viem's typed-data machinery here regardless of magnitude.
- `categories` (`string[]`): a plain JS array, e.g. `['gift_card:amazon']`.
- `nonce` (`bytes32`): must be a `0x`-prefixed 32-byte hex string (66 chars total), not a bigint
  or plain string. Generate with the Web Crypto API + viem's hex helper:

  ```ts
  import { toHex } from 'viem'
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))) // '0x' + 64 hex chars
  ```
  **SOURCE: viem.sh `/docs/utilities/toHex` (fetched live) for `toHex(ByteArray)`;
  `crypto.getRandomValues` is a standard Web Crypto API available in the browser, not
  library-specific.**

## 4. Serializing the signature + message to POST to the firewall

The signature returned by `signTypedDataAsync` is already a `0x`-prefixed hex string — safe for
plain `JSON.stringify`. The message object is **not**: `budget` and `expiry` are `bigint`, and
`JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on any object
containing one. **SOURCE: this is native ECMAScript `JSON.stringify` behavior (MDN/spec), not a
wagmi/viem quirk — flagging it because it silently breaks the "just POST the message" step.**

Fix with a replacer that stringifies bigints, and parse them back to `BigInt` on the firewall side
with a matching reviver (or by casting the known numeric-string fields explicitly, which is safer
than a generic reviver since `zod` on the firewall side controls the shape anyway per
`plan-tecnico.md` §2.2):

```ts
// apps/web — before POST
const body = JSON.stringify(
  { intent, signature },
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
)
await fetch(`${process.env.NEXT_PUBLIC_FIREWALL_URL}/intents`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
})
```

```ts
// apps/firewall — after JSON.parse, before verifyTypedData
const intent = {
  ...raw.intent,
  budget: BigInt(raw.intent.budget),
  expiry: BigInt(raw.intent.expiry),
}
```

## 5. `verifyTypedData` on the firewall (viem)

**SOURCE: viem.sh `/docs/actions/public/verifyTypedData` via Context7 `/wevm/viem`.**

```ts
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() })

const valid = await publicClient.verifyTypedData({
  address: signerAddress,        // the wallet address claimed to have signed
  domain: { name: 'Yakusoku', version: '1', chainId: 84532 },
  types: TaskIntentTypes,        // same object as §3, shared via packages/shared
  primaryType: 'TaskIntent',
  message: intent,               // bigints restored per §4
  signature,
})
```

`verifyTypedData` covers EOA signatures directly (what MetaMask produces here) and also
ERC-1271/ERC-6492 smart-account signatures if ever needed later — no extra config required for the
EOA case in this project.

## 6. `privateKeyToAccount` (firewall's signing key, also used for x402)

**SOURCE: viem.sh `/docs/accounts/local` via Context7 `/wevm/viem`.**

```ts
import { privateKeyToAccount } from 'viem/accounts'
const account = privateKeyToAccount(process.env.FIREWALL_PRIVATE_KEY as `0x${string}`)
```

`account` plugs into both a viem `createWalletClient` (if the firewall ever signs a transaction
directly) and the `x402Client`/`createPaymentPayload` flow referenced in `yakusoku.md` — same
`LocalAccount` object either way.

## 7. `createPublicClient` for Base Sepolia + reading an ERC-20 (USDC) balance

**SOURCE: viem.sh Circle-USDC integration guide (`/circle-usdc/guides/integrating.mdx`) via
Context7 `/wevm/viem` — this page is a purpose-built USDC read/transfer walkthrough, closer to
this project's need than the generic `readContract` doc.**

```ts
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { baseSepolia } from 'viem/chains'

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL), // http() with no arg uses baseSepolia's default RPC
})

const usdcAddress = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const // verified in plan-tecnico.md

const balance = await publicClient.readContract({
  address: usdcAddress,
  abi: erc20Abi,          // viem exports the standard ERC-20 ABI — no need to hand-write it
  functionName: 'balanceOf',
  args: [walletAddress],
})
console.log(`${formatUnits(balance, 6)} USDC`) // USDC has 6 decimals
```

`erc20Abi` is a real named export of the `viem` package (not `viem/chains` or a contrib package) —
confirmed directly in the Circle-USDC guide's "Initialize the USDC Contract" snippet.

## 8. Waiting for a transaction receipt

**SOURCE: viem.sh `/docs/actions/public/waitForTransactionReceipt` via Context7 `/wevm/viem`.**

```ts
const receipt = await publicClient.waitForTransactionReceipt({
  hash: txHash,
  confirmations: 1,     // default; fine for a testnet demo
  timeout: 180_000,      // default 180s
})
// receipt.status === 'success' | 'reverted'
```

Useful for WU3's "tx visible on sepolia.basescan.org" check and WU14's post-hoc verifier: build the
explorer link as `${baseSepolia.blockExplorers.default.url}/tx/${txHash}`.

## 9. Next.js App Router `'use client'` gotchas + wagmi SSR/hydration

**SOURCE: wagmi.sh `/react/guides/ssr` (fetched live) + Next.js docs via Context7
`/vercel/next.js` (hydration-error guidance).**

- **`WagmiProvider` must live in a Client Component.** The template's `providers.tsx` has
  `'use client'` at the top for exactly this reason — `WagmiProvider`/hooks use React context and
  browser-only state and cannot run in a Server Component. `layout.tsx` itself stays a Server
  Component (`async function RootLayout`) and only imports the client `Providers` wrapper; any
  component calling `useSignTypedData`, `useConnection`, etc. needs its own `'use client'` (or to
  be a child of one) — a plain server `page.tsx` that imports a hook directly will fail to build.
- **Why `ssr: true` + `cookieStorage` matter.** wagmi's default persistence uses `localStorage`
  and `mipd` (EIP-6963 injected-provider discovery) — both client-only. Under Next.js SSR, the
  server renders with none of that data while the client's first paint has it, producing a
  hydration warning/mismatch (`Text content did not match server-rendered HTML`, per Next's own
  hydration-error docs). Turning on `createConfig({ ssr: true, storage: createStorage({ storage:
  cookieStorage }) })` defers hydrating that external state until after mount, and `layout.tsx`
  additionally reads the `cookie` header via `cookieToInitialState(getConfig(), (await
  headers()).get('cookie'))` to seed `initialState` on `WagmiProvider` — this is exactly what the
  create-wagmi template already wires up (§1); do not remove it when trimming chains/connectors.
- **Practical effect for WU5:** the signing button/component (uses `useSignTypedData`,
  `useConnection`) will render `status: 'disconnected'`/no address on the very first server-sent
  paint even if a wallet was connected on a previous visit, then flip to the real state after
  client hydration — expected, not a bug; don't try to "fix" it by reading `window.ethereum`
  during SSR.
