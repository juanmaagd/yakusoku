# TypeSafe SDK + Hono/Bun — reference for `apps/firewall`

> Quick-reference for implementing `apps/firewall` (bun + Hono 4.13.x, `@typesafe-ai/sdk@0.6.0`): `POST /intents`, `POST /sign`, `GET /events` (SSE), `POST /approvals/:id`. Every item is tagged **SOURCE** with where it was verified. Context7 had usable, high-quality docs for both libraries (`/websites/typesafe_ai_sdk_javascript` and `/websites/hono_dev`/`/honojs/middleware`) — used as primary source, cross-checked against live `docs.typesafe.ai`/`hono.dev` pages and the real spike code. Design decisions specific to Jev question wording/thresholds are already calibrated in `jev-diseno.md` and `spike-jev-resultados.md` — not repeated here except where needed for a complete snippet.

---

## 1. TypeSafe AI SDK (`@typesafe-ai/sdk@0.6.0`)

### 1.1 Install & client init

```bash
bun add @typesafe-ai/sdk@0.6.0
```
SOURCE (package.json of the spike at `/private/tmp/.../scratchpad/jev-spike/package.json`, pinned `"@typesafe-ai/sdk": "0.6.0"`).

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,      // falls back to env TYPESAFE_API_KEY if omitted
  // baseURL: falls back to env TYPESAFE_BASE_URL, then "https://api.typesafe.ai"
  // defaultModel: falls back to env TYPESAFE_DEFAULT_MODEL, then "jev-latest"
  // timeout: per-attempt timeout in ms, default 10000 (no total retry budget)
  // retry: Partial<RetryPolicy> — see §1.4
  // logLevel: falls back to env TYPESAFE_LOG_LEVEL, default "warn"
});
```
SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `TypeSafeClientConfig` interface + `TypeSafeClient` constructor — `docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig`, `.../classes/TypeSafeClient`). Confirmed live at `client.baseURL`/`client.defaultModel` readback in the spike smoke test (`smoke-test.ts`): `baseURL= https://api.typesafe.ai defaultModel= jev-latest`.

`TypeSafeClientConfig` fields worth knowing for a server (not just the ones above): `dangerouslyAllowBrowser` (default `false` — irrelevant for `apps/firewall`, a server), `defaultHeaders`, `fetch` (custom fetch impl, useful for tests), `logger`. Explicit constructor options win over env vars, which win over SDK defaults. The constructor throws if the API key is missing, config is invalid, or the runtime is unsupported. SOURCE (same Context7 page).

### 1.2 `systemOne` — exact call shape

```ts
systemOne<Q>(request: SystemOneRequest<Q>, options?: RequestOptions): APIPromise<SystemOneResult<Q>>
```
- `request.state`: string, JSON object, or array of strings — text only, never binary/image (see `docs.typesafe.ai/concepts/state`).
- `request.questions`: a `Questions` map, `{ [name: string]: Question }` — built with `noul`/`choice`/`score` (§1.3).
- `request.model?`: per-call model override (string), otherwise `client.defaultModel`.
- `options?`: `{ signal?: AbortSignal, timeout?: number, retry?: Partial<RetryPolicy>, headers?, ... }` — per-call overrides of the client-level config.
- Returns `APIPromise<SystemOneResult<Q>>` — thenable, `await`-able directly.
- Throws when: questions are empty; a `score` question's `criteria` is not an array of ≥2 entries; the server returns non-2xx after retries; the request can't connect or times out after retries; the caller aborts.

