# World ID para el Intent Firewall — guía de implementación

Investigado el 2026-09-25 para el paso 5 del pipeline (`20-producto.md`): "si hay duda o supera el umbral → World ID (aprobación humana fresca)". Fuentes primarias leídas en esta sesión: `sandbox.auth.world.org/docs` (fetch directo), el documento de descubrimiento OIDC (fetch directo), `docs.world.org/*` (fetch directo), el repo `worldcoin/human-in-the-loop` (leído con `gh api`, código fuente completo, no solo el README), y dos páginas del showcase de ETHGlobal (`HumanMandate`, `BookerBob`) leídas en vivo con Playwright en esta misma sesión. Convención: **VERIFICADO (fuente)** = confirmado en esta sesión contra la fuente citada; **NO VERIFICADO** = no se encontró una fuente pública que lo confirme, o requiere una prueba en vivo que no se pudo hacer sin credenciales.

## TL;DR — recomendación

**World ID for Agents (Sección A) hoy solo anuncia la credencial `orb-v3` — VERIFICADO contra el documento de descubrimiento OIDC**, tanto en `sandbox.auth.world.org` como en `auth.world.org` (producción). Si nadie del equipo tiene una cuenta de World App verificada por Orb, el camino A puede quedar bloqueado incluso con acceso al portal. Además, **el portal (`sandbox.auth.world.org/portal`) exige "una cuenta de Google permitida" — VERIFICADO contra el texto propio de la página de login**, es decir, hay lista de acceso.

**Recomendación:** llevar los dos caminos en paralelo los primeros 15 minutos después del workshop (17:30 JST). Si a los 15 minutos no hay acceso al portal de Agents **o** nadie tiene cuenta Orb, pasar de inmediato al Plan B (Sección B: IDKit + `@worldcoin/human-in-the-loop`), que no requiere Orb (soporta `selfieCheck`) y cuyo portal (`developer.world.org`) no mostró señales de lista de acceso en esta investigación.

---

## A) World ID for Agents — Human Continuity IdP (OIDC)

### Qué es

**VERIFICADO** (`https://sandbox.auth.world.org/docs`, fetch directo). Cita textual:

> "World ID uses zero-knowledge proofs so the same verified person can be recognized over time while preserving privacy. The Human Continuity IdP makes that recognition available to applications through OpenID Connect."
>
> "For agent experiences, the application uses the same OIDC federation, binds the issuer and subject to its own account or grant, and issues credentials for its APIs or MCP server."
>
> "Give agent experiences a persistent connection to the human who authorized them, with fresh authentication for important actions."

Para nuestro caso: no necesitamos la parte de "continuidad" (reconocer al mismo humano entre sesiones); usamos la pieza de **fresh authentication** — cada pago dudoso dispara una verificación nueva, no una sesión reutilizada.

### Descubrimiento OIDC (endpoints exactos)

**VERIFICADO** — fetch directo a `https://sandbox.auth.world.org/.well-known/openid-configuration` en esta sesión (también se confirmó el equivalente en producción, `https://auth.world.org/.well-known/openid-configuration`, con la misma forma):

```json
{
  "issuer": "https://sandbox.auth.world.org",
  "authorization_endpoint": "https://sandbox.auth.world.org/api/v1/authorize",
  "token_endpoint": "https://sandbox.auth.world.org/api/v1/token",
  "device_authorization_endpoint": "https://sandbox.auth.world.org/api/v1/device_authorization",
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "private_key_jwt"],
  "token_endpoint_auth_signing_alg_values_supported": ["RS256"],
  "jwks_uri": "https://sandbox.auth.world.org/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
  "scopes_supported": ["openid"],
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "jti", "nonce", "auth_time", "acr", "amr"],
  "prompt_values_supported": ["none", "login"],
  "acr_values_supported": ["https://world.org/oidc/acr/orb-v3"],
  "subject_types_supported": ["pairwise"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "code_challenge_methods_supported": ["S256"],
  "request_uri_parameter_supported": false
}
```

Puntos clave que esto confirma (y que 15-validacion-tecnica.md dejaba como ⚠️):
- **`acr_values_supported` solo trae `orb-v3`.** No hay `passport`, `selfie` ni `document` expuestos a nivel de descubrimiento para este IdP (a diferencia de IDKit, que sí ofrece `selfieCheck`/`passport`/`identityCheck` — ver Sección B). **Riesgo confirmado, no solo sospechado.**
- **Sí soporta el Device Authorization Grant** (`urn:ietf:params:oauth:grant-type:device_code` en `grant_types_supported`), que es el flujo que necesitamos (el backend dispara el pedido, el humano aprueba en su teléfono, el backend sondea).
- `prompt_values_supported: ["none", "login"]` confirma que `prompt=login` es un valor válido para el IdP en general, pero **no confirma en qué endpoint se acepta** (ver "No verificado" abajo).
- `jwks_uri` da la clave pública para validar el ID token: `https://sandbox.auth.world.org/.well-known/jwks.json` (**VERIFICADO**, fetch directo — devuelve un único JWK RSA, `alg: RS256`, `use: sig`).
- `token_endpoint_auth_methods_supported` incluye `client_secret_basic`: podemos autenticar con `Authorization: Basic base64(client_id:client_secret)`, sin exponer el secreto en el cliente.

### Portal y credenciales necesarias

**VERIFICADO** — fetch directo a `https://sandbox.auth.world.org/portal`:

