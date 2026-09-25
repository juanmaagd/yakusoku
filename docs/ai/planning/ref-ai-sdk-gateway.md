# Vercel AI SDK + AI Gateway reference — Yakusoku `apps/agent`

> Scope: only what WU4 needs — an LLM shopping agent (bun/TypeScript) that browses the store
> catalog over HTTP tools, asks the firewall to sign an x402 payment via a tool, and retries the
> purchase with the returned `PAYMENT-SIGNATURE` header. Model access goes through the **Vercel AI
> Gateway** (env `AI_GATEWAY_API_KEY`), packages `ai` and `@ai-sdk/gateway`. Does not cover x402
> itself, Jev, Intercepta, or World ID — see the other `research/` docs for those.
>
> Sources checked, in the order specified:
> 1. **Context7** (`resolve-library-id` + `query-docs`) for `/vercel/ai` (library id, 7687
>    snippets) and `/websites/vercel_ai-gateway` (1839 snippets) — both returned current, usable
>    snippets with attributable source URLs (`github.com/vercel/ai/blob/main/...`,
>    `vercel.com/docs/ai-gateway/...`). Context7 was fully usable, no fallback needed.
> 2. **Official docs**, live-fetched with `wigolo fetch`: `ai-sdk.dev/docs/ai-sdk-core/*`,
>    `vercel.com/docs/ai-gateway`, `vercel.com/docs/ai-gateway/models-and-providers`, and the
>    `ai` package's own bundled agent skill
>    (`raw.githubusercontent.com/vercel/ai/main/skills/use-ai-sdk/SKILL.md`).
> 3. **npm package types**, ground truth for the exact pinned versions: `npm pack ai@7.0.114
>    @ai-sdk/gateway@4.0.92`, unpacked into a scratch dir, `package.json` and `dist/index.d.ts`
>    read directly (10,170-line `.d.ts` for `ai`).
> 4. **Live AI Gateway model registry**: `curl https://ai-gateway.vercel.sh/v1/models` (public,
>    no auth required for listing) — 390 models, fetched at research time (2026-09-25) — used only
>    to ground the "cheap + capable" recommendation in real current pricing, not to hardcode a
>    model id as permanent truth.

## 0. Version check — matches the task's stated versions

**SOURCE: `npm view ai version dist-tags`, `npm view @ai-sdk/gateway version dist-tags` (live registry query, 2026-09-25).**

| Package | `latest` dist-tag | Notes |
|---|---|---|
| `ai` | **7.0.114** | dist-tags also expose `ai-v5`/`ai-v6` aliases for pinning old majors — confirms v7 is the current major, not a fork name. |
| `@ai-sdk/gateway` | **4.0.92** | matches the task's stated version exactly. |

**SOURCE: `ai@7.0.114`'s own `package.json` (npm tarball, read directly).** `ai` depends on
`@ai-sdk/gateway@4.0.92` internally (exact pin) — the gateway is not a separate integration to
wire up, it ships inside `ai` as the default provider.

```json
// ai@7.0.114 package.json (relevant fields)
"engines": { "node": ">=22" },
"peerDependencies": { "zod": "^3.25.76 || ^4.1.8" },
"dependencies": {
  "@ai-sdk/gateway": "4.0.92",
  "@ai-sdk/provider": "4.0.18",
  "@ai-sdk/provider-utils": "5.0.47"
}
```

`@ai-sdk/gateway@4.0.92`'s `package.json` has the identical `engines`/`zod` peer range. **Either
zod v3 (≥3.25.76) or zod v4 (≥4.1.8) works** — no need to force a specific zod major, just keep
whatever `zod` the rest of the monorepo (`packages/shared`) already uses.

## 1. Selecting a model through the gateway

**SOURCE: Context7 `/vercel/ai` + `/websites/vercel_ai-gateway`, cross-checked against `ai@7.0.114`'s `dist/index.d.ts`.**

Two equivalent ways, both valid in v7:

**(a) Plain model-id string — the AI Gateway is the *default* provider for `ai` when the model is
a string.** No `@ai-sdk/gateway` import needed for this path:

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-haiku-4.5', // "provider/model" — resolved via AI Gateway
  prompt: 'Hello!',
});
```

This only requires `AI_GATEWAY_API_KEY` to be set in the process environment — no explicit
gateway construction. **Verified from source**: `ai@7.0.114`'s `dist/index.d.ts` re-exports
`gateway`, `createGateway`, `GatewayModelId`, `GatewayProviderMetadata` directly from
`@ai-sdk/gateway` (`export { ..., createGateway, gateway } from '@ai-sdk/gateway';`), and the
type comments confirm: *"If not set, the default provider is the Vercel AI gateway provider."*

**(b) Explicit `gateway()` provider instance** — needed when you want
`gateway.getAvailableModels()`, a custom env var name, a custom base URL (corporate proxy), or
Provider Registry composition:

```ts
import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway'; // or `import { gateway } from 'ai'` — re-exported

const result = await generateText({
  model: gateway('anthropic/claude-haiku-4.5'),
  prompt: 'Hello!',
});
```

Custom instance (only needed for a non-default env var or base URL):

```ts
import { createGateway } from '@ai-sdk/gateway';

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY, // this IS the default var name already
  baseURL: 'https://ai-gateway.vercel.sh/v1/ai', // this IS the default base URL already
});
```

For WU4, plain string model ids (option a) are simplest and sufficient — install
`@ai-sdk/gateway` anyway (per the task's dependency list) only if you want
`gateway.getAvailableModels()` for a startup sanity check or model-picker logic.

### Model id format

`"<provider-slug>/<model-slug>"`, e.g. `anthropic/claude-haiku-4.5`, `openai/gpt-4o-mini`,
`google/gemini-2.5-flash-lite`. When the same model is hosted by multiple providers you can pick
the specific host (e.g. `spacexai/grok-4.5` vs `openai/gpt-6-astra` for the same underlying
model per Vercel's own docs example) — otherwise the gateway's default routing picks one.
**SOURCE: `vercel.com/docs/ai-gateway/models-and-providers` (live fetch).**

## 2. Listing available models (don't hardcode from memory)

**SOURCE: Context7 `/vercel/ai` (`skills/use-ai-sdk/SKILL.md`) + `/websites/vercel_ai-gateway`.**
Both the bundled AI SDK skill doc and the Vercel docs are explicit: *"Never use model IDs from
memory — models are released and retired frequently. Fetch the current list before writing code
that references a model."* This matters because the gateway's catalog genuinely churns (see §4 —
some ids that existed a few weeks ago in older docs are already gone from the live registry).

**SDK method** (typed, includes pricing):

```ts
import { gateway, generateText } from 'ai';

const availableModels = await gateway.getAvailableModels();
availableModels.models.forEach(m => console.log(m.id, m.name, m.pricing));

const { text } = await generateText({
  model: availableModels.models[0].id,
  prompt: 'Hello world',
});
```

**REST, no auth needed to list** (good for a `curl`/CI sanity check or a Bun script without
importing the SDK):

```bash
curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '.data[].id'
curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '[.data[] | select(.id | startswith("anthropic/")) | .id]'
```

## 3. Recommended cheap + capable models for tool calling (live catalog, 2026-09-25)

**SOURCE: live `GET https://ai-gateway.vercel.sh/v1/models` (public REST, no auth), 390 models
fetched and filtered locally with `jq` for `type: "language"`, tag `"tool-use"`, well-known
providers, sorted by output price.** Treat these ids as *the current cheap tier as of the fetch
date*, not permanent — re-run §2's list command before wiring the final model id, per the
warning above.

| Model id | Input $/tok | Output $/tok | Context | Notes |
|---|---:|---:|---:|---|
| `openai/gpt-4o-mini` | 0.00000015 | 0.0000006 | 128k | cheapest well-known reliable tool-caller; battle-tested |
| `google/gemini-2.5-flash-lite` | 0.0000001 | 0.0000004 | 1.0M | cheapest of the three big labs, huge context |
| `anthropic/claude-3-haiku` | 0.00000025 | 0.00000125 | 200k | cheapest Anthropic tool-caller |
| `openai/gpt-4.1-mini` | 0.0000004 | 0.0000016 | 1.0M | step up from 4o-mini, still cheap, stronger instruction following |
| `anthropic/claude-haiku-4.5` | 0.000001 | 0.000005 | 200k | current-gen Haiku; noticeably more reliable multi-step tool use than `claude-3-haiku` for ~4x the price |
| `google/gemini-2.5-flash` | 0.0000003 | 0.0000025 | 1.0M | balanced mid-tier, `web-search` tag too |

