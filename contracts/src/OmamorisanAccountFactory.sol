// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {OmamorisanAccount} from "./OmamorisanAccount.sol";

/// @title OmamorisanAccountFactory
/// @notice Deterministically deploys {OmamorisanAccount} instances via
/// `CREATE2`. Anyone may call {createAccount} — the deployed account's owner
/// is always the `owner` argument, never `msg.sender`, so calling this
/// factory on someone else's behalf (e.g. the firewall backend deploying a
/// user's account for them) does not grant the caller any control.
contract OmamorisanAccountFactory {
    /// @notice The USDC (EIP-3009) token every account deployed by this
    /// factory pays with.
    address public immutable token;

    /// @notice Emitted every time {createAccount} deploys a new account.
    event AccountCreated(address indexed account, address indexed owner, address indexed operator, bytes32 salt);

    constructor(address token_) {
        require(token_ != address(0), "OmamorisanAccountFactory: token=0");
        token = token_;
    }

    /// @notice Deploy a new {OmamorisanAccount} at the deterministic address
    /// returned by {predictAddress} for the same arguments.
    /// @param owner_ The user's key; will own the deployed account.
    /// @param operator_ The firewall's signing key for the deployed account.
    /// @param perPaymentLimit_ Initial per-payment USDC limit.
    /// @param initialRecipients Initial recipient allow-list.
    /// @param salt Caller-chosen salt; combined with the constructor
    /// arguments (via the init code hash) to determine the deployed address,
    /// so the same arguments with a different salt deploy to a different
    /// address, and the same arguments with the same salt can only ever be
    /// deployed once.
    /// @return account The deployed account's address.
    function createAccount(
        address owner_,
        address operator_,
        uint256 perPaymentLimit_,
        address[] calldata initialRecipients,
        bytes32 salt
    ) external returns (address account) {
        account = Create2.deploy(0, salt, _initCode(owner_, operator_, perPaymentLimit_, initialRecipients));
        emit AccountCreated(account, owner_, operator_, salt);
    }

    /// @notice Predict the address {createAccount} would deploy to for the
    /// given arguments and salt, without deploying anything.
    function predictAddress(
        address owner_,
        address operator_,
        uint256 perPaymentLimit_,
        address[] calldata initialRecipients,
        bytes32 salt
    ) external view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(_initCode(owner_, operator_, perPaymentLimit_, initialRecipients));
        predicted = Create2.computeAddress(salt, bytecodeHash);
    }

    /// @dev Builds the {OmamorisanAccount} creation code (contract bytecode
    /// plus ABI-encoded constructor arguments) shared by {createAccount} and
    /// {predictAddress}, so the two can never compute a different address for
    /// the same logical arguments.
    function _initCode(
        address owner_,
        address operator_,
        uint256 perPaymentLimit_,
        address[] calldata initialRecipients
    ) private view returns (bytes memory) {
        // bytes.concat (not abi.encodePacked) of two already-unambiguous byte
        // strings: contract creation code has a fixed, self-describing
        // length, and the constructor args are themselves produced by
        // abi.encode (not encodePacked), so there is no dynamic-type
        // collision risk here despite the shape looking similar to one.
        return bytes.concat(
            type(OmamorisanAccount).creationCode,
            abi.encode(token, owner_, operator_, perPaymentLimit_, initialRecipients)
        );
    }
}