> "Sign in to your workspace — Build with World ID. Manage your apps, credentials, and team in one place. **Use a Google account permitted for your portal.**"

Esto confirma la sospecha de `15-validacion-tecnica.md`: hay una lista de acceso por cuenta de Google. La raíz (`sandbox.auth.world.org/`) muestra un login con World App ("Sign in or create an account — Use World ID app to sign in"), que es la pantalla que ve un *usuario final* del flujo, no la del portal de desarrollador.

Credenciales que emite el portal (según `docs.world.org/world-id/idkit/integrate`, que describe el mismo patrón para el portal hermano de IDKit): `app_id`, `rp_id`, `signing_key`. Para el IdP de Agents específicamente, lo que documenta la página son `client_id` y `client_secret` (o una `private_key_jwt`), consistentes con `token_endpoint_auth_methods_supported`. **NO VERIFICADO:** no se pudo confirmar el nombre exacto de los campos que muestra el portal de Agents porque el acceso está bloqueado por la lista de Google; inferido de la spec OIDC estándar y del patrón hermano de IDKit.

### MCP server

**VERIFICADO parcialmente**: la página de docs menciona "Connect your coding agent to the MCP server at `/mcp` and let it guide you through the integration", y lista RFC 8414, RFC 9728 y RFC 7009 como parte de la superficie OAuth del MCP. Un `GET` directo a `https://sandbox.auth.world.org/mcp` devuelve `405 Method Not Allowed` (**VERIFICADO**, fetch directo), consistente con un endpoint MCP que exige el handshake correcto (POST con `Content-Type: application/json`, protocolo Streamable HTTP) y no un simple `GET`. **NO VERIFICADO:** el comportamiento real del handshake MCP; no se probó con un cliente MCP real en esta sesión.

### Flujo Device Authorization (RFC 8628) contra el sandbox

**VERIFICADO como estándar** (RFC 8628, nombrado explícitamente en `docs.world.org` como "confidential-client device login with explicit human approval"). El *shape* exacto de los payloads no está documentado en una página pública aparte del propio RFC — se construye así:

```ts
// firewall/worldid-agents-device-flow.ts
// bun add jose   (validación del ID token; ver sección "Validar el ID token")

const ISSUER = "https://sandbox.auth.world.org";
const CLIENT_ID = process.env.WORLD_AGENTS_CLIENT_ID!;
const CLIENT_SECRET = process.env.WORLD_AGENTS_CLIENT_SECRET!;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** Paso 1: el Firewall pide el device_code. Nadie tocó todavía el teléfono del humano. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorizationResponse> {
  const res = await fetch(`${ISSUER}/api/v1/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    // NO VERIFICADO: si el endpoint acepta `prompt`/`acr_values` como parámetros
    // extra del cuerpo (el discovery document los expone a nivel de IdP, pero no
    // dice en qué endpoint se leen). Probar agregando prompt: "login" acá y
    // confirmarlo contra el sandbox real; mientras tanto, la frescura la
    // garantizamos nosotros mismos validando `auth_time` más abajo.
    body: new URLSearchParams({ scope: "openid" }),
  });

  if (!res.ok) {
    throw new Error(`device_authorization falló: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
```

```ts
// Paso 2: sondear el token endpoint hasta que el humano apruebe, rechace o expire.
// Los códigos de error (`authorization_pending`, `slow_down`, `access_denied`,
// `expired_token`) son los estándar de RFC 8628 §3.5 — VERIFICADO contra el RFC,
// NO VERIFICADO contra una corrida real en sandbox.auth.world.org (probarlo
// temprano en el spike de 60 minutos, sección D).

export class WorldIdDenied extends Error {}
export class WorldIdExpired extends Error {}

export async function pollForApproval(
  device: DeviceAuthorizationResponse
): Promise<{ id_token: string; access_token?: string; token_type: string; expires_in: number }> {
  let intervalMs = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));

    const res = await fetch(`${ISSUER}/api/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: CLIENT_ID,
      }),
    });

    const data = await res.json();
    if (res.ok) return data;

    switch (data.error) {
      case "authorization_pending":
        continue; // el humano todavía no respondió en World App
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new WorldIdDenied("El humano rechazó la aprobación");
      case "expired_token":
        throw new WorldIdExpired("El device_code expiró antes de la aprobación");
      default:
        throw new Error(`token error: ${data.error} — ${data.error_description ?? ""}`);
    }
  }
  throw new WorldIdExpired("Se agotó expires_in sin respuesta");
}
```

**Cómo completa el humano la aprobación:** el flujo estándar RFC 8628 espera que el humano abra `verification_uri` (o escanee/toque `verification_uri_complete`) y confirme desde su dispositivo. Para World ID, ese dispositivo es World App. **NO VERIFICADO:** si existe una compilación sandbox/simulador de World App para completar este paso sin depender de la app de producción (como sí existe para IDKit, ver Sección B), o si es la misma World App de producción apuntando al issuer de sandbox. Es la primera pregunta del workshop (Sección D).

### `prompt=login`, `acr` y frescura de `auth_time`

**VERIFICADO que el estándar existe** (docs.world.org lista `RFC 9470 · Authentication Step Up — OIDC freshness controls and the downstream challenge-and-retry boundary` como parte de la superficie implementada). **NO VERIFICADO** el detalle exacto de cómo se dispara el challenge-and-retry de RFC 9470 contra el device flow (RFC 9470 se diseñó sobre todo para el flujo interactivo de `authorization_endpoint`, no está claro si aplica igual al device flow).

**Postura recomendada, defensiva:** no depender de que el IdP fuerce la frescura por nosotros. Cada vez que el pipeline necesita una aprobación, arrancamos un `device_authorization` nuevo (nunca reutilizamos un token viejo), y además validamos `auth_time` nosotros mismos al recibir el ID token:

```ts
// Validar el ID token — jose (recomendado: liviano, sin abstracción de "client"
// completa; encaja bien en un servicio bun/TS que ya usa fetch a mano para x402).
// bun add jose