For a demo-grade shopping agent doing 2-3 sequential tool calls (catalog → firewall sign →
purchase retry), **`openai/gpt-4o-mini` or `google/gemini-2.5-flash-lite`** are the pragmatic
picks: both are tagged `tool-use`, both are cheap enough to not matter for a hackathon budget,
and both are mainstream/well-tested for structured tool-call output. If tool-call reliability is
flaky in testing, `anthropic/claude-haiku-4.5` or `openai/gpt-4.1-mini` are the next step up.

All model ids above returned `"tags": [..., "tool-use", ...]` and
`"supported_parameters": [..., "tools", "tool_choice", ...]` in the raw registry response —
i.e. the gateway itself advertises tool-calling support per-model, so this can also be checked
programmatically instead of hardcoded (`model.tags.includes('tool-use')` from
`gateway.getAvailableModels()`).

## 4. `generateText` with tools — definition, schema, execute

**SOURCE: Context7 `/vercel/ai` (`content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx`),
cross-checked against `ai@7.0.114/dist/index.d.ts`.** `tool()` (and `dynamicTool`, `jsonSchema`,
`zodSchema`, the `Tool` type) are re-exported from `@ai-sdk/provider-utils` via `ai`'s main entry
— import them straight from `'ai'`.

```ts
import { generateText, tool } from 'ai';
import { z } from 'zod';

const weather = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => ({
    location,
    temperature: 72 + Math.floor(Math.random() * 21) - 10,
  }),
});
```

Key names to get right in v7 (renamed from earlier majors — do not use v4/v5 names from memory):
**`inputSchema`** (not `parameters`), **`input`** on tool calls (not `args`), **`output`** on
tool results (not `result`).

## 5. Multi-step tool loops — `stopWhen` (the v7 replacement for `maxSteps`)

**SOURCE: Context7 `/vercel/ai` + `/websites/ai-sdk_dev`
(`docs/ai-sdk-core/tools-and-tool-calling`), verified against `dist/index.d.ts`.** `generateText`
and `streamText` no longer take a `maxSteps` number (that was the v4-era API). v7 uses `stopWhen`
with a composable `StopCondition`:

```ts
import { generateText, tool, stepCountIs } from 'ai'; // stepCountIs === isStepCount, both exported
import { z } from 'zod';

const { text, steps } = await generateText({
  model: 'openai/gpt-4o-mini',
  tools: { weather /* ...other tools */ },
  stopWhen: stepCountIs(8), // stop after at most 8 model↔tool round trips
  prompt: 'What is the weather in San Francisco?',
});
```

Built-in stop conditions (all exported from `ai`): **`isStepCount(n)`** (alias `stepCountIs`),
**`hasToolCall(...toolNames)`**, **`isLoopFinished()`**. They can be combined:
`stopWhen: [hasToolCall('purchase'), isStepCount(10)]`. Conditions are only evaluated when the
*last* step contains tool results.

**Verified default from source** (`dist/index.d.ts` doc comments): both `generateText` and
`streamText` default to `stopWhen: isStepCount(1)` — i.e. **tools do not auto-loop unless you set
`stopWhen` explicitly.** For WU4's 3-tool flow (catalog → sign → purchase-retry), set it
explicitly (e.g. `stepCountIs(6)`, generous headroom for a retry or a refusal-then-ask_human turn).

The SDK also ships a higher-level `ToolLoopAgent` abstraction (`import { ToolLoopAgent } from
'ai'`) whose own default is `stopWhen: isStepCount(20)` — useful if the loop grows more complex
later, but `generateText` + `stopWhen` is simpler and matches the official cookbook pattern for a
bounded, linear tool sequence like this one.

## 6. Reading tool calls / results (for logging)

**SOURCE: Context7 `/vercel/ai` (`content/cookbook/05-node/51-call-tools-in-parallel.mdx`,
`content/docs/03-ai-sdk-core/65-lifecycle-callbacks.mdx`).**

After the call, every step's tool activity is on `result.steps`:

```ts
const allToolCalls = steps.flatMap(step => step.toolCalls);
const allToolResults = steps.flatMap(step => step.toolResults);
```

