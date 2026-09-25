# Plan técnico de build — Intent Firewall (nombre propuesto: Yakusoku)

> Ventana: **viernes 21:00 → domingo 07:00 JST (~34h, sleep incluido)**. Deadline real de entrega: domingo 09:00 JST (`03-entrega-y-evaluacion.md`) — el plan cierra a las 07:00 para dejar 2h de colchón. Un solo developer, background de producto/agentes de IA, **sin Solidity**. Regla del hackathon: el repo del proyecto arranca **vacío** a las 21:00 (`02-reglas.md`, modalidad From Scratch); este documento y el resto de `research/` son planificación previa, no cuentan como código del proyecto.
>
> Nombre de trabajo en el código: `firewall` (nombres de carpeta y de API se mantienen funcionales). Nombre público recomendado para el pitch: **Yakusoku** (`research/nombres.md` — "Intent Firewall" choca con Mandate Treasury y ENSFirewall del propio showcase). Esta decisión de branding no afecta la estructura técnica de abajo.

---

## 1. Monorepo (bun workspaces)

### Por qué bun workspaces y no Turborepo/Nx
- El spike descartable ya verificó que **bun es obligatorio para correr TS**: `pnpm + tsx` se traba con los build scripts de `esbuild` que usan los paquetes `@x402/*` (`20-producto.md`, verificado 2026-09-25). Bun ya resuelve instalación + workspaces + runtime en una sola herramienta.
- Un dev de background IA/producto, sin experiencia previa en monorepos TS, no debería sumar una segunda herramienta de build (Turborepo/Nx) con 34h disponibles: el costo de configurarla y debuggearla no se paga. `bun workspaces` con `package.json#workspaces` alcanza para 4 apps + 1 package compartido.
- Cada app corre como proceso independiente (el store y el firewall son servidores HTTP separados; el agente es un script; el dashboard es Next.js) — no hace falta un grafo de build incremental, solo instalación compartida y tipos compartidos.

### Estructura

```
yakusoku/
├── apps/
│   ├── firewall/        # Servicio Node/TS: pipeline de decisión + API HTTP + SSE. Único proceso con la clave privada.
│   ├── store/            # Clon de tienda de gift cards protegida con x402, incluye catálogo con promo inyectada (trap).
│   ├── agent/             # Agente LLM de compras (sin clave privada, solo HTTP).
│   └── web/                # Next.js: pantalla de firma de intención (wagmi/EIP-712) + dashboard en vivo (SSE).
├── packages/
│   └── shared/              # Tipos + esquemas zod compartidos: TaskIntent, PaymentRequirement, DecisionReceipt, constantes de red.
├── docs/
│   └── ai/                    # Prompts, specs y bitácora de uso de IA (regla `02-reglas.md`). Se puebla desde el primer commit.
├── package.json                # workspaces: ["apps/*", "packages/*"]
├── tsconfig.base.json
├── bunfig.toml
├── .env.example
└── README.md
```

### Por qué el agente es su propia app y no un módulo del firewall
Es la línea de defensa arquitectónica central del producto (`20-producto.md` §7, nivel 1): **el agente nunca debe poder importar ni ver la clave privada**. Separarlo en un proceso propio que solo habla HTTP con el firewall hace cumplir esa frontera a nivel de código, no solo de diseño — no hay un `import` posible que la rompa por accidente durante una sesión de 34h con presión de tiempo.

### Por qué `packages/shared` existe
`TaskIntent`, `PaymentRequirement` y `DecisionReceipt` se usan en `web` (para firmar/mostrar), `firewall` (para decidir) y `agent` (para decodificar) — sin un paquete compartido, cualquier cambio de forma durante la noche obliga a tocar 3 lugares a mano y es la fuente más probable de bugs de integración. Es deliberadamente chico (~150–250 líneas): tipos + esquemas `zod` + constantes de red (`eip155:84532`, direcciones de USDC testnet/mainnet del mapeo de Intercepta).

---

## 2. Contratos de módulos

### 2.1 API HTTP del firewall

