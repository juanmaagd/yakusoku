// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFiatTokenEIP3009
/// @notice Minimal view of Circle's FiatToken (USDC) v2.x surface that
/// `OmamorisanAccount` depends on: the EIP-3009 domain/typehash getters used
/// to recompute the `transferWithAuthorization` digest, and plain ERC-20
/// `transfer` for owner withdrawals.
/// @dev Verified against
/// https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
/// and
/// https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP712Domain.sol
/// (both are `public`/`external` on the deployed FiatTokenV2_2 proxy).
interface IFiatTokenEIP3009 {
    /// @notice EIP-712 domain separator of the token, computed from
    /// (name, "2", chainId, address(token)) — see FiatTokenV2_2._domainSeparator().
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
    /// exposed as a public constant getter on EIP3009.sol.
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    /// @notice Standard ERC-20 transfer, used for owner withdrawals.
    function transfer(address to, uint256 value) external returns (bool);
}