```ts
const { answers } = await client.systemOne({
  state: "I was charged twice. Please help.",
  questions: { billing: noul("Is this about billing?") },
});
console.log(answers.billing.noul);
```
SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient` — method `systemOne()`, with the example above verbatim from the docs).

**Response shape** — `SystemOneResult<Q>`:
```ts
interface SystemOneResult<Q> {
  model: string;                                    // e.g. "jev-1.13.0" — the versioned model that actually answered
  answers: { [K in keyof Q]: ResultFor<Q[K]> };
  usage: { input_tokens: number; output_tokens: number };
}
```
SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `SystemOneResult<Q>` interface — `docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult`; `usage` field shape cross-verified against `jev-diseno.md` §1, itself verified against `src/types.ts` @ tag `v0.6.0` and the live smoke-test output: `usage: {"input_tokens":326,"output_tokens":20}`). `answers` is fully typed in TS: e.g. `answers.matches_intent.noul` is inferred as `number` from the generic `Q`.

### 1.3 Question builders — `noul` / `choice` / `score`

All three are **synchronous** builders that just construct a typed `{ type, instructions, criteria }` object — they do not call the network. (Context7's auto-extracted docs show a stray `choice(options): Promise<...>` free-function signature that does **not** match the real, verified usage below — every call site, in the SDK's own docs example and in the working spike code, calls them synchronously and puts the result directly into the `questions` map with no `await`. Trust the signature below.)

```ts
function noul(instructions?: EntryType, criteria?: { true?: EntryType; false?: EntryType }): NoulQuestion;
```
SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `docs.typesafe.ai/sdk/javascript/api/functions/noul` — full signature, `instructions` defaults to `null`, `criteria` optional).

```ts
choice(instructions: EntryType, criteria: Record<string, EntryType | null>): ChoiceQuestion;  // criteria is a MAP, not an array
score(instructions: EntryType, criteria: EntryType[]): ScoreQuestion;                          // criteria is an ARRAY of level descriptions, not bare numbers
```
`ChoiceQuestion<T>` = `{ type: "choice", instructions?, criteria: T }`; `ScoreQuestion` likewise carries `type: "score"`. SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `ChoiceQuestion<T>`/`ScoreResponse<T>` interfaces). The synchronous-builder behavior and the runtime validation (`score()` rejects a non-array `criteria`, `choice()` rejects a non-map `criteria`) were already verified against the real SDK source in `jev-diseno.md` §1 (`github.com/typesafe-ai/typesafe-sdk-js`, `src/questions.ts` @ tag `v0.6.0`) — not re-verified here.

**Answer shapes** (already verified in `jev-diseno.md` §1 against `src/types.ts` @ v0.6.0 + `docs/api.md`, reused here without re-verification):
```ts
// Noul  -> { type: "noul", noul: number }                                                          // 0..1
// Choice-> { type: "choice", choice: string, confidence: number, probabilities: Record<string, number> }
// Score -> { type: "score", score: number, confidence: number, legend: Record<string, string>, probabilities: Record<string, number> }
```

Minimal example combining all three, exactly as used in the working spike (`questions.ts`):
```ts
import { choice, noul, score } from "@typesafe-ai/sdk";

const QUESTIONS = {
  matches_intent: noul("Does this payment match signed_intent.task?", {
    true: "Faithful execution of the request.",
    false: "Different product/category/amount than authorized.",
  }),
  action: choice("What should the firewall do?", {
    pay: "Safe to execute automatically.",
    refuse: "Reject without a human.",
    ask_human: "Ambiguous — needs a human look.",
  }),
  risk: score("How risky is this payment?", [
    "No risk: exact match, clean provenance.",
    "Low risk: minor deviation within budget/category.",
    "Moderate risk: notable deviation or unclear origin.",
    "High risk: contradicts intent or shows manipulation.",
  ]),
} as const;
```
SOURCE (spike code, `/private/tmp/.../scratchpad/jev-spike/questions.ts`, live-tested against the real API in `spike-jev-resultados.md`; this file already implements the calibrated wording — do not diverge from it when wiring WU8).

### 1.4 Timeouts / retries

Per-call `timeout` (ms, per attempt, default `10000`) and `retry` are set at construction and overridable per call via `RequestOptions`:
```ts
interface RetryPolicy {
  maxRetries: number;            // default 2 — retries after the initial attempt; 0 disables
  backoffInitialMs: number;      // default 500 — doubled up to backoffMaxMs
  backoffMaxMs: number;          // default 5000
  backoffJitter: number;         // default 0.25 — fraction of each delay randomly subtracted
  httpStatuses: ReadonlySet<number>; // default 408, 429, and 500–599
  respectRetryAfter: boolean;    // default true — honors Retry-After / retry-after-ms
  maxRetryAfterMs: number;       // default 60000 — longer server-requested delays fall back to backoff
  apiConnectionError: boolean;   // default true — retries connection failures / interrupted bodies
  apiTimeoutError: boolean;      // default true
}
```
SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy` — every default value listed there). This matches what `jev-diseno.md` §1 already stated (`maxRetries: 2, backoffInitialMs: 500, backoffMaxMs: 5000`), now with the two extra fields (`backoffJitter`, `httpStatuses`) confirmed.