Or log live, per step, via callbacks (useful for the firewall demo's audit trail /
`DecisionReceipt` correlation):

```ts
const result = await generateText({
  model: 'openai/gpt-4o-mini',
  tools: { browseCatalog, requestPaymentSignature, purchase },
  stopWhen: stepCountIs(8),
  prompt: userGoal,
  onStepStart({ stepNumber }) {
    console.log(`[agent] step ${stepNumber} started`);
  },
  onStepFinish({ stepNumber, finishReason, toolCalls, toolResults, usage }) {
    console.log(`[agent] step ${stepNumber} finished`, {
      finishReason,
      calls: toolCalls.map(c => ({ tool: c.toolName, input: c.input })),
      results: toolResults.map(r => ({ tool: r.toolName, output: r.output })),
      tokens: usage.totalTokens,
    });
  },
});
```

(`onStepFinish` is the stable name; `.d.ts` also lists an `experimental_` variant of some
step callbacks — prefer the non-experimental ones shown above.)

## 7. Streaming (if relevant)

**SOURCE: `ai-sdk.dev/docs/ai-sdk-core/*` (live fetch).** WU4's flow is transactional
(decide → call tool → get result → decide again), so `generateText` (non-streaming) is the
natural fit — streaming mainly matters for a chat UI. If a live "thinking" trace is wanted later,
`streamText` has the same `tools`/`stopWhen` shape; iterate `result.stream` and switch on
`chunk.type` (`'text-delta'`, `'tool-call'`, `'tool-result'`, `'error'`, `'abort'`). Not needed
for the WU4 MVP.

## 8. Error handling and timeouts

**SOURCE: `ai-sdk.dev/docs/ai-sdk-core/error-handling` (live fetch) + `dist/index.d.ts`
(`TimeoutConfiguration` type, verified directly in the installed `ai@7.0.114` types).**

**Regular errors** — `generateText` throws; wrap in `try/catch`. All AI SDK errors extend
`AISDKError`; the two most useful to check with `instanceof` (both re-exported from `ai`):
- **`APICallError`** — HTTP-level failure from the gateway/provider (rate limit, 4xx/5xx); carries
  `statusCode`, `isRetryable`.
- **`NoSuchToolError`** / **`InvalidToolInputError`** — model called a tool that doesn't exist, or
  called it with input that failed the zod schema.

```ts
import { generateText, APICallError } from 'ai';

try {
  const result = await generateText({ model, tools, stopWhen: stepCountIs(8), prompt });
} catch (error) {
  if (APICallError.isInstance(error)) {
    console.error('gateway/provider error', error.statusCode, error.isRetryable);
  }
  throw error; // fail-closed per yakusoku.md constraint 4 — never silently continue to `pay`
}
```

**Timeouts — first-class in v7, verified from the installed type declarations** (not
documented as prominently on the docs site, but present and typed in the shipped `.d.ts`):
`generateText`/`streamText` accept a `timeout` option, either a plain number (ms, total) or an
object:

```ts
const result = await generateText({
  model, tools, stopWhen: stepCountIs(8), prompt,
  timeout: {
    totalMs: 20_000,           // whole call, across all steps
    stepMs: 8_000,             // each individual model step
    toolMs: 5_000,             // default per-tool-execution timeout
    tools: { requestPaymentSignature: 6_000 }, // per-tool override, key = `${toolName}Ms`
  },
});
```

`maxRetries` (default 2) controls retries of the *model call itself* on transient failures;
that's separate from the `timeout` config above.

## 9. Bun compatibility

**SOURCE: `ai@7.0.114` / `@ai-sdk/gateway@4.0.92` `package.json` (`engines: { "node": ">=22" }`,
no native/Node-only deps besides standard `fetch`/`ReadableStream`) + web search
(`bun.com/guides/deployment/vercel`, `dev.to` Bun+AI-SDK writeups, and two known-issue reports).**

The `ai` package is plain ESM/TypeScript built on the Web `fetch`/`ReadableStream` APIs, which Bun
implements natively — `generateText` with tools (the non-streaming path WU4 uses) works under
`bun run`/`bun test` with no shims. Two caveats found while researching, neither blocking for
WU4's non-streaming use:
- A reported Bun-specific network error with **streaming** responses through the AI SDK in some
  production/bundled builds (`github.com/oven-sh/bun/issues/25630` — unresolved at fetch time,
  switching the toolchain to npm was the reported workaround). Only relevant if §7's streaming
  path is adopted later; re-test under Bun specifically before shipping it.