| Endpoint | Método | Qué hace |
|---|---|---|
| `POST /intents` | firma una `TaskIntent` (typed data EIP-712 + firma) → verifica la firma (`viem.verifyTypedData`), la guarda, devuelve `{ intentId, remainingBudget }` |
| `GET /intents/:id` | devuelve la intención guardada — usado por `web` para la "vista previa" antes de lanzar el agente (mejora SHOULD de `23-inspiracion.md`) |
| `POST /sign` | recibe `{ paymentRequired, intentId, sourceContext }` (ya decodificado por el agente) → corre el pipeline completo → devuelve `{ signatureHeader }` si `pay`, o `{ verdict: "refuse" | "ask_human", reason, receiptId }` si no |
| `GET /events` | SSE — stream de `DecisionReceipt` para el dashboard |
| `POST /approvals/:receiptId` | resuelve un receipt en `ask_human` (callback/poll de World ID, o disparador manual en demo) |
| `POST /control/pause` / `POST /control/resume` | (stretch, WU13) desactiva/reactiva la clave de firma en caliente — "revocado desde el dashboard", inspirado en Arc Mandate (`research/showcase-inspiracion-2.md`) |

### 2.2 Formas de datos (`packages/shared`)

**`TaskIntent`** (EIP-712, firmado por el usuario, nunca por el agente):

```ts
const TaskIntentTypes = {
  TaskIntent: [
    { name: "task", type: "string" },        // texto libre: "Buy a 25 USDC Amazon gift card..."
    { name: "budget", type: "uint256" },      // unidades mínimas de USDC (6 decimales)
    { name: "categories", type: "string[]" }, // ej. ["gift_card:amazon"]
    { name: "expiry", type: "uint256" },      // unix timestamp
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const domain = { name: "Yakusoku Intent Firewall", version: "1", chainId: 84532 };
// Sin `verifyingContract`: no hay contrato onchain que valide esto (nivel 3 del árbol de confianza
// vive en el firewall, no en la cadena — ver `19-jev-y-arquitectura.md`). El `nonce` cubre el replay.
```

`task` va como texto plano (no hasheado): es el mismo campo que `jev-diseno.md` §2 usa tal cual en `state.signed_intent.task` para el juicio de Jev — hashearlo obligaría a guardar el texto plano en otro lado igual, sin ganancia de seguridad para un MVP de hackathon.

**`DecisionReceipt`** (máquina de estados nombrada, inspirada en el patrón de 9 estados de ClearIntent — `research/showcase-inspiracion-2.md`):

```ts
interface DecisionReceipt {
  receiptId: string;
  paymentIdentifier: string; // extensión oficial x402 payment-identifier
  intentId: string;
  createdAt: string;
  state:
    | "idempotent_hit" | "policy_rejected"
    | "provenance_blocked"
    | "intercepta_blocked" | "intercepta_escalated"
    | "jev_refused" | "jev_ask_human"
    | "awaiting_world_id" | "world_id_denied" | "world_id_expired"
    | "signed" | "settled" | "settlement_failed";
  verdict: "pay" | "refuse" | "ask_human";
  reasons: string[];
  intercepta?: { addressVerdict: string; tokenVerdict: string };
  jev?: { matchesIntent: number; risk: number; action: string; confidence: number };
  worldId?: { approved: boolean; nullifierHash?: string; stepUpAttestation?: string };
  txHash?: string;
  explorerUrl?: string;
}
```

### 2.3 Orden del pipeline (fijado por consigna, antes de firmar)

```
idempotencia (payment-identifier) → política (presupuesto/expiry/red) → proveniencia (determinístico)
  → Intercepta (scan-address + scan-token) → Jev (matches_intent/social_engineering/action/risk)
  → World ID (si hace falta humano) → createPaymentPayload() + encodePaymentSignatureHeader()
```

Justificación del orden: cada capa es más cara que la anterior — idempotencia y política son aritmética en microsegundos; proveniencia es regex/matching determinístico (<1ms, portado de Aegis402 en `jev-diseno.md` §5); Intercepta y Jev son llamadas de red (segundos); World ID es la más cara (espera humana). Cortar temprano con lo barato evita gastar el presupuesto de 1.000 requests de Intercepta o llamadas a Jev en pagos que ya son inválidos por expiry o presupuesto (casos 11/12/16/17 del set de calibración, `jev-diseno.md` §6).