import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function verifyFreshApproval(
  idToken: string,
  opts: { maxAuthAgeSeconds: number }
) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ISSUER,
    audience: CLIENT_ID,
  }); // firma RS256 + iss + aud ya verificados acá — VERIFICADO (jose, jwtVerify)

  const authTime = payload.auth_time as number | undefined;
  if (typeof authTime !== "number") {
    throw new Error("ID token sin auth_time: no se puede validar frescura");
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authTime;
  if (ageSeconds > opts.maxAuthAgeSeconds) {
    throw new Error(`Aprobación de hace ${ageSeconds}s, excede el máximo de ${opts.maxAuthAgeSeconds}s`);
  }

  if (payload.acr !== "https://world.org/oidc/acr/orb-v3") {
    throw new Error(`acr inesperado: ${payload.acr}`);
  }

  return payload; // sub (pairwise, ligado a este client), acr, auth_time, amr
}
```

`payload.auth_time`, `payload.acr` están en `claims_supported` del discovery document — **VERIFICADO** que el IdP los emite; **NO VERIFICADO** el valor exacto de `amr` (no se pudo generar un token real sin credenciales).

**Alternativa con `openid-client` (recomendación B):** si se prefiere no manejar el sondeo a mano, `openid-client` v6 automatiza discovery + device flow + reintentos, y expone los claims ya validados con `.claims()`. Confirmado leyendo el código fuente del paquete (`gh api repos/panva/openid-client/contents/src/index.ts`, no solo el README):

```ts
// bun add openid-client
import * as client from "openid-client";

const config = await client.discovery(
  new URL(ISSUER),
  CLIENT_ID,
  CLIENT_SECRET
); // VERIFICADO — client.discovery(server, clientId, clientSecret), src/index.ts:1332

const device = await client.initiateDeviceAuthorization(config, { scope: "openid" });
// VERIFICADO — src/index.ts:2423
console.log(`Aprobá en: ${device.verification_uri_complete ?? device.verification_uri} (código ${device.user_code})`);

const tokens = await client.pollDeviceAuthorizationGrant(config, device);
// VERIFICADO — src/index.ts:2374; sondea con backoff (`slow_down`) y reintentos automáticos