Firewall usage — pin a short per-call timeout so a hung Jev call never blocks the fail-closed pipeline past what `decide.ts` expects:
```ts
const result = await client.systemOne(
  { state, questions: QUESTIONS },
  { timeout: 3000 },
);
```
SOURCE (spike code `decide.ts`, live-tested — p50 301 ms / p95 796 ms per `spike-jev-resultados.md` §4, so 3000 ms leaves ample headroom before treating Jev as unavailable).

### 1.5 Error classes

```
TypeSafeError                       // base class, `new TypeSafeError(message, options?)`
└─ APIError                         // unsuccessful HTTP response: new APIError(status, body, headers, message?)
   ├─ AuthenticationError
   ├─ BadRequestError
   ├─ InternalServerError
   ├─ NotFoundError
   ├─ PermissionDeniedError
   ├─ RateLimitError                // HTTP 429 — has `retryAfterMs?: number`, `requestId?: string`
   └─ UnprocessableEntityError
```
`APIError.fromResponse(status, body, headers)` / `RateLimitError.fromResponse(...)` construct the right subclass for a given status code. Every `APIError` exposes `status`, `body` (parsed JSON, text, or `undefined`), `headers`, and `requestId` (from `x-typesafe-request-id`). SOURCE (Context7 `/websites/typesafe_ai_sdk_javascript`, `docs.typesafe.ai/sdk/javascript/api/classes/{TypeSafeError,APIError,RateLimitError}`).

Firewall fail-closed pattern — catch broadly, never inspect the specific subclass to decide "pay":
```ts
try {
  result = await client.systemOne({ state, questions: QUESTIONS }, { timeout: 3000 });
} catch (err) {
  // any TypeSafeError (network, timeout, 429, 5xx, auth, ...) -> ask_human, never pay
  return { verdict: "ask_human", reason: "Jev unavailable — fail closed" };
}
```
SOURCE (spike code `decide.ts`, this exact catch-all pattern, live-tested with 45 real API calls, 0 errors observed — see `spike-jev-resultados.md` §7 recommendation 3 to keep this behavior).

### 1.6 Model id pinning — `jev-1.13.0` vs `jev-latest`

`GET /v1/systemone` (model field) accepts either an **alias** or a **versioned ID**:

| Alias | Resolves to | Meaning |
|---|---|---|
| `jev-latest` | `jev-1.13.0` | Most recent *stable, official* release. Default in every client SDK and in the docs' examples. |
| `jev-preview` | `jev-1.13.0` | Most recent release, official or not — currently identical to `jev-latest` (no preview build live). |

An alias moves when a new version ships, so answers behind it can silently change. The response's `model` field always reports the exact versioned ID that answered (confirmed live: `model: "jev-1.13.0"` in both the smoke test and the 39-case eval). **If thresholds are tuned against a specific version — which is exactly what WU8 does — pin the versioned ID (`"jev-1.13.0"`) instead of `"jev-latest"`**, and move to a new version deliberately on your own schedule. SOURCE (`docs.typesafe.ai/models.md`, sections "Aliases" and the model table — fetched live via wigolo 2026-09-25; this recommendation is TypeSafe's own explicit guidance, not our inference: *"If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias..."*).

```ts
const client = new TypeSafeClient({ defaultModel: "jev-1.13.0" }); // pin, don't float on "jev-latest"
```

### 1.7 Rate limits

`jev-1.13.0`: **250,000 tokens/second** and **1,200 requests/minute**, both **dynamic and subject to change without notice** ("we are serving a very large volume of demand ... limits can change while we let in more users"). A request over either limit returns `429 Too Many Requests`. The JS SDK retries `429`/`5xx` with backoff by default (§1.4) and honors the `retry-after`/`retry-after-ms` response header when present. Context length: 64k tokens per request (`state` + all questions combined), 32k tokens for `state` + the single longest question. Pricing: $42 per billion input tokens, output free. SOURCE (`docs.typesafe.ai/models.md`, fetched live via wigolo 2026-09-25 — same page already cited in `jev-diseno.md` §1, reconfirmed here).

