// Network + token constants for Base Sepolia, the only chain this project uses.
// Values verified in docs/research/plan-tecnico.md §2 / .env.example — do not
// hardcode these elsewhere (see plan-tecnico.md §6, "errores de decimales/red").

export const CHAIN_ID = 84532;

/** x402 CAIP-2 network id for Base Sepolia. */
export const X402_NETWORK = "eip155:84532";

/** Base Sepolia USDC (6 decimals) — the token actually paid in the demo. */
export const USDC_SEPOLIA_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/**
 * Base mainnet USDC (6 decimals). Intercepta's token screening only has
 * mainnet data, so the firewall maps the Sepolia USDC address to this one
 * before calling scan-token (plan-tecnico.md §6, Intercepta client note).
 */
export const USDC_MAINNET_ADDRESS = "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const USDC_DECIMALS = 6;

export const FACILITATOR_URL = "https://x402.org/facilitator";
