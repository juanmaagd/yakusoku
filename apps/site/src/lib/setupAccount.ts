// On-chain reads/writes for a deployed `OmamorisanAccount` (P11.4's Deposit /
// Withdraw / Pause controls on `/setup`). Every write goes straight through
// the connected wallet — the site never holds a key for this account. Read
// with `viem`'s public client (never trust a cached balance from the
// firewall API for the live figure shown on the page).

import type { Abi, Address, EIP1193Provider, Hex } from "viem";
import { OMAMORISAN_ACCOUNT_ABI } from "@yakusoku/shared";
import { createPublicReadClient, createTargetWalletClient } from "./wallet";

/** Minimal ERC-20 surface needed for the deposit flow — USDC is a standard
 * ERC-20 on Base Sepolia, so no project-specific ABI is needed here. */
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

export async function readUsdcBalance(usdc: Address, account: Address): Promise<bigint> {
  return createPublicReadClient().readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
}

export async function readAccountPaused(account: Address): Promise<boolean> {
  return createPublicReadClient().readContract({ address: account, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "paused" });
}

/** Live `recipients(address)` read — never trust the firewall's `knownMerchants`
 * snapshot for the figure shown right after a `registerMerchant` write. */
export async function readMerchantRegistered(account: Address, merchant: Address): Promise<boolean> {
  return createPublicReadClient().readContract({ address: account, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "recipients", args: [merchant] });
}

/** Deposits USDC from the connected wallet straight into the smart account —
 * a plain ERC-20 transfer, no allowance/approve step needed since the account
 * never pulls funds itself. Simulated first so an insufficient-balance revert
 * surfaces before the wallet even opens, rather than after a rejected send. */
export async function depositUsdc(provider: EIP1193Provider, from: Address, usdc: Address, smartAccount: Address, amount: bigint): Promise<Hex> {
  const publicClient = createPublicReadClient();
  await publicClient.simulateContract({ account: from, address: usdc, abi: ERC20_ABI, functionName: "transfer", args: [smartAccount, amount] });
  const wallet = createTargetWalletClient(provider);
  const hash = await wallet.writeContract({ account: from, address: usdc, abi: ERC20_ABI, functionName: "transfer", args: [smartAccount, amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Owner-only: `OmamorisanAccount.withdraw(to, amount)`. */
export async function withdrawFromAccount(provider: EIP1193Provider, owner: Address, smartAccount: Address, to: Address, amount: bigint): Promise<Hex> {
  const publicClient = createPublicReadClient();
  await publicClient.simulateContract({ account: owner, address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "withdraw", args: [to, amount] });
  const wallet = createTargetWalletClient(provider);
  const hash = await wallet.writeContract({ account: owner, address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "withdraw", args: [to, amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Owner-only: `OmamorisanAccount.setPaused(bool)`. */
export async function setAccountPaused(provider: EIP1193Provider, owner: Address, smartAccount: Address, newPaused: boolean): Promise<Hex> {
  const publicClient = createPublicReadClient();
  await publicClient.simulateContract({ account: owner, address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "setPaused", args: [newPaused] });
  const wallet = createTargetWalletClient(provider);
  const hash = await wallet.writeContract({ account: owner, address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "setPaused", args: [newPaused] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Owner-only: `OmamorisanAccount.setRecipient(address, true)` — registers a
 * known store so this account can pay it (funding.ts's `recipientAllowed`
 * check). Never de-registers from here — the "Registered merchants" card only
 * offers "Register", not "Unregister" (out of scope for M2). */
export async function registerMerchant(provider: EIP1193Provider, owner: Address, smartAccount: Address, merchant: Address): Promise<Hex> {
  const publicClient = createPublicReadClient();
  await publicClient.simulateContract({
    account: owner,
    address: smartAccount,
    abi: OMAMORISAN_ACCOUNT_ABI,
    functionName: "setRecipient",
    args: [merchant, true],
  });
  const wallet = createTargetWalletClient(provider);
  const hash = await wallet.writeContract({
    account: owner,
    address: smartAccount,
    abi: OMAMORISAN_ACCOUNT_ABI,
    functionName: "setRecipient",
    args: [merchant, true],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
