# Yakusoku contracts — `OmamorisanAccount`

Foundry project (`forge` 1.8.3+) for `OmamorisanAccount` + `OmamorisanAccountFactory`: a
minimal, view-only-rules smart account that IS the x402 USDC payer for one user, validated
via ERC-1271 when USDC's `transferWithAuthorization` (EIP-3009) settles a payment.

See `src/OmamorisanAccount.sol` for the full trust-model NatSpec, and the project root
`CLAUDE.md` (P11.0) for the design rationale.

## Setup

Dependencies are vendored as git submodules registered in the repo root's `.gitmodules`
(`--use-parent-git`, not a nested `.git`), so a fresh clone gets them via the usual:

```shell
git submodule update --init --recursive
```

- `lib/forge-std` — Foundry's standard test/cheatcode library (`forge install`, tag `v1.16.2`).
- `lib/openzeppelin-contracts` — `ECDSA`/`MessageHashUtils`/`IERC1271`/`Create2` (`forge install OpenZeppelin/openzeppelin-contracts@v5.7.0`).

Remappings are in `remappings.txt` (`@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `forge-std/=lib/forge-std/src/`).

## Build & test

```shell
forge build
forge test -vv          # includes fork tests against REAL Base Sepolia USDC — needs network access
```

- `test/OmamorisanAccount.t.sol`, `test/OmamorisanAccountFactory.t.sol` — fast, fork-free unit
  tests (access control, event emission, `isValidSignature` branching, CREATE2 address
  prediction) against `test/mocks/MockFiatToken.sol`, a trivial test double.
- `test/OmamorisanAccount.fork.t.sol` — `vm.createSelectFork("https://sepolia.base.org")`
  against the real deployed Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`),
  proving the ERC-1271 integration actually settles `transferWithAuthorization` end to end and
  that every rejection reverts **at the token**, not just inside our own contract.

## Deploy (Base Sepolia)

`script/deploy.ts` is a standalone bun/viem script (this directory has its own
`package.json`/`node_modules`, deliberately **not** part of the root bun workspace — see
`package.json`'s description — so `contracts/` stays usable independently of the TS apps).
It reads `FIREWALL_PRIVATE_KEY` from `.env.hackathon`, checks the deployer's ETH balance
FIRST, and refuses to deploy if it is zero.

Run from the `yakusoku/` repo root, after `cd contracts && forge build`:

```shell
bun --env-file=../.env.hackathon run contracts/script/deploy.ts
```

Deploys **only** `OmamorisanAccountFactory` (constructor arg: `USDC_SEPOLIA_ADDRESS` from
`packages/shared/constants.ts`) — it never creates a user account or moves USDC.

### Deployed contracts

| Contract | Network | Address | Tx |
| --- | --- | --- | --- |
| `OmamorisanAccountFactory` | Base Sepolia | [`0xadBe165CCc90e59e38A3dE68a25E99Ec807501cc`](https://sepolia.basescan.org/address/0xadBe165CCc90e59e38A3dE68a25E99Ec807501cc) | [`0x2bc01f71…d853f`](https://sepolia.basescan.org/tx/0x2bc01f718e3adefb42248b2e93459e6db9ed60756268aa4eb18ed84b6ebd853f) |

Verified on-chain (not just from the deploy script's own output): `cast receipt` shows
`status: 1 (success)`, and `cast call ... "token()(address)"` on the deployed factory returns
the expected `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. No user accounts have been created
and no USDC has moved — only the factory itself is deployed.

## Known limitations / open questions for review

See the P11.0 report for the full list (cached `domainSeparator`/typehash bricking risk if
Circle ever renames the token via proxy upgrade, `OmamorisanAccountFactory.createAccount`'s
event-after-external-call linter warning, `abi.encodePacked` collision warning on init-code
construction — both reviewed and considered non-issues for this design, see report).