const claims = tokens.claims();
// VERIFICADO — src/index.ts:2089, delega en oauth4webapi `getValidatedIdTokenClaims`
// (firma + estructura ya chequeadas). auth_time SIGUE necesitando el chequeo manual
// de arriba: DeviceAuthorizationGrantPollOptions no trae `maxAge` (ese chequeo
// automático solo existe en la rama de authorization_code, confirmado leyendo
// el código fuente — src/index.ts:2350-2094 vs. la firma de
// DeviceAuthorizationGrantPollOptions en la línea 2142).
```

**Decisión:** para el MVP, usar el camino con `fetch` + `jose` de arriba (menos dependencias, ya estamos en el ecosistema de `viem`/`fetch` a mano para x402). `openid-client` es la opción B si sobra tiempo y se quiere menos código de manejo de errores propio.

### Caminos fallidos (`access_denied`, `expired_token`)

**VERIFICADO como estándar RFC 8628**, **NO VERIFICADO contra el sandbox real de World** (no se pudo generar un `device_code` sin `client_id`/`client_secret`). El código de arriba (`pollForApproval`) ya mapea ambos casos a excepciones tipadas (`WorldIdDenied`, `WorldIdExpired`) que el pipeline debe tratar igual: **fail-closed → `refuse`**, nunca reintenta silenciosamente ni asume aprobación.

### Resumen de lo NO verificado en la Sección A

| Pregunta | Por qué importa | Dónde se intentó verificar |
|---|---|---|
| ¿El portal de Agents nos da acceso hoy? | Bloquea todo el camino A | Portal exige cuenta de Google permitida (confirmado) |
| ¿Se puede completar el device flow sin Orb? | `acr_values_supported` solo trae `orb-v3` | Discovery document (confirmado el límite; no confirmado si hay excepción) |
| ¿Hay simulador de World App para sandbox? | Sin él, no hay forma de aprobar sin un teléfono con Orb real | No se encontró documentación pública al respecto |
| ¿`prompt`/`acr_values` se aceptan en `device_authorization`? | Definiría si la frescura la fuerza el IdP o solo nosotros | Discovery expone los valores a nivel de IdP, no el endpoint que los consume |
| ¿Qué error exacto devuelve el token endpoint en `access_denied`/`expired_token`? | Necesario para manejar el camino fallido obligatorio del track | RFC 8628 estándar; no probado en vivo |

---

## B) Plan B — IDKit + `@worldcoin/human-in-the-loop`

### Arquitectura real (leída del código fuente, no solo del README)

`gh api repos/worldcoin/human-in-the-loop/git/trees/main` + lectura de cada archivo relevante con `gh api .../contents/<path>` — **VERIFICADO**, repo público, MIT, versión del paquete server `0.2.1`, versión del paquete React `0.1.1` (confirmado en sus `package.json`).

El repo es un monorepo de dos paquetes npm más un ejemplo:

| Paquete | Qué hace |
|---|---|
| `@worldcoin/human-in-the-loop` | Server. Expone `requestHumanAuthorization()`, una función que arma un `execute` de tool (Vercel AI SDK) que pausa un workflow de `useworkflow.dev` hasta recibir un proof. |
| `@worldcoin/human-in-the-loop-react` | Client. `<HumanApproval>` (componente listo) y `useHumanApproval` (hook headless) que renderizan `IDKitRequestWidget` de `@worldcoin/idkit` y postean el proof de vuelta. |
| `examples/flight-booking` | App Next.js completa que conecta las dos piezas de punta a punta. |

Flujo interno de `requestHumanAuthorization` (leído de `packages/human-in-the-loop/src/workflows/human-approval.ts`):

1. `signRequest({ signingKeyHex, action })` (de `@worldcoin/idkit-server`) firma un mensaje RP: nonce aleatorio + `created_at`/`expires_at` + hash del `action`, con firma ECDSA secp256k1 sobre un prefijo EIP-191 (`\x19Ethereum Signed Message:\n<len>`). El algoritmo exacto está documentado y **VERIFICADO** en `docs.world.org/world-id/idkit/signatures` (pseudocódigo completo, incluye la advertencia "usar Keccak-256, no SHA3-256").
2. Se crea un *webhook* (`createWebhook({ respondWith: "manual" })`, primitiva de `useworkflow.dev`) — es el punto de pausa.
3. Se emite al cliente, por streaming, `{ webhookUrl, action, rpContext }` (chunk `data-approval-context`).
4. El cliente (`<HumanApproval>`) recibe ese contexto, renderiza `IDKitRequestWidget` con `app_id`, `action`, `rp_context`, y cuando el humano completa la verificación en World App, hace `POST` del `IDKitResult` al `webhookUrl`.
5. El server retoma la ejecución (`await webhook`), y **antes de devolver el proof al agente**, lo reenvía a `POST https://developer.world.org/api/v4/verify/{rp_id}`. Si la verificación falla, responde error al webhook y lanza; si es ok, responde 200 y devuelve el proof.
6. El `action` es la pieza de seguridad clave: **por defecto es el `toolCallId`**, pero se puede — y en el ejemplo de `flight-booking` se hace — derivar de los parámetros exactos de la operación sensible (ver abajo), de forma que una aprobación para una reserva no sirva para otra.

Patrón de "doble verificación" del ejemplo `flight-booking` (`examples/flight-booking/src/workflows/chat/steps/tools.ts`), directamente reutilizable para nuestro caso:

```ts
// Del repo real, adaptado con comentarios propios.
function deriveBookingAction({ flightNumber, passengerName, seatPreference }) {
  return `book-flight:${JSON.stringify([flightNumber, passengerName, seatPreference])}`;
}

// bookFlight() vuelve a chequear DOS cosas antes de ejecutar la acción sensible:
// 1) que el `action` del proof coincide exactamente con lo que se está por
//    ejecutar ahora (no otra reserva).
// 2) que el proof vuelve a verificar contra /v4/verify (no confía en que el LLM
//    no lo haya inventado ni reusado).
```

Esto es exactamente el patrón que necesitamos para el Firewall: el `action` de la aprobación debe derivarse del `PaymentRequired` pendiente (destino, monto, asset, nonce de la intención), no de un `toolCallId` genérico — así una aprobación nunca sirve para "otro" pago.

### Adaptar el patrón a nuestro Firewall (Node/TS, bun, sin Next.js ni Vercel Workflow SDK)

El paquete `@worldcoin/human-in-the-loop` depende de la capa de durabilidad de `useworkflow.dev` (`'use step'`, `'use workflow'`, `createWebhook`) — pensada para apps Next.js/Vercel. Nuestro Firewall es un servicio bun/TS plano (no Next.js), así que **no conviene instalar el paquete completo**; conviene usar directamente sus dos dependencias reales (`@worldcoin/idkit-server` para firmar, el endpoint `/v4/verify` a mano) y escribir nuestra propia primitiva de "pausa", que es trivial porque el Firewall ya tiene un dashboard con SSE (`20-producto.md`, sección 8) — el mismo canal sirve para emitir el pedido de aprobación.

