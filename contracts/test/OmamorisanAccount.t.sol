// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {OmamorisanAccount} from "../src/OmamorisanAccount.sol";
import {MockFiatToken} from "./mocks/MockFiatToken.sol";

/// @title OmamorisanAccount unit tests (no fork)
/// @notice Exercises every non-token-integration code path — owner access
/// control, event emission, `decodeAccountSignature`, and every branch of
/// `isValidSignature` — against a trivial {MockFiatToken} stub, so it runs
/// fast and offline. Integration with the REAL Base Sepolia USDC (proving
/// USDC actually reverts `transferWithAuthorization` for each rejection
/// case) is covered separately by `OmamorisanAccount.fork.t.sol`.
contract OmamorisanAccountTest is Test {
    // secp256k1 group order — used to construct a malleable (high-S)
    // signature for {test_isValidSignature_returnsInvalidForMalleableSignature}.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    MockFiatToken internal token;
    OmamorisanAccount internal account;

    address internal owner = makeAddr("owner");
    uint256 internal operatorPk = 0xA11CE;
    address internal operator;
    address internal recipient = makeAddr("recipient");
    address internal otherRecipient = makeAddr("otherRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant PER_PAYMENT_LIMIT = 100e6;

    function setUp() public {
        operator = vm.addr(operatorPk);
        token = new MockFiatToken(keccak256("mock-domain-separator"));

        address[] memory initialRecipients = new address[](1);
        initialRecipients[0] = recipient;

        account = new OmamorisanAccount(address(token), owner, operator, PER_PAYMENT_LIMIT, initialRecipients);
    }

    function _buildAuthorization(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint256 signerPk
    ) internal view returns (bytes32 digest, bytes memory encodedSignature) {
        bytes32 structHash = keccak256(
            abi.encode(
                account.transferWithAuthorizationTypehash(), address(account), to, value, validAfter, validBefore, nonce
            )
        );
        digest = MessageHashUtils.toTypedDataHash(account.domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes memory operatorSig = abi.encodePacked(r, s, v);
        encodedSignature = abi.encode(to, value, validAfter, validBefore, nonce, operatorSig);
    }

    // ---------------------------------------------------------------------
    // constructor
    // ---------------------------------------------------------------------

    function test_constructor_setsImmutablesAndInitialState() public view {
        assertEq(account.token(), address(token));
        assertEq(account.owner(), owner);
        assertEq(account.operator(), operator);
        assertEq(account.perPaymentLimit(), PER_PAYMENT_LIMIT);
        assertTrue(account.recipients(recipient));
        assertFalse(account.recipients(otherRecipient));
        assertFalse(account.paused());
        assertEq(account.domainSeparator(), token.DOMAIN_SEPARATOR());
        assertEq(account.transferWithAuthorizationTypehash(), token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());
    }

    function test_constructor_revertsOnZeroToken() public {
        address[] memory none = new address[](0);
        vm.expectRevert(bytes("OmamorisanAccount: token=0"));
        new OmamorisanAccount(address(0), owner, operator, PER_PAYMENT_LIMIT, none);
    }

    function test_constructor_revertsOnZeroOwner() public {
        address[] memory none = new address[](0);
        vm.expectRevert(bytes("OmamorisanAccount: owner=0"));
        new OmamorisanAccount(address(token), address(0), operator, PER_PAYMENT_LIMIT, none);
    }

    // ---------------------------------------------------------------------
    // owner-only setters: access control + state + events
    // ---------------------------------------------------------------------

    function test_setOperator_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.setOperator(stranger);
    }

    function test_setOperator_updatesAndEmits() public {
        address newOperator = makeAddr("newOperator");
        vm.expectEmit(true, true, false, false, address(account));
        emit OmamorisanAccount.OperatorUpdated(operator, newOperator);
        vm.prank(owner);
        account.setOperator(newOperator);
        assertEq(account.operator(), newOperator);
    }

    function test_setPerPaymentLimit_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.setPerPaymentLimit(1);
    }

    function test_setPerPaymentLimit_updatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(account));
        emit OmamorisanAccount.PerPaymentLimitUpdated(PER_PAYMENT_LIMIT, 5e6);
        vm.prank(owner);
        account.setPerPaymentLimit(5e6);
        assertEq(account.perPaymentLimit(), 5e6);
    }

    function test_setRecipient_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.setRecipient(otherRecipient, true);
    }

    function test_setRecipient_updatesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(account));
        emit OmamorisanAccount.RecipientUpdated(otherRecipient, true);
        vm.prank(owner);
        account.setRecipient(otherRecipient, true);
        assertTrue(account.recipients(otherRecipient));

        vm.prank(owner);
        account.setRecipient(recipient, false);
        assertFalse(account.recipients(recipient));
    }

    function test_setRecipients_batchUpdatesAndRevertsOnLengthMismatch() public {
        address[] memory list = new address[](2);
        list[0] = otherRecipient;
        list[1] = recipient;
        bool[] memory allowed = new bool[](2);
        allowed[0] = true;
        allowed[1] = false;

        vm.prank(owner);
        account.setRecipients(list, allowed);
        assertTrue(account.recipients(otherRecipient));
        assertFalse(account.recipients(recipient));

        bool[] memory wrongLength = new bool[](1);
        wrongLength[0] = true;
        vm.prank(owner);
        vm.expectRevert(bytes("OmamorisanAccount: length mismatch"));
        account.setRecipients(list, wrongLength);
    }

    function test_setPaused_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.setPaused(true);
    }

    function test_setPaused_updatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(account));
        emit OmamorisanAccount.PausedUpdated(true);
        vm.prank(owner);
        account.setPaused(true);
        assertTrue(account.paused());
    }

    function test_transferOwnership_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.transferOwnership(stranger);
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(bytes("OmamorisanAccount: owner=0"));
        account.transferOwnership(address(0));
    }

    function test_transferOwnership_updatesAndEmits() public {
        address newOwner = makeAddr("newOwner");
        vm.expectEmit(true, true, false, false, address(account));
        emit OmamorisanAccount.OwnershipTransferred(owner, newOwner);
        vm.prank(owner);
        account.transferOwnership(newOwner);
        assertEq(account.owner(), newOwner);
    }

    function test_withdraw_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("OmamorisanAccount: not owner"));
        account.withdraw(stranger, 1);
    }

    function test_withdraw_revertsOnZeroTo() public {
        vm.prank(owner);
        vm.expectRevert(bytes("OmamorisanAccount: to=0"));
        account.withdraw(address(0), 1);
    }

    function test_withdraw_movesFundsAndEmits() public {
        token.mint(address(account), 10e6);
        vm.expectEmit(true, false, false, true, address(account));
        emit OmamorisanAccount.Withdrawn(owner, 4e6);
        vm.prank(owner);
        account.withdraw(owner, 4e6);
        assertEq(token.balanceOf(owner), 4e6);
        assertEq(token.balanceOf(address(account)), 6e6);
    }

    // ---------------------------------------------------------------------
    // decodeAccountSignature
    // ---------------------------------------------------------------------

    function test_decodeAccountSignature_roundTrips() public view {
        bytes memory operatorSig = new bytes(65);
        bytes memory encoded =
            abi.encode(recipient, uint256(1e6), uint256(0), uint256(1 days), bytes32(uint256(42)), operatorSig);

        (address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory sig) =
            account.decodeAccountSignature(encoded);

        assertEq(to, recipient);
        assertEq(value, 1e6);
        assertEq(validAfter, 0);
        assertEq(validBefore, 1 days);
        assertEq(nonce, bytes32(uint256(42)));
        assertEq(sig, operatorSig);
    }

    function test_decodeAccountSignature_revertsOnMalformedInput() public {
        vm.expectRevert();
        account.decodeAccountSignature(hex"1234");
    }

    // ---------------------------------------------------------------------
    // isValidSignature
    // ---------------------------------------------------------------------

    function test_isValidSignature_validAuthorizationReturnsMagicValue() public view {
        (bytes32 digest, bytes memory sig) =
            _buildAuthorization(recipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(1)), operatorPk);
        assertEq(account.isValidSignature(digest, sig), bytes4(0x1626ba7e));
    }

    function test_isValidSignature_returnsInvalidWhenPaused() public {
        (bytes32 digest, bytes memory sig) =
            _buildAuthorization(recipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(2)), operatorPk);
        vm.prank(owner);
        account.setPaused(true);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidForUnregisteredRecipient() public view {
        (bytes32 digest, bytes memory sig) =
            _buildAuthorization(otherRecipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(3)), operatorPk);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidWhenOverLimit() public view {
        (bytes32 digest, bytes memory sig) = _buildAuthorization(
            recipient, PER_PAYMENT_LIMIT + 1, 0, block.timestamp + 1 days, bytes32(uint256(4)), operatorPk
        );
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidForWrongOperatorKey() public view {
        uint256 wrongPk = 0xBEEF;
        (bytes32 digest, bytes memory sig) =
            _buildAuthorization(recipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(5)), wrongPk);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidForTamperedValue() public view {
        // Operator signs a blob authorizing 1e6, but the digest passed in
        // (as the token would compute it) is for a *different* outer-call
        // value (2e6) — the recomputed digest from the blob's own fields
        // must not match `hash`.
        (, bytes memory sig) =
            _buildAuthorization(recipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(6)), operatorPk);

        bytes32 tamperedStructHash = keccak256(
            abi.encode(
                account.transferWithAuthorizationTypehash(),
                address(account),
                recipient,
                uint256(2e6),
                uint256(0),
                block.timestamp + 1 days,
                bytes32(uint256(6))
            )
        );
        bytes32 tamperedDigest = MessageHashUtils.toTypedDataHash(account.domainSeparator(), tamperedStructHash);

        assertEq(account.isValidSignature(tamperedDigest, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidForMalformedSignatureBytes() public view {
        assertEq(account.isValidSignature(bytes32(uint256(1)), hex"1234"), bytes4(0xffffffff));
    }

    function test_isValidSignature_returnsInvalidForMalleableSignature() public view {
        (bytes32 digest,) =
            _buildAuthorization(recipient, 1e6, 0, block.timestamp + 1 days, bytes32(uint256(7)), operatorPk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, digest);

        // Flip to the malleable (high-S, opposite-v) representation of the
        // same signature — OZ's ECDSA.tryRecover must reject it even though
        // it recovers to the same key mathematically.
        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleableOperatorSig = abi.encodePacked(r, flippedS, flippedV);
        bytes memory sig = abi.encode(
            recipient, uint256(1e6), uint256(0), block.timestamp + 1 days, bytes32(uint256(7)), malleableOperatorSig
        );

        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }
}
