# Intercepta (Web3 Antivirus) — Guía de implementación para el firewall x402

Investigado el 2026-09-25, con fetch en vivo de `docs.web3antivirus.io` (sufijo `.md`), `intercepta.io/ethglobal`, el repo `x402-foundation/x402` y búsqueda en GitHub. Todo lo marcado **VERIFIED (URL)** viene de una fuente primaria consultada hoy; **UNVERIFIED** es inferencia razonada o dato no confirmado en las fuentes disponibles — no lo des por cierto sin probarlo con la key sandbox.

Contexto del diseño: nuestro firewall (Node/TS) intercepta el flujo del Guardian **antes** de llamar a `createPaymentPayload` / firmar el `transferWithAuthorization` (EIP-3009) sobre USDC en Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). En ese punto llamamos a Intercepta para screenear `payTo`, el token y la autorización, y el veredicto decide si se firma, se bloquea o se escala.

---

## 1. Endpoints: schemas y ejemplos

Base URL: `https://api.web3antivirus.io`. Auth: header `X-API-KEY` en todos los endpoints (`securitySchemes.X-API-KEY`, tipo `apiKey`, `in: header`). VERIFIED (https://docs.web3antivirus.io/reference/api-overview.md y cada página de referencia abajo).

### 1.1 Quick Scan Address (rápido)

`GET /api/public/v2/extension/account/{address}/quick-scan`
VERIFIED (https://docs.web3antivirus.io/reference/quick-scan-address.md)

- Path param: `address` (ETH address o ENS). Ejemplo del doc: `0x0d775e010f0b6c32c9468d43ba599ef47d596e47`.
- Respuesta `200` — `ToxicScoreShortResponseV2`:

```json
{
  "toxicScore": 0,
  "traits": [
    {
      "risk": 0,
      "name": "sanction_address",
      "txsCount": 0,
      "description": "string"
    }
  ]
}
```

- `traits[].name` es un enum cerrado: `known_scammer`, `initiator_scam_transactions`, `sanction_address_communication`, `suspicious_dex_pair_deployer`, `suspicious_deployer`, `attack_money_target`, `zero_address_risk`, `sanction_address`, `fake_phishing_transfer`, `non_kyc_transfers`, `mixer_transfers`, `fake_phishing_contract_communication`, `rug_pull`, `rug_pull_trader`, `blacklist`.
- Diseñado para baja latencia (real-time). No documenta un SLA de ms concreto — UNVERIFIED cuánto tarda en la práctica; medirlo en el spike.

### 1.2 Deep Scan Address (`toxic-score`)

`GET /api/public/v2/extension/account/{address}/toxic-score`
VERIFIED (https://docs.web3antivirus.io/reference/scan-address.md)

- Mismo path param y **misma forma de respuesta** que Quick Scan (`ToxicScoreShortResponseV2` — mismos campos `toxicScore`/`traits`). La diferencia documentada no es el schema sino la cobertura: revisa honeypots, phishing, blackmail, stealing, darkweb/cybercrime, lavado y sanciones, contratos maliciosos, gas abuse/reinit/fake-interface — más profundo que Quick Scan, mismo formato de salida.
- Ejemplo de respuesta (mismo shape que 1.1):

```json
{
  "toxicScore": 87,
  "traits": [
    { "risk": 90, "name": "sanction_address", "txsCount": 3, "description": "Address linked to an OFAC-sanctioned entity" },
    { "risk": 60, "name": "mixer_transfers", "txsCount": 12, "description": "Interacted with a known mixer" }
  ]
}
```
(Valores de ejemplo ilustrativos — la forma de los campos sí es la documentada; los números concretos son UNVERIFIED hasta correr una address real.)

### 1.3 Scan Token (riesgos del token)

`GET /api/public/v2/extension/token-intelligence/token/{address}/risks?chainId=`
VERIFIED (https://docs.web3antivirus.io/reference/scan-token.md)

- Path param: `address` (contract address). Query opcional: `chainId`, enum cerrado de **17 valores, todos mainnet**: `1868, 7777777, 1, 8453, 130, 146, 56, 137, 10, 42161, 480, 42220, 43114, 324, 81457, 59144, 999, 33139, 57073` (más `"solana"` como string). **`8453` = Base mainnet está en el enum** — clave para el mapping de §4.
- Respuesta `200` — `TokenRiskAnalysisV2Response`:

```json
{
  "apiVersion": "2.3.1",
  "saleTax": { "currentValue": 0, "minValue": 0, "maxValue": 0 },
  "buyTax": { "currentValue": 0, "minValue": 0, "maxValue": 0 },
  "riskScore": 70,
  "riskLevel": "high",
  "category": "malicious",
  "trust": "neutral",
  "action": "block",
  "detectors": [
    { "code": "FAKE_TOKEN", "description": "string" }
  ],
  "token": { "chainId": "8453", "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "symbol": "USDC" }
}
```

- `riskLevel` ∈ `neutral | low | medium | high`.
- `category` ∈ `malicious | restricted | suspicious | availability | sanctioned | unverified | info`.
- `trust` ∈ `whitelist | blocklist | neutral` — señal directa de allowlist para USDC real.
- **`action` ∈ `block | warn | info`** — es el campo pensado para decisiones automáticas (ver §5).
- `detectors[].code` (27 valores): `KNOWN_MALICIOUS, STATIC_CODE_SIGNATURE, RUG_PULL, JUNK_TOKEN, CONCENTRATED_SUPPLY_DISTRIBUTION, HIGH_SINGLE_OWNERSHIP, HONEYPOT, FAKE_TOKEN, BLOCKLIST_TOKEN, SCAM_AIRDROP_TOKEN, HIGH_TRANSFER_FEE, HIGH_BUY_FEE, HIGH_SELL_FEE, UNSELLABLE_TOKEN, SCAM_NAME, SCAM_ADDRESS, UNSTABLE_TOKEN_PRICE, TOKEN_NOT_TRADED_ON_LEADING_CEXS, SANCTIONED_TOKEN, METAMORPHIC, HARDCODED_EOA_ADDRESSES, WHITELIST_OR_BLOCKLIST_LOGIC, INSUFFICIENT_LOCKED_LIQUIDITY, WASH_TRADING, PROXY_PATTERN, NOT_VERIFIED_CONTRACT, HIGH_REPUTATION_TOKEN, SUSPICIOUS_DEPLOYER`.

### 1.4 Scan Message (firma EIP-712)

`POST /api/public/v2/extension/analysis/signature`
VERIFIED (https://docs.web3antivirus.io/reference/scan-message.md)

- Request body — `AnalyzeSignatureRequestDTO` (requeridos: `from`, `message`):

```json
{
  "from": "0x099b1d292689be58f498f127f4e08fe4f0969bce",
  "website": "metamask.com",
  "message": "{\"domain\":{...},\"types\":{...},\"primaryType\":\"...\",\"message\":{...}}",
  "chainId": "1"
}
```

  - `message` es **un string** (`format: json`) — el payload EIP-712 completo (`domain`/`types`/`primaryType`/`message`) va serializado adentro, no como campos sueltos del body.
  - `chainId` (top-level, separado del `domain.chainId` que va dentro del string `message`) es enum: `1, 8453, 130, 146, 56, 137, 10, 42161, 480, 42220, 43114, 324, 81457, 59144, 999, 33139`, default `"1"`. **Todos mainnet, sin Base Sepolia (`84532`)** — ver §3 para la estrategia.
  - No pide `signature`: este endpoint analiza el payload **antes de firmar**, exactamente el caso de uso del track.

- Respuesta `200` — `SignatureAnalysisResponseDTO`:

```json
{
  "domain": { "name": "Uniswap Permit2", "version": "1", "chainId": "1", "verifyingContract": "0x000000000022d473030f116ddee9f6b43ac78ba3" },
  "from": "0x0d775e010f0b6c32c9468d43ba599ef47d596e47",
  "messageType": "PermitSingle",
  "detectors": [
    { "code": "UNLIMITED_ALLOWANCE", "description": "Grants unlimited token spending approval to another address." },
    { "code": "WALLET_DRAINER", "description": "By signing this transaction, you will give approval for most of your ETH and ERC-20 tokens to a wallet drainer and lose them." },
    { "code": "KNOWN_MALICIOUS", "description": "Spender address flagged in phishing list." }
  ],
  "riskGroup": "High",
  "assetsMovement": { "approve": [ { "symbol": "USDT", "address": "0xdac17f958d2ee523a2206206994597c13d831ec7", "type": "ERC20", "spender": "0xdef...", "amount": "UNLIMITED" } ] },
  "addresses": [ { "address": "0xdef...", "type": "eoa", "detectors": ["WALLET_DRAINER", "KNOWN_MALICIOUS"] } ]
}
```

  - `messageType` **enum documentado**: `Permit, PermitSingle, PermitBatch, PermitForAll, PermitTransferFrom, PermitBatchTransferFrom`. **`TransferWithAuthorization` (EIP-3009) no está en la lista.** Esto confirma el riesgo señalado en `15-validacion-tecnica.md`: hay que probarlo con una autorización real; si el backend no reconoce el `primaryType`, lo más probable es que devuelva `riskGroup: "Low"` con `detectors: []` y `messageType` vacío/ausente (comportamiento no documentado — **UNVERIFIED**, probarlo primero).
  - `riskGroup` ∈ `Low | Medium | High` (default `Low`).
  - `addresses[].type` ∈ `eoa | pair | erc20 | erc721 | erc1155 | erc404 | contract`.
  - `detectors[].code` (11 valores, orientados a *approve*/drainer): `UNLIMITED_ALLOWANCE, KNOWN_MALICIOUS, SUSPICIOUS_APPROVE, WALLET_DRAINER, NEWLY_CREATED_WEBSITE, BLOCKLIST_SITE, POISONING_ATTACK, INITIATOR_SCAM_TRANSACTIONS, SCAM_ADDRESS, RUG_PULL_RELATED, SCAM_AIRDROP`. Ninguno es específico de `transferWithAuthorization` — otra señal de que el endpoint está pensado para `Permit`/`Permit2`, no EIP-3009.

---

## 2. Cliente TS: fetch con timeout, manejo de errores y fail-closed

```ts
// intercepta-client.ts
const BASE_URL = "https://api.web3antivirus.io";
const API_KEY = process.env.INTERCEPTA_API_KEY!;
const TIMEOUT_MS = 4_000; // el screening corre en el hot path de la firma; no puede colgar el agente

export class InterceptaUnavailableError extends Error {}

async function interceptaGet<T>(path: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "X-API-KEY": API_KEY, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new InterceptaUnavailableError(`Intercepta HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new InterceptaUnavailableError(`Intercepta timeout after ${timeoutMs}ms on ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function interceptaPost<T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "X-API-KEY": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new InterceptaUnavailableError(`Intercepta HTTP ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new InterceptaUnavailableError(`Intercepta timeout after ${timeoutMs}ms on ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const quickScanAddress = (address: string) =>
  interceptaGet<ToxicScoreShortResponse>(`/api/public/v2/extension/account/${address}/quick-scan`);

export const deepScanAddress = (address: string) =>
  interceptaGet<ToxicScoreShortResponse>(`/api/public/v2/extension/account/${address}/toxic-score`);

export const scanToken = (address: string, chainId: string) =>
  interceptaGet<TokenRiskAnalysisV2Response>(
    `/api/public/v2/extension/token-intelligence/token/${address}/risks?chainId=${chainId}`,
  );

export const scanMessage = (payload: AnalyzeSignatureRequest) =>
  interceptaPost<SignatureAnalysisResponse>(`/api/public/v2/extension/analysis/signature`, payload);
```

**Fail-closed en el Guardian** (el punto en que se decide si se llama a `createPaymentPayload`):

```ts
// guardian-gate.ts
async function screenBeforeSign(payTo: string, asset: string, mainnetChainId: string) {
  try {
    const [addressRisk, tokenRisk] = await Promise.all([
      deepScanAddress(payTo),
      scanToken(asset, mainnetChainId),
    ]);
    return decide(addressRisk, tokenRisk); // ver §5
  } catch (err) {
    if (err instanceof InterceptaUnavailableError) {
      // Fail-closed: si el firewall no puede preguntar, no se firma.
      // Para una demo se puede degradar a "escalate" (pedir aprobación humana)
      // en vez de "block" duro, pero nunca a "allow" silencioso.
      return { action: "escalate" as const, reason: `Intercepta unavailable: ${err.message}` };
    }
    throw err; // error inesperado: no lo tragues, que se vea en logs/tests
  }
}
```

Justificación de fail-closed: el track pide explícitamente que el veredicto de Intercepta **decida** qué pasa (no mockear ni hardcodear), y el punto crítico ya señalado en `15-validacion-tecnica.md` es que `createPaymentPayload` genera una autorización ya firmada y gastable — si Intercepta no responde, la opción segura es no firmar (o escalar a humano), nunca asumir "sin riesgos detectados".

### Presupuesto de 1.000 requests: cachear por address

- Cachear **Deep Scan Address** y **Scan Token** en memoria (o Redis si hay tiempo) por `address` (lowercased) con TTL — por ejemplo 10–15 min para la demo. Direcciones repetidas (la wallet del Guardian, `payTo` fijo de la API de la demo, USDC mainnet mapeado) no deberían regastar requests.
- No cachear **Scan Message**: la autorización cambia con cada pago (`nonce`, `validAfter/validBefore`, a veces `value`), así que cachear por payload completo tiene hit-rate ~0. Si se quiere ahorrar, se puede correr Scan Message solo en un subset de pagos (p. ej. solo si `value` supera un umbral) — evaluar según cuántos pagos se hagan en la demo.
- **Quick Scan** vs **Deep Scan**: mismo shape de respuesta, pero Deep Scan documenta más categorías de riesgo (sanciones, phishing, darkweb, lavado). Para el gate previo a la firma, usar **Deep Scan** de entrada (cobertura, no solo latencia) y reservar Quick Scan para un path de "pre-chequeo" más barato si se agregan más wallets a la demo.
- Regla simple de presupuesto: 1 pago de demo = 1 `deepScanAddress(payTo)` + 1 `scanToken(asset)` + 1 `scanMessage(...)` = 3 requests. Con cache por address en los dos primeros, una demo de N pagos con las mismas direcciones cuesta ~`N + 2` requests en vez de `3N`. Con 1.000 requests hay margen de sobra incluso sin cache — cachear es sobre todo higiene, no necesidad dura.

---

## 3. Armar el payload de Scan Message desde `PaymentRequirements` + typed data EIP-3009

### 3.1 De dónde sale cada campo (VERIFIED contra la spec de x402)

`x402-foundation/x402` (`specs/schemes/exact/scheme_exact_evm.md`, VERIFIED https://github.com/x402-foundation/x402) documenta el `extra` de `PaymentRequirements` para `assetTransferMethod: "eip3009"`:

```json
{
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" }
  }
}
```

- `extra.name` (requerido) → `domain.name` del EIP-712.
- `extra.version` (requerido) → `domain.version`.
- `network` (`eip155:84532`) → el chain id real firmado, `84532` (Base Sepolia).
- `asset` → `domain.verifyingContract` (el contrato del token, en nuestro caso la USDC de Sepolia).
- El tipo `TransferWithAuthorization` (paquete `python/x402/mechanisms/evm/types.py`, mismo repo, VERIFIED):

```ts
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
};
```

### 3.2 Construcción del payload TS

```ts
import type { PaymentRequirements } from "@x402/core"; // ajustar al import real del SDK v2

function buildEip712Payload(reqs: PaymentRequirements, authorization: {
  from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string;
}) {
  const [, chainIdStr] = reqs.network.split(":"); // "eip155:84532" -> "84532"

  const typedData = {
    domain: {
      name: reqs.extra.name,               // "USDC"
      version: reqs.extra.version,          // "2"
      chainId: Number(chainIdStr),          // 84532 (real, tal como se firma)
      verifyingContract: reqs.asset,        // USDC Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: authorization,
  };

  return { typedData, chainIdStr };
}

async function scanBeforeSigning(reqs: PaymentRequirements, authorization: Parameters<typeof buildEip712Payload>[1]) {
  const { typedData } = buildEip712Payload(reqs, authorization);
  return scanMessage({
    from: authorization.from,
    message: JSON.stringify(typedData),
    chainId: "8453", // ver 3.3 — no existe "84532" en el enum del endpoint
  });
}
```

### 3.3 El enum `chainId` de Scan Message es mainnet-only: opciones + recomendación

El endpoint tiene **dos** lugares donde aparece `chainId`:

1. El `chainId` **top-level** del request body (`AnalyzeSignatureRequestDTO.chainId`), enum cerrado y mainnet-only, default `"1"`.
2. El `domain.chainId` **embebido dentro del string `message`** (parte del typed data EIP-712), que no tiene validación de schema propia documentada — es solo `string`/`format: json` en el request.

Base Sepolia (`84532`) no aparece en ningún enum documentado de Web3 Antivirus (ni en Scan Token ni en Scan Message); Base mainnet (`8453`) sí está en ambos.

**Opciones:**

- **A. Mandar el chainId real (84532) en el top-level `chainId`.** Riesgo: el campo es un enum cerrado en el OpenAPI; si el backend valida estrictamente, puede devolver `400`. UNVERIFIED si realmente rechaza valores fuera del enum o si el enum es solo documentación laxa — probar primero con la key sandbox antes de decidir.
- **B (recomendada). Top-level `chainId: "8453"` (Base mainnet, el análogo soportado más cercano), pero `domain.chainId` dentro del `message` con el valor real (`84532`).** Razonamiento: el top-level `chainId` parece existir para que Intercepta seleccione qué dataset de detectores/red usar (routing), mientras que el `domain` embebido es la representación fiel de lo que el usuario está a punto de firmar — no tiene sentido falsear el dato que se está analizando. Como este endpoint no recibe ni verifica una `signature` (es un análisis *pre-firma*, no una verificación criptográfica), no hay riesgo de que un chainId "falso" en el top-level rompa una recuperación de firma.
- **C. Sustituir todo por mainnet (chainId 8453 y `verifyingContract` = USDC mainnet de §4) en ambos lugares.** Maximiza la chance de que Intercepta reconozca el contrato como "USDC conocido", pero dejamos de analizar el payload real que se firma (podría ocultar un `verifyingContract` que en Sepolia fuera un lookalike, ya que se sobrescribe). Además el resultado del token en sí ya lo cubre Scan Token (§4), que si usa el asset mapeado correctamente.

**Recomendación:** Opción B. Además, correr Scan Token (§1.3/§4) por separado con la dirección mainnet mapeada cubre la validación "¿es USDC real?" de forma más confiable que forzar el `domain` de Scan Message a mentir. Si en las pruebas con la key sandbox el endpoint devuelve error o `messageType` vacío por no reconocer `TransferWithAuthorization`, cae el plan B de `15-validacion-tecnica.md`: apoyarse en `scan-address(payTo)` + `scan-token(asset)` como las dos capas de decisión, y tratar `scan-message` como señal best-effort (si responde con detectores relevantes, súmalos; si no, no bloquees la demo por eso).

---

## 4. Mapeo testnet → mainnet para Scan Token

| | Base Sepolia (testnet, donde corre el pago) | Base mainnet (para Intercepta) |
|---|---|---|
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913` |
| chainId | `84532` (`eip155:84532`) | `8453` |

VERIFIED del lado testnet en `15-validacion-tecnica.md` (repo interno, ya validado por el equipo) y del lado mainnet por el enum de `chainId` en `scan-token.md` (`8453` presente) — la dirección mainnet de USDC en Base (`0x8335...`) es la publicada por Circle/Base y coincide con la que ya trae `15-validacion-tecnica.md`; no se re-verificó contra un explorer en esta pasada porque ya estaba validada en el documento fuente.

```ts
const TESTNET_TO_MAINNET_TOKEN: Record<string, { address: string; chainId: string }> = {
  // Base Sepolia USDC -> Base mainnet USDC
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": {
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    chainId: "8453",
  },
};

function mapAssetForScreening(testnetAsset: string) {
  const mapped = TESTNET_TO_MAINNET_TOKEN[testnetAsset.toLowerCase()];
  if (!mapped) {
    // Token desconocido en testnet: no hay mapping -> tratar como no verificado, no como "seguro por defecto".
    return null;
  }
  return mapped;
}
```

Nota: `payTo` y cualquier otra wallet **no** necesitan mapeo — las direcciones EOA son iguales en todas las redes EVM, así que se pasan tal cual a Quick/Deep Scan Address. Solo el contrato del token cambia de dirección entre redes y necesita el mapping explícito.

---

## 5. Decisión: de `toxicScore`/`traits`/`riskLevel`/`action`/`detectors` a allow/block/escalate

```ts
type Verdict = "allow" | "block" | "escalate";

interface ScreeningResult {
  verdict: Verdict;
  reasons: string[];
}

function decide(
  addressRisk: ToxicScoreShortResponse,
  tokenRisk: TokenRiskAnalysisV2Response,
  messageRisk?: SignatureAnalysisResponse,
): ScreeningResult {
  const reasons: string[] = [];
  let verdict: Verdict = "allow";

  // 1) Token: `action` ya viene pre-mapeado por Intercepta para esto.
  if (tokenRisk.action === "block" || tokenRisk.trust === "blocklist" || tokenRisk.category === "sanctioned") {
    verdict = "block";
    reasons.push(`token: action=${tokenRisk.action}, category=${tokenRisk.category}`);
  } else if (tokenRisk.action === "warn" || tokenRisk.riskLevel === "high") {
    verdict = escalateIfNotBlocked(verdict);
    reasons.push(`token: action=${tokenRisk.action}, riskLevel=${tokenRisk.riskLevel}`);
  }

  // 2) Address (payTo): no hay `action` aquí, así que umbralizamos sobre toxicScore/traits.
  const hardTraits = new Set(["sanction_address", "known_scammer", "blacklist", "mixer_transfers"]);
  const hasHardTrait = addressRisk.traits.some((t) => hardTraits.has(t.name));
  if (hasHardTrait || addressRisk.toxicScore >= 75) {
    verdict = "block";
    reasons.push(`payTo: toxicScore=${addressRisk.toxicScore}, traits=${addressRisk.traits.map((t) => t.name).join(",")}`);
  } else if (addressRisk.toxicScore >= 30) {
    verdict = escalateIfNotBlocked(verdict);
    reasons.push(`payTo: toxicScore=${addressRisk.toxicScore} (umbral medio)`);
  }

  // 3) Message (best-effort, ver §3.3): drainer/malicious siempre bloquea.
  if (messageRisk) {
    const hardDetectors = new Set(["WALLET_DRAINER", "KNOWN_MALICIOUS", "POISONING_ATTACK"]);
    const hasHardDetector = messageRisk.detectors.some((d) => hardDetectors.has(d.code));
    if (hasHardDetector || messageRisk.riskGroup === "High") {
      verdict = "block";
      reasons.push(`message: riskGroup=${messageRisk.riskGroup}, detectors=${messageRisk.detectors.map((d) => d.code).join(",")}`);
    } else if (messageRisk.riskGroup === "Medium") {
      verdict = escalateIfNotBlocked(verdict);
      reasons.push(`message: riskGroup=Medium`);
    }
  }

  return { verdict, reasons: reasons.length ? reasons : ["no risk signals"] };
}

function escalateIfNotBlocked(current: Verdict): Verdict {
  return current === "block" ? current : "escalate";
}
```

**Umbrales sugeridos** (de partida para la demo, UNVERIFIED — calibrar viendo `toxicScore`/`riskScore` reales de la key sandbox, no hay una escala documentada oficialmente más allá de "es un número"):

| Señal | Umbral | Verdict |
|---|---|---|
| `tokenRisk.action` | `block` | `block` |
| `tokenRisk.trust` | `blocklist` | `block` |
| `tokenRisk.category` | `sanctioned` \| `malicious` | `block` |
| `tokenRisk.action` | `warn` | `escalate` |
| `addressRisk.traits[].name` | `sanction_address`, `known_scammer`, `blacklist`, `mixer_transfers` | `block` |
| `addressRisk.toxicScore` | ≥ 75 | `block` |
| `addressRisk.toxicScore` | 30–74 | `escalate` |
| `messageRisk.detectors[].code` | `WALLET_DRAINER`, `KNOWN_MALICIOUS`, `POISONING_ATTACK` | `block` |
| `messageRisk.riskGroup` | `High` | `block` |
| `messageRisk.riskGroup` | `Medium` | `escalate` |

`escalate` en la demo = no firmar automáticamente y mostrar la razón (pedir aprobación humana, o simplemente marcarlo como "held" en el dashboard); `block` = no llamar a `createPaymentPayload` en absoluto.

---

## 6. Direcciones "known-bad" públicamente documentadas

`15-validacion-tecnica.md` y `intercepta.io/ethglobal` dicen que la lista oficial de test addresses está fijada en el canal de Discord del sponsor — no la tenemos y no debe inventarse. Lo que sí se puede documentar con fuente pública y verificar hoy:

- **⚠️ Corrección importante sobre Tornado Cash:** las direcciones de **contrato** de Tornado Cash (los pools, el router, etc.) fueron **retiradas de la SDN list de OFAC el 21 de marzo de 2025** ("Cyber-related Designation Removal"). VERIFIED (https://ofac.treasury.gov/recent-actions/20250321, con nota de prensa en https://home.treasury.gov/news/press-releases/sb0057). Si el plan era usar una dirección de contrato de Tornado Cash como demo de "bloqueado por sanciones", **ya no aplica** — Intercepta u otro screener no debería (y no debe) marcarla como sancionada hoy. Usarla igual daría un falso "esto está mal" en la demo.
- **Lo que sí sigue sancionado (mismo update, sin cambios):** las direcciones personales de **Roman Semenov**, cofundador de Tornado Cash, individuo bajo sanción DPRK3/CYBER2 por su rol en el lavado ligado a Lazarus Group. VERIFIED (https://ofac.treasury.gov/recent-actions/20250321):
  - `0xdcbEfFBECcE100cCE9E4b153C4e15cB885643193`
  - `0x5f48c2a71b2cc96e3f0ccae4e39318ff0dc375b2`
  - `0x5a7a51bfb49f190e5a6060a5bc6052ac14a3b59f`
  - `0xed6e0a7e4ac94d976eebfb82ccf777a3c6bad921`
  - `0x797d7ae72ebddcdea2a346c1834e04d1f8df102b`
  - `0x931546D9e66836AbF687d2bc64B30407bAc8C568`
  - `0x43fa21d92141BA9db43052492E0DeEE5aa5f0A93`
  - `0x6be0ae71e6c41f2f9d0d1a3b8d0f75e6f6a0b46e`

  Estas son EOAs de un individuo con sanción activa a la fecha del update citado; no confirmé en esta pasada si siguen sin cambios hoy 2026-09-25 (las listas de OFAC pueden cambiar) — antes de usarlas en la demo en vivo, contrastar contra el buscador oficial: https://sanctionssearch.ofac.treas.gov o https://ofac.treasury.gov/specially-designated-nationals-list-sdn-list (UNVERIFIED estado exacto hoy, VERIFIED que estaban sancionadas al 2025-03-21).
- **Dirección de ejemplo "conocida" en la propia documentación de Web3 Antivirus:** `0x0d775e010f0b6c32c9468d43ba599ef47d596e47` aparece como ejemplo en Quick Scan y Deep Scan (VERIFIED, docs citados en §1), pero es un ejemplo genérico de la spec (formato de address), no necesariamente una address con riesgo real — no asumir que es "known-bad" sin correrla contra el endpoint primero.

**Recomendación:** para el "un pago que pasa y uno que se bloquea" del track, usar (a) una wallet propia / la del faucet como el caso "pasa", y (b) una de las direcciones de Semenov de arriba (re-verificada el día de la demo contra el SDN search oficial) como el caso "bloqueado" — es la única evidencia pública, con cita primaria, disponible sin depender del canal de Discord. Si el Discord entrega su propia lista antes de la demo, usar esa en su lugar (es la fuente que el propio sponsor espera que uses para el juicio).

---

## 7. Ejemplo público de integración en TS (no es el oficial del Discord)

Búsqueda en GitHub (`gh search repos`, `gh search code`) por `web3antivirus`, `intercepta`, `api.web3antivirus.io`, `quick-scan-address`, `toxic-score`, y por la org `web3antivirus` en GitHub:

- La organización **`web3antivirus`** existe en GitHub (VERIFIED, `gh api orgs/web3antivirus` → `public_repos: 0`) pero **no tiene repos públicos** — el repo de ejemplo TS que menciona el track está confirmado como privado, entregado solo en su Discord: *"A TypeScript example repo is in the Discord channel"* (VERIFIED, https://intercepta.io/ethglobal). No hay forma de acceder a él sin unirse al Discord del hackathon.
- No se encontró ningún repo público bajo una org oficial de Intercepta/Web3 Antivirus con ejemplos de integración.
- Sí aparece un uso de tercero en TS: `strale-io/strale`, archivo `apps/api/src/web3-assurance/evaluators/web3-antivirus.ts` (VERIFIED, https://github.com/strale-io/strale/blob/main/apps/api/src/web3-assurance/evaluators/web3-antivirus.ts). **No es un repo oficial de Intercepta** — es un proyecto de terceros no afiliado. Usa `https://api.web3antivirus.io/v1/wallet/{address}/risk`, un endpoint **v1** que no coincide con los v2 documentados hoy (§1) — no usar esa ruta, solo el patrón de código (fetch + `AbortSignal.timeout` + manejo de 404/no-ok + captura de excepción) es reutilizable, no el endpoint.
- También apareció otro proyecto de hackathon (`SwiftAdviser/mandate`) que integra Web3 Antivirus + x402 de forma similar a lo que estamos construyendo, pero es el repo de otro equipo compitiendo en un track parecido, en PHP/Laravel — mencionado solo como referencia de que el patrón "x402 + web3antivirus antes de firmar" ya lo están explorando otros equipos, no como fuente de implementación.

**Conclusión práctica:** no hay ejemplo oficial público reutilizable; hay que construir el cliente desde el OpenAPI de los docs (§1–§2), que es autoritativo, y pedir el repo del Discord como referencia adicional si aparece antes del deadline.

---

## 8. Requisitos exactos del README para el track

Verbatim de `tracks/intercepta.md` (ya extraído de la página oficial del sponsor), track **"Safe Agent-to-Agent Payments with x402"**:

> - A working agent payment flow, x402 preferred. Payments can run on a testnet.
> - At least one live call to the Intercepta API (free key at intercepta.io/ethglobal) runs before a payment is signed or accepted, and its result decides what happens next. Mocked or hard-coded responses don't qualify.
> - Our risk data covers mainnet, so screen real mainnet addresses even when the payment runs on a testnet. Test addresses with known risks are pinned in our Discord channel.
> - Your demo shows one payment that goes through and one that is blocked or held, with the reason visible.
> - **Public GitHub repo. The README points to the files where the API is called and includes 3 to 5 lines of feedback on the API: time to first call, what confused you, what was missing.**

Traducido para el checklist del repo:

1. Repo público en GitHub.
2. El README debe **apuntar explícitamente a los archivos** donde se llama la API de Intercepta (ej.: enlaces relativos a `guardian/intercepta-client.ts`, `guardian/guardian-gate.ts`, `guardian/decide.ts` — ajustar a los paths reales una vez que exista el código).
3. El README debe incluir **3 a 5 líneas de feedback** sobre la API: tiempo hasta la primera llamada exitosa, qué confundió, qué faltó.

Si aplica el segundo track ("Add Payment Screening to Your Agent or x402 Service", Continuity only), el mismo requisito de README/feedback se repite verbatim.

### Draft de feedback (3–5 líneas, a ajustar con la experiencia real del spike)

> Tiempo hasta la primera llamada con veredicto real: ~10–15 min desde que llega la key (Quick/Deep Scan Address son un solo `GET` con la key en el header, sin fricción).
> Lo que más confundió: `scan-message` documenta `messageType` solo para `Permit`/`Permit2` — no queda claro en los docs si reconoce `TransferWithAuthorization` (EIP-3009), que es justo lo que x402 firma con USDC; tuvimos que inferirlo probando.
> Lo que faltó: el enum de `chainId` en `scan-token` y `scan-message` es mainnet-only (no incluye Base Sepolia `84532`), y los docs no explican cómo screenear un pago hecho en testnet contra datos de riesgo de mainnet — terminamos mapeando manualmente el token y dejando el `domain.chainId` real dentro del payload de `scan-message` sin instrucción oficial de qué se espera ahí.
> Extra: el "Getting Started" (`getting-started-1.md`) todavía referencia el host viejo `w3a.readme.io` para probar la key, en vez de `docs.web3antivirus.io` / `api.web3antivirus.io`.

(Ajustar los tiempos/detalles reales una vez corrido el spike contra la key sandbox — esto es un borrador basado en lo que la documentación deja ambiguo, no en una prueba en vivo todavía.)

---

## Resumen de riesgos abiertos a validar con la key sandbox

1. ¿`scan-message` reconoce `primaryType: "TransferWithAuthorization"` o devuelve vacío/error? (§1.4, §3.3)
2. ¿El `chainId` top-level de `scan-message` rechaza valores fuera del enum, o es solo documentación laxa? (§3.3, opción A vs B)
3. ¿Cuál es la escala real de `toxicScore`/`riskScore` en la práctica (0–100, otra escala)? Los umbrales de §5 son un punto de partida, no un hecho verificado.
4. Confirmar en Discord la lista oficial de test addresses y el repo TS de ejemplo antes de fijar los umbrales finales y las addresses de la demo.