---

## 2. Hono on Bun

### 2.1 App setup — `export default { port, fetch }` / `Bun.serve`

```ts
import { Hono } from "hono";

const app = new Hono();
app.get("/", (c) => c.text("Hello Bun!"));

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};
```
Bun's runtime looks for a default export with a `fetch` function (and optional `port`) — no explicit `Bun.serve()` call is required when the entry file is run directly with `bun run`. SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/getting-started/bun` — "Bun > Change port number").

Equivalent explicit form with `Bun.serve` (useful when you need e.g. `server.requestIP(req)` or a larger `maxRequestBodySize`):
```ts
Bun.serve({
  fetch(req, server) {
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  maxRequestBodySize: 1024 * 1024 * 200,
});
```
SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/middleware/builtin/body-limit` — "Configure Bun Server for Large Request Bodies").

### 2.2 JSON body parsing

```ts
app.post("/intents", async (c) => {
  const body = await c.req.json();
  // ...
});
```
`c.req.json()` parses the body when `Content-Type: application/json`; it's async. SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/api/request` — "Parse JSON Request Body with HonoRequest json()"). Note for tests/clients: a request without an explicit `Content-Type: application/json` header parses to `{}` silently, not an error — always set the header. SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/guides/validation` — "Testing JSON Validation").

### 2.3 Zod validator middleware (`@hono/zod-validator`)

```bash
bun add @hono/zod-validator zod
```

```ts
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const IntentSchema = z.object({
  task: z.string(),
  budget_usdc: z.number().positive(),
  categories: z.array(z.string()),
  expiry: z.string().datetime(),
  signer: z.string(),
  signature: z.string(),
});

app.post("/intents", zValidator("json", IntentSchema), (c) => {
  const intent = c.req.valid("json"); // fully typed from IntentSchema
  // ...
  return c.json({ id: "...", ...intent }, 201);
});
```
SOURCE (Context7 `/honojs/middleware`, `github.com/honojs/middleware/blob/main/packages/zod-validator/README.md` — "Basic usage of zValidator with Zod schema"; install command confirmed at `hono.dev/docs/guides/validation`, which lists `bun add @hono/zod-validator` explicitly).

Default behavior with **no** custom hook: on failure, `zValidator` returns the raw Zod `safeParse` result as JSON with **HTTP 400** (`return c.json(result, 400)`), unvalidated. SOURCE (Context7 `/honojs/middleware`, same README, "Default error response on validation failure" — cites `packages/zod-validator/src/index.ts`).

Custom error shape via the third `hook` argument (recommended for `apps/firewall` so `POST /intents`/`POST /sign` return a consistent error envelope):
```ts
app.post(
  "/intents",
  zValidator("json", IntentSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "invalid_intent", issues: result.error.issues }, 400);
    }
  }),
  (c) => { /* ... */ }
);
```
SOURCE (Context7 `/honojs/middleware`, "Hook for custom error response").

### 2.4 CORS middleware (for the Next.js dashboard on another port)

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

// CORS middleware must be registered before the routes it protects
app.use(
  "/*",
  cors({
    origin: "http://localhost:3001", // the Next.js dashboard's dev origin (apps/web)
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
```
`origin` also accepts an array of allowed origins or a `(origin, c) => string` function for dynamic matching (e.g. reading an env var). SOURCE (fetched live, `hono.dev/docs/middleware/builtin/cors` — import statement `import { cors } from 'hono/cors'`, `cors(options)` full option list: `origin`, `allowMethods` (default `['GET','HEAD','PUT','POST','DELETE','PATCH','QUERY']`), `allowHeaders` (default `[]`), `maxAge`, `credentials`, `exposeHeaders`). For `GET /events` (SSE) specifically, remember the EventSource client on the dashboard cannot set custom headers, so any auth for that endpoint has to travel another way (query param / cookie), not `Authorization`.

### 2.5 SSE with `streamSSE`