```ts
// firewall/worldid-stepup-idkit.ts
// bun add @worldcoin/idkit-server @worldcoin/idkit-core

import { signRequest } from "@worldcoin/idkit-server";
import type { IDKitResult } from "@worldcoin/idkit-core";

const RP_ID = process.env.WORLD_RP_ID!;          // del developer portal (developer.world.org)
const SIGNING_KEY = process.env.WORLD_SIGNING_KEY!; // NUNCA sale del server

export function createApprovalRequest(action: string) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: SIGNING_KEY,
    action,
  }); // VERIFICADO — firma packages/human-in-the-loop/src/workflows/human-approval.ts
  return {
    action,
    rpContext: { nonce, signature: sig, created_at: createdAt, expires_at: expiresAt, rp_id: RP_ID },
  };
}

// Deriva el `action` del pago pendiente, igual que flight-booking deriva el suyo
// de los parámetros exactos de la reserva.
export function derivePaymentAction(paymentRequired: {
  payTo: string; asset: string; maxAmountRequired: string;
}, intentId: string): string {
  return `firewall-payment:${JSON.stringify([
    paymentRequired.payTo, paymentRequired.asset, paymentRequired.maxAmountRequired, intentId,
  ])}`;
}

// "Pausa" propia: el Firewall guarda un resolver por paymentId. El dashboard
// (SSE) ya emite eventos en vivo — reusamos ese mismo canal para mandar
// { action, rpContext, appId } al navegador del humano.
const pending = new Map<string, { resolve: (p: IDKitResult) => void; reject: (e: Error) => void }>();

export function waitForApproval(paymentId: string, timeoutMs: number): Promise<IDKitResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(paymentId);
      reject(new Error("world_id_expired")); // fail-closed
    }, timeoutMs);
    pending.set(paymentId, {
      resolve: p => { clearTimeout(timer); resolve(p); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
  });
}

// Handler del endpoint que el widget del dashboard llama al terminar
// (POST /approvals/:paymentId/webhook).
export async function submitApproval(paymentId: string, expectedAction: string, proof: IDKitResult) {
  const entry = pending.get(paymentId);
  if (!entry) throw new Error("no hay una aprobación pendiente para este paymentId");
  pending.delete(paymentId);

  if (proof.action !== expectedAction) {
    entry.reject(new Error("world_id_action_mismatch")); // el proof es de OTRO pago
    return;
  }

  const res = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  }); // VERIFICADO — shape exacto en docs.world.org/api-reference/developer-portal/verify

  if (!res.ok) {
    entry.reject(new Error(`world_id_verify_failed: ${await res.text()}`));
    return;
  }
  const result = await res.json();
  // result.environment debe ser "sandbox" o "staging" durante el hackathon —
  // rechazar si viniera "production" con credenciales de sandbox (mismatch).
  entry.resolve(proof);
}
```

En el pipeline (paso 5 de `20-producto.md`), cuando Jev devuelve `ask_human`:

```ts
const action = derivePaymentAction(paymentRequired, intent.id);
const { rpContext } = createApprovalRequest(action);

dashboard.emitApprovalRequest({ paymentId, action, rpContext, appId: process.env.NEXT_PUBLIC_WORLD_APP_ID });

try {
  const proof = await waitForApproval(paymentId, 120_000); // 120s, fail-closed al expirar
  // proof.action y la verificación /v4/verify ya se validaron en submitApproval
} catch {
  return { decision: "refuse", reason: "world_id_denied_or_expired" };
}
// recién acá: createPaymentPayload(...)
```

Del lado del dashboard (React), en vez de depender del paquete `-react` completo (que asume el streaming de Vercel AI SDK), se usa `@worldcoin/idkit` directamente:

```tsx
// dashboard: al recibir { action, rpContext, appId } por SSE, renderizar:
import { IDKitRequestWidget, orbLegacy } from "@worldcoin/idkit";

<IDKitRequestWidget
  open={open}
  onOpenChange={setOpen}
  handleVerify={async (proof) => {
    await fetch(`/approvals/${paymentId}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
  }}
  onSuccess={() => {}}
  app_id={appId as `app_${string}`}
  action={action}
  rp_context={rpContext}
  preset={orbLegacy()} // ver "Credenciales" abajo — cambiar según lo que se pruebe
  allow_legacy_proofs={false}
/>
```

Ningún secreto (`WORLD_SIGNING_KEY`) toca el cliente en ningún punto de este diseño — cumple el requisito del track ("do not expose client secrets").

### Variables de entorno

**VERIFICADO** contra el README del repo (tabla "Where these come from"):

| Variable | Dónde se usa | Qué es |
|---|---|---|
| `WORLD_RP_ID` | server (`signRequest`, `/v4/verify/{rp_id}`) | Relying-party ID del Developer Portal |
| `WORLD_SIGNING_KEY` | server (`signRequest`) | Firma el request RP — secreto, nunca al cliente |
| `NEXT_PUBLIC_WORLD_APP_ID` | cliente (`IDKitRequestWidget`) | `app_id` público del Developer Portal |

### Developer Portal (`developer.world.org`) — setup

**VERIFICADO** contra `docs.world.org/world-id/idkit/integrate`:
1. Crear la app en `https://developer.world.org`.
2. Si es una app vieja, completar "RP registration" con el banner "Enable World ID 4.0".
3. Guardar `app_id`, `rp_id`, `signing_key` (el `signing_key` se guarda como secreto — es `WORLD_SIGNING_KEY`).
4. Elegir el preset de credencial (`proofOfHuman`, `selfieCheck`, `passport`, `identityCheck`) — ver la tabla completa en la sección "Credenciales" más abajo.

A diferencia del portal de Agents (Sección A), **no se encontró mención de lista de acceso** para `developer.world.org` en la documentación pública leída en esta sesión. **NO VERIFICADO** si en la práctica también pide alguna aprobación — no se intentó crear una app real sin credenciales del equipo.

### Verificación server-side — `POST /api/v4/verify/{rp_id}`

**VERIFICADO** — fetch directo a `docs.world.org/api-reference/developer-portal/verify`. Request y response reales (ejemplo de la documentación, no generado por nosotros):