### 2.4 Reglas fail-closed (una por dependencia externa)

| Falla | Comportamiento | Nunca |
|---|---|---|
| Intercepta: timeout/error/HTTP no-2xx | `intercepta_escalated` → `ask_human` | pasar a Jev asumiendo "sin riesgo" |
| Jev: timeout/error | `jev_ask_human` (`jev-diseno.md` §4, paso 3) | asumir `pay` |
| World ID: `access_denied`, `expired_token`, timeout | `world_id_denied` / `world_id_expired` → `refuse` | reintentar en silencio o aprobar por defecto |
| Cualquier paso lanza una excepción no prevista | `refuse`, log completo | dejar caer al siguiente paso |
| Campo faltante/malformado en el `state` armado para Jev | `ask_human` | adivinar el valor |
| `createPaymentPayload`/firma fallan | `refuse`, se lo informa al agente como pago rechazado | reintentar sin re-correr el pipeline |

Principio único: **cualquier duda técnica cae al lado seguro** (`refuse` o `ask_human`, nunca `pay`) — es la misma regla que ya cubre World ID en `20-producto.md`/`23-inspiracion.md`, extendida explícitamente a Intercepta y Jev (que hoy solo tenían fail-closed documentado para World ID, brecha señalada en `research/showcase-inspiracion-2.md` §4, mejora "matriz fail-open/fail-closed").

---

## 3. Unidades de trabajo, cronograma y entrega

### Cronograma (34h exactas: 5h + 6h sueño + 4.5h + 0.5h + 4.5h + 0.5h + 4.5h + 0.5h + 2.5h + 2.5h sueño + 1.5h + 0.5h video + 0.5h entrega)

| Bloque | Horario | Duración | Contenido |
|---|---|---|---|
| Noche 1 | vie 21:00–02:00 | 5h | WU0–WU3 (scaffold, tipos, store, firewall core) → **checkpoint: primer pago real de punta a punta en Base Sepolia** |
| Sueño 1 | 02:00–08:00 | 6h | — |
| Buffer | sáb 08:00–08:30 | 0.5h | desayuno |
| Bloque mañana | 08:30–13:00 | 4.5h | WU4–WU6 + inicio WU7 (agente LLM, firma de intención, proveniencia) |
| Buffer | 13:00–13:30 | 0.5h | almuerzo |
| Bloque tarde | 13:30–18:00 | 4.5h | fin WU7 + WU8 + WU9 (Intercepta, Jev, SSE/receipts) → **checkpoint: demo de dos carriles funciona (dirección limpia bloqueada por Jev)** |
| Buffer | 18:00–18:30 | 0.5h | cena |
| Bloque noche | 18:30–23:00 | 4.5h | WU10 + WU11 + inicio WU12 (dashboard, World ID) → **checkpoint: MVP completo** |
| Buffer | 23:00–23:30 | 0.5h | — |
| Bloque tarde-noche | 23:30–02:00 | 2.5h | fin WU12 + WU13 + WU14 (stretch: attestation, pausa, verificador independiente) |
| Sueño 2 | 02:00–04:30 | 2.5h | — |
| Bloque final | dom 04:30–06:00 | 1.5h | WU15 (docs/README/feedback) + bug bash |
| Video | 06:00–06:30 | 0.5h | grabar demo (2–4 min, ver abajo) |
| Entrega | 06:30–07:00 | 0.5h | commit final, submit en Hacker Dashboard, colchón de 2h antes del deadline real (09:00) |

Los checkpoints existen para decidir en vivo, durante el evento, si hay que activar el registro de riesgos (sección 6) y cortar por las líneas de corte ya definidas.

### Unidades de trabajo

Cada una ≤ ~400 líneas cambiadas, un chequeo concreto (automatizado donde es barato; llamada real en vivo donde el track lo exige — Intercepta prohíbe mocks) y un commit Conventional Commits.

