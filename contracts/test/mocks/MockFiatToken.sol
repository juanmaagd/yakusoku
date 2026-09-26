// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal test double implementing only what {OmamorisanAccount}
/// reads at construction (`DOMAIN_SEPARATOR`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`)
/// plus a trivial `transfer`/`mint`, so `OmamorisanAccount.t.sol` and
/// `OmamorisanAccountFactory.t.sol` can exercise every non-token-integration
/// code path (access control, event emission, `isValidSignature` branching,
/// CREATE2 address prediction) without a live RPC fork.
///
/// This is NOT a spec-accurate USDC/EIP-3009 reimplementation and is never
/// used to prove integration with the real token — that is
/// `OmamorisanAccount.fork.t.sol`'s job, against the actual deployed Base
/// Sepolia USDC contract.
contract MockFiatToken {
    bytes32 public immutable domainSeparatorValue;

    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    // — verified to match the real FiatTokenV2_2's constant via `cast keccak`
    // against the literal EIP-3009 signature string, and cross-checked live
    // against Base Sepolia USDC in OmamorisanAccount.fork.t.sol.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => uint256) public balanceOf;

    constructor(bytes32 domainSeparatorValue_) {
        domainSeparatorValue = domainSeparatorValue_;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return domainSeparatorValue;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