```bash
curl --request POST \
  --url https://developer.world.org/api/v4/verify/{rp_id} \
  --header 'Content-Type: application/json' \
  --data '{
    "protocol_version": "3.0",
    "nonce": "0xabc123",
    "action": "my_action",
    "responses": [{
      "identifier": "orb",
      "merkle_root": "0x2264a66d...",
      "nullifier": "0x2bf84068...",
      "proof": "0x1aa8b8f3...",
      "signal_hash": "0x00c5d246...",
      "max_age": 304200
    }]
  }'
```

```json
{
  "success": true,
  "results": [{ "identifier": "<string>", "success": true, "nullifier": "<string>", "code": "<string>", "detail": "<string>" }],
  "action": "<string>",
  "nullifier": "<string>",
  "created_at": "2023-11-07T05:31:56Z",
  "environment": "production",
  "session_id": "session_5f3a9c2e...8d1b0a",
  "message": "<string>"
}
```

`rp_id` (`rp_...`) es el recomendado; `app_id` (`app_...`) sigue aceptado por compatibilidad. **Chequear siempre `environment` en la respuesta** (debe ser `"sandbox"` o `"staging"` durante el hackathon — nunca tratar como válida una respuesta con `"production"` si se usaron credenciales de sandbox) — esto es lo que exige el track ("Check that the verify response's environment matches your backend's expected environment").

### Sandbox / simulador sin Orb

**VERIFICADO** — `docs.world.org/world-id/idkit/integrate`, paso 4: *"To test during development, use the simulator (`https://simulator.worldcoin.org/`) and set `environment` to `"staging"`."* Este es el camino recomendado para probar el flujo completo sin depender de un Orb físico ni de una cuenta World App real durante el desarrollo.

### Credenciales disponibles en IDKit (a diferencia de Agents/Sección A)

**VERIFICADO** — `docs.world.org/world-id/idkit/credentials`:

| Credencial | Qué prueba | Necesita Orb |
|---|---|---|
| Proof of Human (`proofOfHuman`) | Humano único, biometría del Orb | Sí |
| Passport (`passport`) | Pasaporte NFC verificado | No (NFC) |
| Selfie Check (`selfieCheck`) | Liveness + similitud facial por cámara del dispositivo | **No** — "Anyone with World ID App can complete the flow—no Orb or document credential is required" |
| Identity Check (`identityCheck`, preview) | Atributos respaldados por documento (edad mínima, nacionalidad, tipo de documento) | Depende del documento |

`selfieCheck` es, en teoría, el camino sin Orb para el equipo. **Ver el riesgo reportado por BookerBob abajo antes de confiar en él para la demo.**

### Riesgo reportado: bug de Selfie / no-Orb (proyecto BookerBob)

**VERIFICADO** — leído en vivo con Playwright contra `https://ethglobal.com/showcase/bookerbob-6zjih` en esta sesión (proyecto de ETHGlobal Lisboa 2026, ganador de "World - AgentKit New Use Cases 2nd place"). Cita textual completa de su sección "Notable":

> "Feedback: World App reports success while the browser relying-party gets failure (Selfie / non-orb)."
>
> "Witnessed by the World team at the ETHGlobal Lisbon booth, who asked us to submit this."
>
> "Two World team members WITH an Orb credential: the flow passed end to end, on both the World App and the browser. Me, WITHOUT an Orb (relying on Selfie / Face): the World App showed SUCCESS, but the browser relying-party surface reported failure ('Something went wrong, we couldn't complete your request'). Reproduced 4 times in a row; the face check never carried through to the web."
>
> "Root cause we found (also feedback): In the production World App 'Add credential' screen, Face credential (i.e. Selfie Check, credential 11) is shown as 'Coming soon' and is not available. A non-orb user therefore has no credential that satisfies our `[\"selfie\",\"proof_of_human\"]` request, yet the app surfaces success rather than a clear 'credential unavailable' the browser could show the user."
>
> "We could only self-diagnose via `POST /api/v1/precheck/{app_id}` (`is_staging`, `enable_face_check`, `can_user_verify`), which is not documented in the 4.0 docs; we found it by trial."

Implicaciones directas para nosotros:
- El reporte es de ETHGlobal **Lisboa** (anterior a este evento de Tokio); **NO VERIFICADO** si ya está corregido a día de hoy (25/09/2026) — es la pregunta más importante para el workshop.
- Si persiste, ningún integrante del equipo sin Orb podría completar `selfieCheck` de forma confiable, aunque World App muestre éxito — el fallo aparece del lado del navegador/relying party, silencioso.
- `POST /api/v1/precheck/{app_id}` (con `app_id` propio) es un endpoint no documentado que BookerBob usó para auto-diagnosticar si Selfie está habilitado para una app — vale la pena probarlo temprano, pero está fuera de la documentación 4.0 oficial (mencionarlo así si se usa, para no reclamar soporte oficial).

---

## C) Atestación EIP-712 "StepUp" (patrón HumanMandate)

### La referencia

**VERIFICADO** — leído en vivo con Playwright contra `https://ethglobal.com/showcase/humanmandate-wbx5i` en esta sesión (proyecto de ETHGlobal Lisboa 2026). Cita textual de su sección "How it's Made":

> "Raising limits is the only action that requires a human. The World App mini-app (Next.js 15 + MiniKit) runs a Selfie liveness check; our backend verifies the proof (IDKit + RP signing — MiniKit 2.x removed `verify()`), binds it to the payer via `signal_hash`, and an attestor key signs an EIP-712 StepUp attestation that the contract checks inside `raiseLimits`."

