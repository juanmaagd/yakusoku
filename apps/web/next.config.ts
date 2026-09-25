import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // @yakusoku/shared ships TypeScript source (no build step); Next needs to
  // run it through its own compiler instead of treating it as pre-built JS.
  transpilePackages: ['@yakusoku/shared'],
}

export default nextConfig