- A separate, gateway-specific (not Bun-specific) open issue where `@ai-sdk/gateway` streaming
  loses progressive output for Claude models (`github.com/vercel/ai/issues/11556`) — again only
  a streaming-path concern.

Practical note for secrets: constraint 6 in `yakusoku.md` reads `AI_GATEWAY_API_KEY` from
`~/Desktop/eth-global/.env.hackathon`, outside the repo. Bun auto-loads a `.env` in the working
directory but **not** an arbitrary path — load it explicitly, e.g.
`bun --env-file=../../.env.hackathon run src/index.ts`, or read it in code via
`Bun.env.AI_GATEWAY_API_KEY` after a manual parse. Either way, `process.env.AI_GATEWAY_API_KEY`
(what the default gateway provider reads, per §1) is populated the same way Bun populates
`process.env` generally — no gateway-specific Bun handling needed.

## 10. Minimal complete snippet — the WU4 agent loop

Illustrative shape for `apps/agent`; field names in `requestPaymentSignature`/`purchase` are
placeholders — align them with the real `apps/store` (WU2) and `apps/firewall` (WU3) contracts in
`plan-tecnico.md` §2 once those are implemented.

```ts
import { generateText, tool, stepCountIs, APICallError } from 'ai';
import { z } from 'zod';

const STORE_URL = process.env.STORE_URL ?? 'http://localhost:4000';
const FIREWALL_URL = process.env.FIREWALL_URL ?? 'http://localhost:4001';

const browseCatalog = tool({
  description: 'List gift cards available in the store catalog',
  inputSchema: z.object({}),
  execute: async () => {
    const res = await fetch(`${STORE_URL}/catalog`);
    return res.json();
  },
});

const requestPaymentSignature = tool({
  description:
    'Ask the Yakusoku firewall to sign an x402 payment for a given payment requirement. ' +
    'The firewall verifies the payment against the user-signed intent and may refuse.',
  inputSchema: z.object({
    intentId: z.string(),
    paymentRequirement: z.record(z.string(), z.unknown()), // decoded PAYMENT-REQUIRED header
  }),
  execute: async ({ intentId, paymentRequirement }) => {
    const res = await fetch(`${FIREWALL_URL}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId, paymentRequirement }),
    });
    return res.json(); // { verdict: 'pay' | 'refuse' | 'ask_human', signatureHeader?, reason? }
  },
});

const purchase = tool({
  description: 'Retry a store purchase with a PAYMENT-SIGNATURE header obtained from the firewall',
  inputSchema: z.object({ sku: z.string(), signatureHeader: z.string() }),
  execute: async ({ sku, signatureHeader }) => {
    const res = await fetch(`${STORE_URL}/giftcard/${sku}`, {
      headers: { 'PAYMENT-SIGNATURE': signatureHeader },
    });
    return { status: res.status, body: await res.json() };
  },
});

async function runAgent(goal: string) {
  try {
    const { text, steps } = await generateText({
      model: 'openai/gpt-4o-mini', // via AI Gateway, AI_GATEWAY_API_KEY from env
      tools: { browseCatalog, requestPaymentSignature, purchase },
      stopWhen: stepCountIs(8),
      timeout: { totalMs: 30_000, toolMs: 8_000 },
      prompt: goal,
      onStepFinish({ stepNumber, toolCalls, toolResults }) {
        console.log(`[agent] step ${stepNumber}`, {
          calls: toolCalls.map(c => ({ tool: c.toolName, input: c.input })),
          results: toolResults.map(r => ({ tool: r.toolName, output: r.output })),
        });
      },
    });
    console.log('[agent] final:', text);
    return { text, steps };
  } catch (error) {
    if (APICallError.isInstance(error)) {
      console.error('[agent] gateway/provider error', error.statusCode, error.isRetryable);
    }
    throw error; // fail-closed: never treat a thrown error as an implicit "pay"
  }
}
```

Run with `bun run` (or `bun test` for a smoke check); `AI_GATEWAY_API_KEY` must be present in
`process.env` (see §9's `--env-file` note).