Puntos clave del patrón, tal como lo implementaron ellos:
- El humano **no firma** la atestación EIP-712 directamente — firma la verificación de World ID (Selfie liveness, en su caso).
- El backend, **después** de verificar el proof server-side, liga el resultado al pagador vía `signal_hash` (el campo estándar de IDKit para atar el proof a un contexto de la app).
- Una **clave "atestadora"** separada (el "attestor key", controlada por el propio backend) firma el struct EIP-712 — es una conversión de "hubo una aprobación humana válida" en un objeto verificable y portable.
- Un contrato Solidity (`raiseLimits`) chequea esa firma antes de ejecutar la acción sensible (en su caso, subir el límite de gasto).

### Adaptación al Intent Firewall

En nuestro MVP no hay contrato propio (nivel 4 de `20-producto.md`, "smart wallet ERC-1271 con allowlist onchain", está marcado como bonus, no MVP). La atestación StepUp acá sirve como **evidencia off-chain verificable**, guardada junto al recibo de la decisión (mejora "SHOULD" ya identificada en `23-inspiracion.md`), y queda lista para verificarse on-chain si se llega al nivel 4.

```ts
// firewall/stepup-attestation.ts
// bun add viem

import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, verifyTypedData } from "viem";

const STEPUP_DOMAIN = {
  name: "IntentFirewallStepUp",
  version: "1",
  chainId: 84532, // Base Sepolia — liga la atestación a esta red, evita colisión
  // sin verifyingContract: es off-chain en el MVP; se agrega si se implementa
  // el contrato del nivel 4.
} as const;

const STEPUP_TYPES = {
  StepUpApproval: [
    { name: "firewall", type: "address" },        // wallet del Firewall que va a firmar el pago
    { name: "intentId", type: "bytes32" },         // hash del TaskIntent EIP-712 firmado por el usuario
    { name: "paymentHash", type: "bytes32" },      // hash del PaymentRequired pendiente (payTo, asset, amount)
    { name: "worldIdNullifier", type: "uint256" }, // nullifier del proof — ligado a acción + humano, no reusable
    { name: "authTime", type: "uint64" },          // auth_time (Sección A) o created_at del proof (Sección B)
    { name: "expiresAt", type: "uint64" },         // vencimiento de la atestación misma
  ],
} as const;

const attestor = privateKeyToAccount(process.env.STEPUP_ATTESTOR_KEY as `0x${string}`);
// Puede ser una subclave separada de la wallet que firma el pago x402 —
// separa "quién paga" de "quién certifica que hubo un humano" (defensa en
// profundidad, igual espíritu que el nivel 4 de 20-producto.md).

export function paymentHashOf(paymentRequired: {
  payTo: string; asset: string; maxAmountRequired: string;
}, nonce: string): `0x${string}` {
  return keccak256(toHex(JSON.stringify({ ...paymentRequired, nonce })));
}

export async function signStepUp(params: {
  firewall: `0x${string}`;
  intentId: `0x${string}`;
  paymentHash: `0x${string}`;
  worldIdNullifier: bigint;
  authTime: bigint;
  expiresAt: bigint;
}) {
  const signature = await attestor.signTypedData({
    domain: STEPUP_DOMAIN,
    types: STEPUP_TYPES,
    primaryType: "StepUpApproval",
    message: params,
  });
  return { ...params, signature, signer: attestor.address };
}

// Verificación independiente (útil para el "verificador post-hoc" ya
// priorizado en research/showcase-inspiracion-2.md — "an application is
// never its own oracle").
export async function verifyStepUp(attestation: Awaited<ReturnType<typeof signStepUp>>) {
  return verifyTypedData({
    address: attestation.signer,
    domain: STEPUP_DOMAIN,
    types: STEPUP_TYPES,
    primaryType: "StepUpApproval",
    message: attestation,
    signature: attestation.signature,
  });
}
```

Dónde entra en el pipeline: inmediatamente después de que `waitForApproval`/`verifyFreshApproval` (Secciones A o B) resuelven con un proof válido, y **antes** de `createPaymentPayload`. El `paymentHash` liga la atestación a este pago exacto — si Jev o Intercepta bloquean un pago distinto, la atestación de este no aplica ahí (mismo principio que el `action` derivado de `flight-booking`, Sección B).

`worldIdNullifier` es el campo que responde a la mejora "COULD" de `research/showcase-inspiracion-2.md` (MANDATEE: "domain-bound nullifier guard") sin necesidad de nada on-chain: como cada `nullifier` de IDKit está ligado a `action` (que a su vez está ligado al pago exacto), una aprobación no puede reutilizarse silenciosamente para otra categoría de gasto.

---

## D) Checklist de integración (60 minutos) + preguntas para el workshop

### Checklist con presupuesto de tiempo

