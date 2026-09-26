// Deploys OmamorisanAccountFactory to Base Sepolia.
//
// Run from the `yakusoku/` repo root (so relative workspace imports resolve),
// after `cd contracts && forge build` has produced `out/`:
//
//   bun --env-file=../.env.hackathon run contracts/script/deploy.ts
//
// Reads FIREWALL_PRIVATE_KEY from the environment (never prints it) and
// checks the deployer's ETH balance FIRST: if it is zero, this refuses to
// deploy and prints the exact command to re-run once the wallet is funded,
// per contracts/CLAUDE.md's "do NOT deploy now unless ETH is there" rule.
//
// Deploys ONLY the factory — no user accounts are created and no USDC moves
// on-chain. Constructor argument is the Base Sepolia USDC address from
// packages/shared/constants.ts (the single source of truth for that value).

import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { USDC_SEPOLIA_ADDRESS } from "../../packages/shared/constants";

const ARTIFACT_PATH = new URL("../out/OmamorisanAccountFactory.sol/OmamorisanAccountFactory.json", import.meta.url);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name} — set it in .env.hackathon`);
  }
  return value;
}

async function main() {
  const artifactFile = Bun.file(ARTIFACT_PATH);
  if (!(await artifactFile.exists())) {
    throw new Error(
      `forge build artifact not found at ${ARTIFACT_PATH.pathname} — run \`cd contracts && forge build\` first`,
    );
  }
  const artifact = (await artifactFile.json()) as { abi: unknown[]; bytecode: { object: `0x${string}` } };

  const privateKey = requireEnv("FIREWALL_PRIVATE_KEY") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer: ${account.address}`);
  console.log(`Balance: ${formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.log("\nDeployer has 0 ETH — refusing to deploy (contracts/CLAUDE.md rule).");
    console.log("Fund the wallet, then re-run:");
    console.log("  bun --env-file=../.env.hackathon run contracts/script/deploy.ts");
    process.exit(1);
  }

  console.log(`\nDeploying OmamorisanAccountFactory(token=${USDC_SEPOLIA_ADDRESS}) to Base Sepolia...`);

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [USDC_SEPOLIA_ADDRESS],
  });
  console.log(`Deployment tx: https://sepolia.basescan.org/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deployment failed — receipt status: ${receipt.status}`);
  }

  console.log(`\nOmamorisanAccountFactory deployed at: ${receipt.contractAddress}`);
  console.log(`https://sepolia.basescan.org/address/${receipt.contractAddress}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