| # | Unidad de trabajo | Líneas aprox. | Horas | Chequeo | Commit | MVP |
|---|---|---|---|---|---|---|
| WU0 | Scaffold del monorepo: `package.json` workspaces, `tsconfig.base.json`, `.gitignore`, `docs/ai/`, README esqueleto | 150 | 0.5 | `bun install` y `bun run typecheck` pasan en los 5 workspaces vacíos | `chore: scaffold bun workspace monorepo` | ✅ |
| WU1 | `packages/shared`: `TaskIntent`, `PaymentRequirement`, `DecisionReceipt`, `Verdict`, constantes de red + esquemas `zod` | 200 | 0.75 | test unitario: decodifica y valida un `TaskIntent` de ejemplo | `feat(shared): add TaskIntent and DecisionReceipt types` | ✅ |
| WU2 | `apps/store`: catálogo (`GET /catalog`) con 2 productos x402 (Amazon 25 USDC legítimo, Steam×3 en el `description` como promo inyectada) + endpoints `GET /giftcard/:sku` | 250 | 1 | `curl` a `/giftcard/amazon-25` devuelve `402` con header `PAYMENT-REQUIRED` válido | `feat(store): add x402 gift card store with injected promo trap` | ✅ |
| WU3 | `apps/firewall` núcleo: `POST /intents`, `POST /sign`, idempotencia (`payment-identifier`), política (presupuesto/expiry/red), pasos de proveniencia/Intercepta/Jev/World ID como *pass-through* (stub), firma real vía `x402Client` | 380 | 2.5 | round-trip real contra `apps/store` en Base Sepolia con un script de prueba (no LLM aún) — tx visible en `sepolia.basescan.org` | `feat(firewall): implement core payment pipeline with idempotency and policy gate` | ✅ |
| WU4 | `apps/agent`: agente LLM (tool-calling, Claude u OpenAI) que lee `/catalog`, decide comprar, llama `POST /sign`, reintenta con `PAYMENT-SIGNATURE` | 200 | 1 | log completo de una compra exitosa end-to-end con el firewall real | `feat(agent): add LLM shopping agent that requests payment signing from firewall` | ✅ |
| WU5 | `apps/web`: pantalla de firma de intención (Next.js + wagmi, EIP-712 `TaskIntent`) + vista previa | 350 | 1.5 | firmar una intención en el navegador (MetaMask) y verla guardada vía `GET /intents/:id` | `feat(web): add EIP-712 intent signing screen` | ✅ |
| WU6 | Capa de proveniencia determinística (puerto de la lógica de Aegis402, **reimplementada, no copiada**) + integrada al pipeline | 180 | 1 | 3 casos unitarios: dirección en el pedido, dirección solo en contexto no confiable, dirección ofuscada con homóglifos | `feat(firewall): add deterministic provenance check before Intercepta` | ✅ |
| WU7 | Cliente Intercepta (`quick-scan`/`toxic-score` de `payTo`, `scan-token` con mapeo testnet→mainnet, timeout 4s, fail-closed) integrado al pipeline | 300 | 1.75 | llamada real con la key sandbox: dirección limpia pasa, una de las direcciones sancionadas de Semenov (re-verificada el día de la demo) bloquea; simular caída → `escalate`, nunca `allow` | `feat(firewall): integrate Intercepta address and token screening` | ✅ |
| WU8 | Cliente `@typesafe-ai/sdk` + `PAYMENT_INTENT_QUESTIONS` (`matches_intent`, `looks_like_social_engineering`, `payment_source_is_untrusted_content`, `action`, `risk`) + política de umbrales en código | 350 | 2 | correr 6–8 casos representativos del set de 20 de `jev-diseno.md` §6 (#1, #3, #4, #9, #19 son los críticos) y ajustar umbrales | `feat(firewall): integrate Jev intent-matching judgment` | ✅ |
| WU9 | `GET /events` (SSE) + persistencia de `DecisionReceipt` (SQLite o en memoria) con la máquina de estados completa | 300 | 1.75 | `curl` al stream SSE muestra eventos en vivo mientras corren pagos de prueba | `feat(firewall): add SSE event stream and decision receipts` | ✅ |
| WU10 | `apps/web` dashboard: timeline de dos carriles en vivo (sin protección vs. con protección) + vista de detalle por receipt | 380 | 2 | QA visual: aprobado/bloqueado/esperando humano se ven en vivo con la razón y el link al explorador | `feat(web): add live two-lane dashboard with decision receipts` | ✅ |
| WU11 | World ID (camino confirmado en el workshop: for Agents u OIDC device flow, o plan B IDKit + `@worldcoin/human-in-the-loop`) como último gate antes de firmar, con caminos `approve`/`deny`/`expire` | 350 | 2 | camino de aprobación real desde el teléfono + camino de rechazo/expiración, ambos producen el veredicto correcto | `feat(firewall): add World ID human approval gate` | ✅ |
| WU12 | Atestación StepUp EIP-712 al aprobar por World ID (inspirado en HumanMandate, `23-inspiracion.md`) | 120 | 0.75 | el `receipt` incluye el payload de atestación, estructuralmente válido | `feat(firewall): add StepUp attestation on human approval` | stretch |
| WU13 | Botón "Pausar/Revocar" en el dashboard que desactiva la clave de firma en caliente (Arc Mandate) | 100 | 0.75 | tras pausar, el siguiente intento de pago falla cerrado con razón `"paused"` | `feat(web): add pause/revoke control for firewall signing key` | stretch |
| WU14 | Verificador independiente post-hoc: script que lee Base Sepolia + el facilitator y contrasta contra lo que el dashboard dice haber decidido (Mandate Run — "an application is never its own oracle") | 250 | 1.5 | el script confirma los últimos N pagos contra la cadena, sin depender del propio dashboard | `feat(tools): add independent post-hoc payment verifier` | stretch |
| WU15 | README con sección de uso de IA, `docs/ai/` poblado, feedback de 3–5 líneas para Intercepta, QA final, fixes | 150 | 1.25 | checklist manual contra `02-reglas.md` (uso de IA documentado) y contra el requisito de README de Intercepta (`intercepta-implementacion.md` §8) | `docs: add AI usage documentation and sponsor feedback` | ✅ |

Total: ~22h de trabajo efectivo sobre un presupuesto de 22.5h — deja ~30 min de margen implícito repartido entre unidades, sin contar los buffers ya explícitos en el cronograma.

**MVP vs. stretch:** WU0–WU11 y WU15 son necesarias para los tres tracks elegidos (Intercepta, World, Curvegrid) y para la demo de `20-producto.md` §10. WU12–WU14 son mejoras `SHOULD`/`SHOULD` de `23-inspiracion.md` y `research/showcase-inspiracion-2.md`: suman explicabilidad y factor sorpresa, pero ningún track las exige. El nivel 4 (smart wallet ERC-1271 propia, `20-producto.md` §7) queda **fuera de alcance deliberadamente**: requiere Solidity y tiene riesgo medio-alto sin verificar (`19-jev-y-arquitectura.md`, Error 1), y el dev no tiene ese background.

### Video de demo (dom 06:00–06:30)
Guion de 4 minutos ya definido en `20-producto.md` §10 (problema → compra legítima → bloqueo por Intercepta → bloqueo por Jev con dirección limpia → idempotencia en reintento → World ID aprobado y rechazado → cierre). Restricciones duras de `03-entrega-y-evaluacion.md`: 2–4 minutos, mínimo 720p, sin acelerar el video, sin voz generada por IA, slides con máximo 4 viñetas, intro menor a 20s. Grabar en una sola toma si es posible — no hay tiempo de edición en el bloque de 30 minutos asignado.

---

## 4. Checklist de entorno y cuentas (antes de las 21:00)

### Cuentas y credenciales a crear/confirmar
1. **TypeSafe** — cuenta en `console.typesafe.ai`, generar `TYPESAFE_API_KEY`, confirmar el crédito de $5 (~120M tokens).
2. **Intercepta** — pedir la key sandbox en `intercepta.io/ethglobal` **lo antes posible** (tarda horas en llegar por mail); unirse al canal de Discord del sponsor para las direcciones de prueba con riesgo conocido.
3. **World** — ir al workshop (17:30) y confirmar acceso a `sandbox.auth.world.org/portal` (parece tener lista de acceso) y si se puede probar sin Orb; si no, generar credenciales de **IDKit** (plan B) antes de las 21:00 para no perder tiempo de build decidiendo esto en vivo.
4. **Anthropic u OpenAI** — API key para el agente LLM de `apps/agent`.
5. **GitHub** — repo público creado y **vacío** a las 21:00 (requisito de la modalidad From Scratch).
6. **Wallets de desarrollo** (Base Sepolia): una para el firewall (paga) y otra para la tienda (`payTo`, `MERCHANT_KEY`) — ambas cargadas con USDC vía `faucet.circle.com` (20 USDC cada 2h, sin registro).
7. Opcional: cuenta de Alchemy/Infura para un RPC de Base Sepolia propio, por si el RPC público se satura durante la demo.

### `.env.example` (claves, sin valores)

```
# apps/firewall
FIREWALL_PRIVATE_KEY=
TYPESAFE_API_KEY=
TYPESAFE_BASE_URL=            # opcional, default https://api.typesafe.ai (o fallback OSS local)
INTERCEPTA_API_KEY=
WORLD_CLIENT_ID=
WORLD_CLIENT_SECRET=
FACILITATOR_URL=https://x402.org/facilitator
BASE_SEPOLIA_RPC_URL=         # opcional, default RPC público
USDC_SEPOLIA_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
USDC_MAINNET_ADDRESS=0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913

# apps/store
MERCHANT_KEY=

# apps/agent
ANTHROPIC_API_KEY=            # o OPENAI_API_KEY

# apps/web
NEXT_PUBLIC_FIREWALL_URL=http://localhost:PORT
```

Decisión deliberada: `apps/web` usa el conector *injected* de wagmi (MetaMask) para firmar el `TaskIntent`, sin WalletConnect — evita depender de un `WALLETCONNECT_PROJECT_ID` adicional que no aporta nada a la demo de un solo usuario.

---

## 5. Higiene de git y uso de IA

- **Commits frecuentes:** uno por unidad de trabajo terminada (16 commits de WU0–WU15) más los fixups que hagan falta durante los checkpoints — cumple la regla de `02-reglas.md` de que "un repo con un solo commit grande... se considera no calificado".
- **`docs/ai/` se puebla desde el primer commit** (WU0), no al final: cada commit de trabajo puede referenciar en su cuerpo qué asistencia de IA usó (ej. "spec drafted with Claude Code, pipeline logic reviewed manually"). Al cierre, WU15 consolida esto en el README (sección "AI usage") y agrega los prompts/specs relevantes a `docs/ai/` — cumple el requisito de `02-reglas.md` de documentar dónde y cómo se usó IA y de que los flujos spec-driven dejen sus artefactos en el repo.
- **El código del spike descartable NO se copia.** `/private/tmp/.../x402-spike/server.ts` y `agent-guardian.ts` ya demostraron que el patrón funciona (separación agente/firewall, `onBeforePaymentCreation`, round-trip real en Sepolia) — eso es lo que se reutiliza: el *conocimiento verificado*, no las líneas. WU2, WU3 y WU4 se **reimplementan desde cero** contra la documentación oficial de `@x402/*` v2.27.0, con la estructura de módulos de la sección 1 (el spike es un único archivo por lado; el proyecto real separa tipos, cliente, pipeline y API). Esto también evita arrastrar decisiones del spike (rutas hardcodeadas, falta de manejo de errores) que no pasarían un checkpoint del pipeline real.
- El README final debe apuntar explícitamente a los archivos donde se llama la API de Intercepta (`apps/firewall/src/intercepta-client.ts`, `apps/firewall/src/pipeline/screen.ts` — ajustar a los paths reales) — requisito verbatim del track (`intercepta-implementacion.md` §8).

---

## 6. Registro de riesgos y líneas de corte

| Riesgo | Probabilidad | Impacto | Mitigación / plan B |
|---|---|---|---|
| Key de Intercepta tarda en llegar | media | alto (bloquea WU7) | pedirla apenas empiece la ventana de prep, antes de las 21:00; desarrollar WU7 con un stub que simula las 3 formas de respuesta mientras se espera |
| `scan-message` no reconoce `TransferWithAuthorization` (EIP-3009) | alta (documentado, `intercepta-implementacion.md` §1.4) | bajo | ya decidido: no depender de `scan-message` para el gate — usar solo `scan-address` + `scan-token` (WU7), que igual cubren el requisito del track |
| World ID for Agents con acceso restringido o exige Orb | media | alto (track de $7.5k) | resolver **antes de las 21:00** en el workshop; si no hay acceso, usar IDKit + `@worldcoin/human-in-the-loop` sin perder tiempo de build decidiéndolo en vivo |
| API de TypeSafe (Jev) sin crédito o caída durante el evento | baja | alto (diferencial del producto) | fallback documentado en `jev-diseno.md` §7: NeoHorse-Jev-4B (mismo path `/v1/systemone`, solo cambia `baseURL`) si hay GPU disponible; si no, degradar a solo proveniencia + Intercepta y marcarlo explícitamente en la demo |
| Presupuesto de 1.000 requests de Intercepta se agota | baja | medio | cachear `deepScanAddress`/`scanToken` por dirección con TTL (WU7); con caché, una demo de N pagos cuesta `~N+2` requests, no `3N` |
| Errores de decimales/red x402 (USDC 6 decimales, mezclar `eip155:8453` con `84532`) | media | medio | usar solo `@x402/*` v2, constantes centralizadas en `packages/shared` (WU1), nunca hardcodear decimales sueltos |
| El patrón agente-desacoplado-del-firewall no tiene ejemplo oficial | media | medio | ya validado en el spike de 1h antes de este plan (round-trip real en Sepolia, tx confirmada) — WU3 reimplementa ese patrón ya probado, no lo explora desde cero |
| Falta de tiempo por imprevistos (bugs de integración, RPC lento, cansancio) | alta | alto | líneas de corte abajo |
| Errores por sueño insuficiente en el bloque final (04:30–06:00) | media | medio | WU15 es mayormente documentación/QA, no lógica nueva — bajo riesgo de introducir bugs nuevos tan tarde |

### Líneas de corte (qué recortar primero si se va atrasando, en este orden)
1. **WU14** (verificador independiente) — pura credibilidad extra, ningún track lo exige.
2. **WU13** (botón pausar/revocar) — buena frase de pitch, no funcionalidad requerida.
3. **WU12** (atestación StepUp) — mejora de explicabilidad, no requisito de World.
4. Reducir la cobertura de calibración de Jev (WU8) de 6–8 casos a los 3 críticos (#1 pasa limpio, #3 proveniencia bloquea, #4 Jev bloquea dirección limpia) — son los únicos que aparecen en la demo.
5. Simplificar el dashboard de dos carriles (WU10) a una sola lista de eventos con el resultado y la razón, sin la comparación visual lado a lado — se pierde parte del "factor sorpresa" pero no la explicabilidad.
6. **Último recurso:** si tanto World ID for Agents como IDKit resultan inaccesibles el mismo viernes (no debería pasar si el checklist de la sección 4 se resolvió antes de las 21:00), recortar WU11 completo y renunciar al track de World — se conserva igual el track de Intercepta y el de Curvegrid, que no dependen de World ID.

No se recorta nunca: la capa de proveniencia (WU6, <1ms, es la base del fail-closed cuando Intercepta o Jev fallan) ni el fail-closed en sí (sección 2.4) — son gratis en tiempo de build y son la garantía de seguridad de la que depende todo el pitch.

---

## Fuentes

Todo lo anterior se apoya en, y no repite el detalle ya verificado de: `20-producto.md`, `15-validacion-tecnica.md`, `19-jev-y-arquitectura.md`, `23-inspiracion.md`, `research/showcase-inspiracion-2.md`, `research/jev-diseno.md`, `research/intercepta-implementacion.md`, `03-entrega-y-evaluacion.md`, `02-reglas.md`, `10-skills-y-herramientas-ia.md`, `research/nombres.md`, y el spike descartable en `x402-spike/{server.ts,agent-guardian.ts}` (patrón verificado, código no reutilizado).