| Min | Tarea | Camino |
|---|---|---|
| 0–5 | Pedir acceso al portal `sandbox.auth.world.org/portal` con una cuenta de Google del equipo (mandarlo ya, antes/durante el workshop) | A |
| 0–5 | En paralelo, crear la app en `developer.world.org` (no mostró señales de lista de acceso) | B |
| 5–15 | Workshop de World (17:30 JST) — hacer las preguntas de abajo, en particular la de Orb/simulador | A y B |
| 15–20 | **Punto de decisión:** si a los 20 min no hay acceso al portal de Agents **o** nadie tiene cuenta Orb → descartar A por hoy y quedarse solo con B | — |
| 20–30 | Camino A (si sigue vivo): registrar client, capturar `client_id`/`client_secret`, correr `startDeviceAuthorization` + `pollForApproval` contra el sandbox real, confirmar los códigos de error en vivo | A |
| 20–35 | Camino B (siempre, en paralelo): capturar `app_id`/`rp_id`/`signing_key`, implementar `createApprovalRequest` + `/v4/verify`, probar contra `simulator.worldcoin.org` (`environment=staging`) sin tocar el dashboard real todavía | B |
| 35–45 | Probar `selfieCheck` contra una cuenta real sin Orb del equipo — confirmar si el bug de BookerBob sigue vivo, **antes** de comprometerse a ese camino para la demo | B |
| 45–55 | Conectar el módulo elegido al pipeline (rama `ask_human`) y al dashboard (SSE + `IDKitRequestWidget` o widget propio) | A/B |
| 55–60 | Probar los dos caminos fallidos obligatorios del track: rechazo humano → `refuse`, y expiración del timeout → `refuse`. Confirmar con la pestaña de red del navegador que ningún secreto (`WORLD_SIGNING_KEY`/`client_secret`) salió al cliente | A/B |

### Preguntas para el workshop de World (17:30 JST, "World's latest products (IDP vs IDKit)")

1. Para World ID for Agents (`sandbox.auth.world.org`): ¿nos pueden dar acceso al portal hoy? Y si nadie del equipo tiene cuenta verificada por Orb — el discovery document solo anuncia `acr` `orb-v3` — ¿hay alguna forma de completar el device flow sin Orb durante el hackathon?
2. ¿Existe una build sandbox o un simulador de World App para aprobar el device flow del IdP (equivalente a `simulator.worldcoin.org` para IDKit), o hay que usar la app real de producción apuntando al sandbox?
3. ¿El endpoint `device_authorization` acepta `prompt`/`acr_values` como parámetros del pedido (para forzar re-autenticación), o la frescura de `auth_time` es algo que el relying party debe validar siempre por su cuenta?
4. ¿Qué devuelve exactamente el token endpoint cuando el humano rechaza (vs. cuando el `device_code` simplemente expira) — los códigos estándar de RFC 8628 (`access_denied`/`expired_token`) u otros específicos de World?
5. El bug que reportó BookerBob en Lisboa (World App muestra éxito, pero el relying party del navegador recibe fallo, para usuarios sin Orb con Selfie) — ¿sigue reproduciéndose hoy? ¿Selfie Check (credencial 11) ya está habilitada en producción/sandbox?
6. `POST /api/v1/precheck/{app_id}` (que BookerBob encontró por prueba y error, no documentado en la doc 4.0) — ¿es un endpoint estable en el que podemos confiar para autodiagnosticar si Selfie está habilitada para nuestra app?
7. Para el track "Best Use of World ID for Agents": ¿una integración construida sobre IDKit + `@worldcoin/human-in-the-loop` (que usa IDKit por debajo) sigue calificando, dado que ese SDK está enmarcado como parte del track de IDKit, no del de Agents?
8. ¿Hay límites de tasa (rate limits) en el endpoint de verificación (`developer.world.org/api/v4/verify`) o en el IdP de Human Continuity que debamos conocer antes de una demo en vivo frente a los jueces?

---

## Fuentes usadas (todas leídas en esta sesión)

- `https://sandbox.auth.world.org/docs` — fetch directo (contenido completo)
- `https://sandbox.auth.world.org/.well-known/openid-configuration` — fetch directo
- `https://sandbox.auth.world.org/.well-known/jwks.json` — fetch directo
- `https://sandbox.auth.world.org/portal` y `https://sandbox.auth.world.org/` — fetch directo (app shell + copy de login)
- `https://sandbox.auth.world.org/mcp` — fetch directo (405 en GET)
- `https://auth.world.org/.well-known/openid-configuration` — fetch directo (equivalente de producción)
- `https://docs.world.org/world-id/idkit/integrate` — fetch directo
- `https://docs.world.org/world-id/idkit/verification-flows` — fetch directo
- `https://docs.world.org/world-id/idkit/credentials` — fetch directo
- `https://docs.world.org/world-id/idkit/signatures` — fetch directo
- `https://docs.world.org/api-reference/developer-portal/verify` — fetch directo
- `https://docs.world.org/world-id/credentials/1` — fetch directo
- `https://docs.world.org/agents/human-in-the-loop/integrate` — fetch directo
- `https://docs.world.org/agents/human-in-the-loop/sdk-reference` — fetch directo
- `https://github.com/worldcoin/human-in-the-loop` — leído con `gh api` (árbol completo + código fuente de ambos paquetes + ejemplo `flight-booking`, no solo el README)
- `https://github.com/panva/openid-client` — leído con `gh api` (README + `src/index.ts` completo, 4515 líneas)
- `https://github.com/panva/jose` — leído con `gh api` (`src/jwt/verify.ts`, `src/jwks/remote.ts`)
- `https://ethglobal.com/showcase/humanmandate-wbx5i` — leído en vivo con Playwright
- `https://ethglobal.com/showcase/bookerbob-6zjih` — leído en vivo con Playwright
- Contexto interno: `20-producto.md`, `15-validacion-tecnica.md` (sección World ID), `tracks/world.md`, `23-inspiracion.md`, `research/showcase-inspiracion-2.md`
