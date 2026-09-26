// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IFiatTokenEIP3009} from "./interfaces/IFiatTokenEIP3009.sol";

/// @title OmamorisanAccount
/// @notice A minimal, view-only-rules smart account that IS the x402 USDC
/// payer for one user. It never holds a private key of its own: USDC's
/// `transferWithAuthorization` (EIP-3009) settles by calling back into this
/// contract's {isValidSignature} (ERC-1271) instead of `ecrecover`-ing an EOA
/// signature directly, because `from == address(this)` is a contract.
///
/// Trust model:
/// - `owner` (the human user's key) controls every rule on this account
///   (operator, per-payment limit, recipient allow-list, pause, funds) and
///   can withdraw the full balance at any time. The owner is fully trusted.
/// - `operator` (the firewall's signing key) can only ever *authorize a USDC
///   transfer to an already-owner-approved recipient, up to the configured
///   per-payment limit*. The operator key can never move funds anywhere else,
///   never change any rule, and never exceed the limit — even if it is fully
///   compromised, the blast radius is bounded by `perPaymentLimit *
///   (number of pending authorizations the operator can still get accepted
///   by a facilitator before the owner revokes it)`.
/// - Total value at risk from a compromised operator key or a malicious
///   facilitator/relayer is therefore bounded by the account's deposited USDC
///   balance and by `perPaymentLimit` per authorization; it can never exceed
///   the balance actually held by this contract.
///
/// This contract holds no per-authorization state of its own (no nonce
/// bookkeeping, no spend counters): USDC's own `_authorizationStates` mapping
/// (keyed by `(from, nonce)` where `from == address(this)`) is the sole
/// replay-protection mechanism, and USDC's own `validAfter`/`validBefore`
/// window is the sole expiry mechanism. {isValidSignature} is a pure view
/// over the rules above plus one ECDSA check — nothing here can revert the
/// token's call, by design (see {isValidSignature}).
///
/// There is no generic `execute`, no delegatecall, and no upgradeability:
/// the only fund movement paths are USDC `transferWithAuthorization` (via the
/// operator, bounded by the rules above) and the owner's {withdraw}.
contract OmamorisanAccount is IERC1271 {
    /// @dev ERC-1271 magic value returned when a signature is valid, per
    /// https://eips.ethereum.org/EIPS/eip-1271.
    bytes4 private constant _ERC1271_MAGIC_VALUE = 0x1626ba7e;

    /// @dev Value returned for any invalid signature or malformed input.
    /// {isValidSignature} never reverts — see its NatSpec.
    bytes4 private constant _ERC1271_INVALID_VALUE = 0xffffffff;

    /// @notice The USDC token this account pays with. Immutable: this
    /// account is deployed for exactly one token.
    address public immutable token;

    /// @dev EIP-712 domain separator of {token}, cached at construction from
    /// `IFiatTokenEIP3009(token).DOMAIN_SEPARATOR()`.
    ///
    /// KNOWN LIMITATION (documented for review): FiatTokenV2_2 derives its
    /// domain separator from (name, "2", chainId) at call time rather than
    /// caching it itself, so if Circle ever renamed the deployed token via a
    /// proxy upgrade, this cached value would go stale and every subsequent
    /// {isValidSignature} call would correctly (fail-closed) return
    /// `0xffffffff` forever — the account would need to be redeployed. This
    /// is accepted for the hackathon target (Base Sepolia USDC, not expected
    /// to be renamed) in exchange for one fewer external call (and therefore
    /// lower gas) on every payment authorization. Reading it live via
    /// `IFiatTokenEIP3009(token).DOMAIN_SEPARATOR()` on every call is the
    /// straightforward alternative if this account is ever reused for a
    /// token whose name can change post-deployment.
    bytes32 public immutable domainSeparator;

    /// @dev EIP-3009 `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` of {token},
    /// cached at construction. This is a `pragma solidity 0.6.12` file-level
    /// constant on the token (`keccak256("TransferWithAuthorization(...)")`)
    /// and cannot change after deployment, so caching it has no downside.
    bytes32 public immutable transferWithAuthorizationTypehash;

    /// @notice The user's own key. Controls every rule below and can always
    /// withdraw the full balance.
    address public owner;

    /// @notice The firewall's signing key. Can only authorize transfers to
    /// an allow-listed {recipients} entry, up to {perPaymentLimit}, while
    /// unpaused.
    address public operator;

    /// @notice Maximum USDC value (6 decimals) a single authorization may
    /// move.
    uint256 public perPaymentLimit;

    /// @notice Owner-controlled allow-list of payment recipients. A transfer
    /// to any address not in this mapping is never authorized.
    mapping(address => bool) public recipients;

    /// @notice When true, {isValidSignature} always returns the invalid
    /// value, blocking every USDC `transferWithAuthorization` regardless of
    /// signature validity. Does not block owner functions or {withdraw}.
    bool public paused;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event PerPaymentLimitUpdated(uint256 previousLimit, uint256 newLimit);
    event RecipientUpdated(address indexed recipient, bool allowed);
    event PausedUpdated(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    /// @dev Reverts unless the caller is the current {owner}.
    modifier onlyOwner() {
        require(msg.sender == owner, "OmamorisanAccount: not owner");
        _;
    }

    /// @param token_ The USDC (EIP-3009) token this account pays with.
    /// @param owner_ The user's key.
    /// @param operator_ The firewall's signing key (may be `address(0)` to
    /// start with no operator authorized).
    /// @param perPaymentLimit_ Initial per-payment USDC limit.
    /// @param initialRecipients Initial recipient allow-list.
    constructor(
        address token_,
        address owner_,
        address operator_,
        uint256 perPaymentLimit_,
        address[] memory initialRecipients
    ) {
        require(token_ != address(0), "OmamorisanAccount: token=0");
        require(owner_ != address(0), "OmamorisanAccount: owner=0");

        token = token_;
        domainSeparator = IFiatTokenEIP3009(token_).DOMAIN_SEPARATOR();
        transferWithAuthorizationTypehash = IFiatTokenEIP3009(token_).TRANSFER_WITH_AUTHORIZATION_TYPEHASH();

        owner = owner_;
        operator = operator_;
        perPaymentLimit = perPaymentLimit_;

        for (uint256 i = 0; i < initialRecipients.length; ++i) {
            recipients[initialRecipients[i]] = true;
            emit RecipientUpdated(initialRecipients[i], true);
        }

        emit OwnershipTransferred(address(0), owner_);
        emit OperatorUpdated(address(0), operator_);
        emit PerPaymentLimitUpdated(0, perPaymentLimit_);
    }

    /// @notice Replace the firewall's signing key.
    function setOperator(address newOperator) external onlyOwner {
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Update the maximum USDC value a single authorization may move.
    function setPerPaymentLimit(uint256 newLimit) external onlyOwner {
        emit PerPaymentLimitUpdated(perPaymentLimit, newLimit);
        perPaymentLimit = newLimit;
    }

    /// @notice Allow or revoke one payment recipient.
    function setRecipient(address recipient, bool allowed) external onlyOwner {
        recipients[recipient] = allowed;
        emit RecipientUpdated(recipient, allowed);
    }

    /// @notice Allow or revoke several payment recipients in one call.
    /// @param recipientList Addresses to update.
    /// @param allowedList Matching allow/revoke flags (same length as
    /// `recipientList`).
    function setRecipients(address[] calldata recipientList, bool[] calldata allowedList) external onlyOwner {
        require(recipientList.length == allowedList.length, "OmamorisanAccount: length mismatch");
        for (uint256 i = 0; i < recipientList.length; ++i) {
            recipients[recipientList[i]] = allowedList[i];
            emit RecipientUpdated(recipientList[i], allowedList[i]);
        }
    }

    /// @notice Pause or unpause payment authorization. While paused,
    /// {isValidSignature} always returns the invalid value.
    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PausedUpdated(newPaused);
    }

    /// @notice Withdraw USDC held by this account to any address, bypassing
    /// the recipient allow-list and per-payment limit (owner is fully
    /// trusted).
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "OmamorisanAccount: to=0");
        require(IFiatTokenEIP3009(token).transfer(to, amount), "OmamorisanAccount: transfer failed");
        emit Withdrawn(to, amount);
    }

    /// @notice Transfer ownership of this account to a new key.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OmamorisanAccount: owner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice ERC-1271 signature validation, called by USDC's
    /// `transferWithAuthorization` (via `SignatureChecker.isValidERC1271SignatureNow`)
    /// when `from == address(this)`.
    ///
    /// `signature` is decoded as `abi.encode(address to, uint256 value,
    /// uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes
    /// operatorSig)`. `hash` is the EIP-712 digest USDC computed from the
    /// *outer call's* `from`/`to`/`value`/`validAfter`/`validBefore`/`nonce`.
    /// This function independently recomputes the same digest from the
    /// *decoded blob's* fields and requires the two to match — this is what
    /// catches a caller passing different `to`/`value`/etc. to the token
    /// call than what the operator actually signed inside the blob.
    ///
    /// Returns the ERC-1271 magic value (`0x1626ba7e`) only if all of:
    /// - `signature` decodes successfully to the expected shape;
    /// - the account is not {paused};
    /// - `to` is an allow-listed {recipients} entry;
    /// - `value` does not exceed {perPaymentLimit};
    /// - the recomputed digest equals `hash`;
    /// - `operatorSig` is a valid, non-malleable 65-byte ECDSA signature over
    ///   `hash` that recovers to {operator}.
    ///
    /// Otherwise returns the invalid value (`0xffffffff`). This function
    /// NEVER reverts on malformed or malicious input — SignatureChecker
    /// calls it via `staticcall` and treats any revert as "not this
    /// contract's problem" rather than "invalid signature", so a revert here
    /// could in principle be used to probe the call rather than cleanly fail
    /// closed; returning the invalid value keeps the failure mode uniform
    /// and matches the ERC-1271 spec ("Solidity's revert() would fail as
    /// well, but not be idiomatic").
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        if (paused) {
            return _ERC1271_INVALID_VALUE;
        }

        try this.decodeAccountSignature(signature) returns (
            address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory operatorSig
        ) {
            if (!recipients[to]) {
                return _ERC1271_INVALID_VALUE;
            }
            if (value > perPaymentLimit) {
                return _ERC1271_INVALID_VALUE;
            }

            bytes32 structHash = keccak256(
                abi.encode(transferWithAuthorizationTypehash, address(this), to, value, validAfter, validBefore, nonce)
            );
            bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
            if (digest != hash) {
                return _ERC1271_INVALID_VALUE;
            }

            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, operatorSig);
            if (err != ECDSA.RecoverError.NoError || recovered != operator) {
                return _ERC1271_INVALID_VALUE;
            }

            return _ERC1271_MAGIC_VALUE;
        } catch {
            return _ERC1271_INVALID_VALUE;
        }
    }

    /// @notice Decode the `isValidSignature` signature blob. `external` so
    /// {isValidSignature} can call it through `try`/`catch` and treat any
    /// `abi.decode` failure (wrong length, bad offsets, ...) as "invalid"
    /// instead of reverting. Also usable off-chain/in tests to sanity-check
    /// an encoded blob.
    function decodeAccountSignature(bytes calldata signature)
        external
        pure
        returns (
            address to,
            uint256 value,
            uint256 validAfter,
            uint256 validBefore,
            bytes32 nonce,
            bytes memory operatorSig
        )
    {
        (to, value, validAfter, validBefore, nonce, operatorSig) =
            abi.decode(signature, (address, uint256, uint256, uint256, bytes32, bytes));
    }
}
