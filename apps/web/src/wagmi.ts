import { cookieStorage, createConfig, createStorage, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// Yakusoku only ever signs against Base Sepolia (packages/shared CHAIN_ID),
// and only via an injected wallet (MetaMask) for the hackathon demo.
export function getConfig() {
  return createConfig({
    chains: [baseSepolia],
    connectors: [injected()],
    storage: createStorage({
      storage: cookieStorage,
    }),
    ssr: true,
    transports: {
      [baseSepolia.id]: http(),
    },
  })
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof getConfig>
  }
}