```ts
import { streamSSE } from "hono/streaming";

app.get("/events", async (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0;
    while (!stream.aborted) {
      await stream.writeSSE({
        data: JSON.stringify({ /* DecisionReceipt or event payload */ }),
        event: "receipt",
        id: String(id++),
      });
      await stream.sleep(1000); // or: wait on the next event from the in-memory bus instead of polling
    }
  });
});
```
`writeSSE({ data, event, id })` writes one SSE frame; `stream.sleep(ms)` is a stream-aware delay; `stream.aborted` flips when the client disconnects, which should end the loop. SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/helpers/streaming` — "Streaming Server-Sent Events (SSE) with `streamSSE()` in Hono", import line `import { stream, streamText, streamSSE } from 'hono/streaming'`).

**Client-disconnect handling** — prefer `stream.onAbort(cb)` over polling `stream.aborted` in a loop condition when you also need cleanup side effects (e.g. removing the stream from a broadcast registry, per §2.5.1):
```ts
app.get("/events", async (c) => {
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      console.log("dashboard client disconnected");
      // deregister `stream` from the in-memory subscriber set here
    });
    while (!stream.aborted) {
      await stream.writeSSE({ data: "...", event: "time-update", id: "..." });
      await stream.sleep(1000);
    }
  });
});
```
SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/middleware/builtin/timeout` — "Server-Sent Events (SSE) Timeout Handling in Hono", which demonstrates `stream.onAbort()` alongside a `setTimeout`/`stream.close()` pattern; adapt by dropping the artificial timeout for a long-lived dashboard feed).

**Keep-alive**: there is no built-in Hono keep-alive helper for SSE beyond `stream.sleep()`; the standard technique (not Hono-specific — general SSE practice) is to periodically write either a real event or an SSE comment line (`: keep-alive\n\n`) so intermediate proxies/load balancers don't time out the idle connection. For `GET /events`, either piggyback on the natural cadence of `DecisionReceipt` events, or add a low-frequency `stream.writeSSE({ event: "ping", data: "" })` on a timer. Marked **DESIGN** (general SSE practice, not a documented Hono API) rather than SOURCE.

**Event format on the wire** produced by `writeSSE`, per the SSE spec Hono implements: each call emits `event: <event>\nid: <id>\ndata: <data>\n\n`. `data` should already be a string (`JSON.stringify` your payload before passing it).

#### 2.5.1 Broadcasting to multiple clients from an in-memory event bus

Hono's `streamSSE` handles exactly **one** connection per invocation — there's no documented multi-client broadcast primitive in Hono itself; this is an application-level pattern layered on top. Marked **DESIGN**, not SOURCE:

```ts
// events-bus.ts — one process-wide registry, matches WU9's "in-memory event bus" requirement
type DecisionReceiptEvent = { id: string; payload: unknown };
const subscribers = new Set<(evt: DecisionReceiptEvent) => void>();

export function publish(evt: DecisionReceiptEvent) {
  for (const send of subscribers) send(evt);
}

export function subscribe(send: (evt: DecisionReceiptEvent) => void): () => void {
  subscribers.add(send);
  return () => subscribers.delete(send); // unsubscribe
}
```
```ts
// route handler
import { streamSSE } from "hono/streaming";
import { subscribe } from "./events-bus";

app.get("/events", async (c) => {
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((evt) => {
      // fire-and-forget: writeSSE is async, but the bus callback isn't awaited by design
      void stream.writeSSE({ data: JSON.stringify(evt.payload), event: "receipt", id: evt.id });
    });
    stream.onAbort(unsubscribe);
    // keep the handler alive until the client disconnects
    while (!stream.aborted) await stream.sleep(30_000);
  });
});
```
Call `publish(...)` from `decide.ts` / the pipeline wherever a `DecisionReceipt` is finalized (WU9). Each connected dashboard tab gets its own `streamSSE` closure and its own registry entry; `publish` fans one event out to every open connection.

### 2.6 Error handling middleware

