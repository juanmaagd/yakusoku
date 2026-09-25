# 13 — Decisiones

## D3 — Nombre, voz y tercer sponsor

**Estado:** ✅ decidida (2026-09-25, 16:30 JST).
- **Nombre:** **Yakusoku** (約束, "promesa"). Al participante le daba igual; se eligió la recomendación. Sin choques en el showcase, GitHub ni npm (`research/nombres.md`). "Intent Firewall" se descartó por el choque con Mandate Treasury y ENSFirewall.
- **Voz (GPT-Live-1):** **fuera del MVP**. Es un extra (COULD) si sobra tiempo el sábado a la noche. Motivos: más de 4 h, costo, no está en el tier gratuito y no suma a ningún track.
- **Tercer sponsor:** **Curvegrid — Best AI Agent Project** ($1k). Seguro y sin requisitos extra.
- **Tracks finales:** Intercepta (x402) + World ID for Agents (verificado en el sandbox) + Curvegrid AI Agent.

## D2 — Idea elegida: Intent Firewall (ahora Yakusoku)

**Estado:** ✅ decidida (2026-09-25). Definición completa en [20-producto.md](20-producto.md).

- **Qué es:** un firewall de intención para pagos de agentes de IA. Idempotencia → límites (saldo) → Intercepta → Jev contra la intención firmada por el usuario → World ID.
- **Escenario de la demo:** comprar una gift card de regalo (basado en Cryptorefills, servicio real con x402). Se eligió sobre el hotel por simplicidad y por la narrativa de estafas con gift cards. El escenario de noticias se descartó porque no existe con x402.
- **Tracks:** Intercepta + World ID for Agents (plan B: IDKit) + Curvegrid AI Agent.
- **Por qué:** el hueco (juicio de intención calibrado) está verificado como no cubierto, los tracks lo describen casi textual y el MVP no requiere Solidity.
- **Ideas descartadas:** B (existe una demo oficial casi idéntica), C (solo pierde contra Namera; queda como posible capa futura), D (débil como core), E (común).
- **Dudas del participante que quedaron registradas:** baja adopción de x402 (respuesta: somos la seguridad que falta antes de que escale; aplica a cualquier transacción de un agente) y síndrome del impostor frente a equipos senior (respuesta: el hueco es de dominio de agentes, no de Solidity).

## D1 — Modalidad: From Scratch vs. Continuity

**Estado:** ✅ decidida → **From Scratch** (2026-09-25).

**Por qué se descartó pr-hero + World ID:**
- Un gate de aprobación humana para el maintainer (World ID for Agents) no aporta nada. GitHub ya autentica a quien mergea (cuenta, 2FA, audit log), y un admin puede saltearse cualquier gate: desactivar el workflow, sacar la protección de rama o mergear como admin. El maintainer no es el adversario.
- El Proof of Human para contribuyentes externos solo aporta cuando cada humano tiene que contar una vez (bounties, recompensas, votos). Eso ya es otro producto, no pr-hero.
- Sin usuarios reales, la ventaja de Continuity era chica (~$4,5k de pool relevante).
- Conclusión del participante: "es muy forzado".

**Lección para elegir la idea:** la identidad y los pagos web3 tienen sentido donde **no hay una plataforma confiable** que ya resuelva quién es quién y quién paga (agentes que se pagan entre sí, servicios abiertos sin cuentas, recursos por humano único). Si GitHub, Stripe o un login ya lo resuelven, web3 es decorativo.

### Proyectos propios evaluados
| Proyecto | Tipo | Usuarios reales | ¿Sirve para Continuity? |
|---|---|---|---|
| Marki | App mobile | — | No: meterle web3 sería forzado |
| pr-hero | Revisor de código con IA, open source, mantenido por el participante | No | Se evaluó y se descartó (ver arriba) |

### Comparación que se usó
| | From Scratch | Continuity con pr-hero |
|---|---|---|
| Tiempo | Todo desde cero | La base ya existe y el tiempo va a web3 |
| Pool exclusivo relevante | — | ~$4,5k (ENS $4k + Intercepta $500) |
| Tracks perdidos | — | ENS abierto ($6k, exige from scratch) |
| Riesgo de reglas | Ninguno | FAQ vieja vs. regla nueva |
| Pitch | Idea nueva | Producto real, sin usuarios |