```ts
import { HTTPException } from "hono/http-exception";

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse(); // Response built from the exception's status + message/custom response
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
});
```
`app.onError` centrally catches uncaught exceptions; if both a parent app and a sub-route define handlers, the route-level one wins. `HTTPException` supports `{ message }`, `{ cause }` (wrap an underlying error), or a full custom `{ res: Response }`. SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/api/exception` and `hono.dev/docs/api/hono` — "App - Hono > Error Handling").

Throwing from a handler (e.g. `POST /approvals/:id` on an unknown id, or `POST /sign` on a policy refusal that should surface as an HTTP error rather than a 200 body):
```ts
app.post("/approvals/:id", async (c) => {
  const approval = await findApproval(c.req.param("id"));
  if (!approval) throw new HTTPException(404, { message: "approval not found" });
  // ...
});
```
SOURCE (Context7 `/websites/hono_dev`, `hono.dev/docs/api/exception` — "Throwing HTTPException with Custom Message" / "...with Cause").

---

## 3. Minimal snippets for our endpoints

These wire together §1 and §2 into the shapes `apps/firewall` needs. They are composition sketches for WU3/WU8/WU9, not a full implementation.

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { subscribe, publish } from "./events-bus";

const jev = new TypeSafeClient({ defaultModel: "jev-1.13.0" }); // pinned, §1.6

const app = new Hono();
app.use("/*", cors({ origin: process.env.DASHBOARD_ORIGIN, credentials: true }));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.text("Internal Server Error", 500);
});

const IntentSchema = z.object({ /* TaskIntent fields, see WU1 packages/shared */ });
app.post("/intents", zValidator("json", IntentSchema, (r, c) => {
  if (!r.success) return c.json({ error: "invalid_intent", issues: r.error.issues }, 400);
}), async (c) => {
  const intent = c.req.valid("json");
  // verify EIP-712 signature, persist, return id — WU3
  return c.json({ id: "intent_..." }, 201);
});

const SignRequestSchema = z.object({ intentId: z.string(), paymentRequirement: z.unknown() });
app.post("/sign", zValidator("json", SignRequestSchema), async (c) => {
  const req = c.req.valid("json");
  // pipeline: idempotency -> policy -> provenance -> Intercepta -> Jev -> World ID -> sign (WU3, WU6-11)
  // Jev call inside the pipeline (WU8), fail-closed per §1.5:
  // const result = await jev.systemOne({ state, questions: QUESTIONS }, { timeout: 3000 });
  const receipt = { /* DecisionReceipt */ };
  publish({ id: "evt_...", payload: receipt }); // WU9
  return c.json(receipt);
});

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((evt) =>
      void stream.writeSSE({ data: JSON.stringify(evt.payload), event: "receipt", id: evt.id })
    );
    stream.onAbort(unsubscribe);
    while (!stream.aborted) await stream.sleep(30_000);
  })
);

app.post("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  // resolve World ID approval/deny/expire — WU11
  return c.json({ id, status: "approved" });
});

export default { port: process.env.PORT || 8787, fetch: app.fetch };
```

---

## Sources

- **Context7**: `/websites/typesafe_ai_sdk_javascript` (client config, `systemOne`, question builders, `RetryPolicy`, error classes — high reputation, 221 snippets); `/websites/hono_dev` (app setup, streaming, validation, CORS, error handling — high reputation, 1199 snippets); `/honojs/middleware` (`@hono/zod-validator` README — hook/default-error behavior). All matched and had usable, current docs — no fallback to raw source-diving was needed for Hono; TypeSafe SDK internals additionally cross-checked against the already-verified GitHub source citations in `jev-diseno.md`.
- **Live docs** (wigolo fetch, 2026-09-25): `docs.typesafe.ai/models.md` (rate limits, model aliasing/pinning, context length, pricing); `hono.dev/docs/middleware/builtin/cors` (import path, full options).
- **Spike code** (read-only, `/private/tmp/claude-501/-Users-juanma-Desktop-eth-global/b83978dc-042a-4bd1-a6ae-463bc6ddf44a/scratchpad/jev-spike/`): `env.ts`, `smoke-test.ts`, `questions.ts`, `decide.ts`, `package.json` — exact working call shape, live-tested against the real API (see `spike-jev-resultados.md` for the 39-case run).
- **Already-verified, reused without re-verification**: `jev-diseno.md` §1 (SDK init, `systemOne` response shape, answer types, verified against `typesafe-ai/typesafe-sdk-js` @ tag `v0.6.0`), §3–4 (calibrated question wording is in `spike-jev-resultados.md` §6.1, post-round-3 — use that version, not `jev-diseno.md`'s original draft).
