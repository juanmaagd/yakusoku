// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {OmamorisanAccount} from "../src/OmamorisanAccount.sol";

/// @dev Minimal interface onto the REAL deployed Base Sepolia USDC
/// (FiatTokenV2_2 behind its proxy) — only what these fork tests call.
interface IUSDCFull {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function paused() external view returns (bool);
}

/// @title OmamorisanAccount fork tests
/// @notice Exercises {OmamorisanAccount.isValidSignature} against the REAL
/// deployed Base Sepolia USDC (FiatTokenV2_2) — proving the ERC-1271
/// integration actually settles `transferWithAuthorization` end to end, and
/// that every rejection case reverts AT THE TOKEN. No mocked USDC anywhere in
/// this file. See `OmamorisanAccount.t.sol` / `OmamorisanAccountFactory.t.sol`
/// for fast, fork-free unit tests of the same branching logic against a stub
/// token.
contract OmamorisanAccountForkTest is Test {
    // Base Sepolia USDC proxy. Verified live (see contracts/README.md /
    // WU11 report): its implementation (0xd74cc5d436923b8ba2c179b4bCA2841D8A52C5B5)
    // bytecode contains selector 0xcf092995
    // (transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)),
    // and DOMAIN_SEPARATOR()/TRANSFER_WITH_AUTHORIZATION_TYPEHASH() both
    // return non-zero values when called through the proxy.
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Firewall EOA funded with real Base Sepolia USDC for this hackathon
    // (~147.94 USDC verified live via `cast call ... balanceOf`, 2026-09-26).
    // Pranked as the funds source instead of using `vm.deal`/`deal`, because
    // FiatToken packs balance + blacklist state into one storage slot
    // (`balanceAndBlacklistStates`) that a naive slot-write would corrupt.
    address internal constant USDC_HOLDER = 0x73F0c153855ac08267f7843148663d2934343baf;

    IUSDCFull internal usdc;
    OmamorisanAccount internal account;

    address internal owner = makeAddr("owner");
    uint256 internal operatorPk = 0xA11CE;
    address internal operator;
    address internal recipient = makeAddr("recipient");
    address internal facilitator = makeAddr("facilitator");

    uint256 internal constant PER_PAYMENT_LIMIT = 5_000_000; // 5 USDC (6 decimals)
    uint256 internal constant FUND_AMOUNT = 10_000_000; // 10 USDC

    function setUp() public {
        vm.createSelectFork("https://sepolia.base.org");

        usdc = IUSDCFull(USDC);
        assertFalse(usdc.paused(), "USDC is globally paused on this fork; tests would be meaningless");

        operator = vm.addr(operatorPk);

        address[] memory initialRecipients = new address[](1);
        initialRecipients[0] = recipient;
        account = new OmamorisanAccount(USDC, owner, operator, PER_PAYMENT_LIMIT, initialRecipients);

        // Sanity: the account cached the REAL token's domain separator/typehash.
        assertEq(account.domainSeparator(), usdc.DOMAIN_SEPARATOR());
        assertEq(account.transferWithAuthorizationTypehash(), usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());

        vm.prank(USDC_HOLDER);
        require(usdc.transfer(address(account), FUND_AMOUNT), "fund transfer failed");
        assertEq(usdc.balanceOf(address(account)), FUND_AMOUNT);
    }

    function _sign(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint256 signerPk)
        internal
        view
        returns (bytes memory encodedSignature)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                account.transferWithAuthorizationTypehash(), address(account), to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(account.domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes memory operatorSig = abi.encodePacked(r, s, v);
        encodedSignature = abi.encode(to, value, validAfter, validBefore, nonce, operatorSig);
    }

    function test_happyPath_settlesRealTransferWithAuthorization() public {
        uint256 value = 1_000_000; // 1 USDC
        bytes32 nonce = bytes32(uint256(1));
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory encoded = _sign(recipient, value, 0, validBefore, nonce, operatorPk);

        uint256 accountBalanceBefore = usdc.balanceOf(address(account));
        uint256 recipientBalanceBefore = usdc.balanceOf(recipient);

        vm.prank(facilitator);
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);

        assertEq(usdc.balanceOf(address(account)), accountBalanceBefore - value);
        assertEq(usdc.balanceOf(recipient), recipientBalanceBefore + value);
        assertTrue(usdc.authorizationState(address(account), nonce));
    }

    function test_rejects_unregisteredRecipient() public {
        address strangerRecipient = makeAddr("strangerRecipient");
        uint256 value = 1_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(2));
        bytes memory encoded = _sign(strangerRecipient, value, 0, validBefore, nonce, operatorPk);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), strangerRecipient, value, 0, validBefore, nonce, encoded);
    }

    function test_rejects_valueOverLimit() public {
        uint256 value = PER_PAYMENT_LIMIT + 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(3));
        bytes memory encoded = _sign(recipient, value, 0, validBefore, nonce, operatorPk);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);
    }

    function test_rejects_wrongOperatorKey() public {
        uint256 wrongPk = 0xBEEF;
        uint256 value = 1_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(4));
        bytes memory encoded = _sign(recipient, value, 0, validBefore, nonce, wrongPk);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);
    }

    function test_rejects_whenPaused() public {
        uint256 value = 1_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(5));
        bytes memory encoded = _sign(recipient, value, 0, validBefore, nonce, operatorPk);

        vm.prank(owner);
        account.setPaused(true);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);
    }

    function test_rejects_tamperedFields() public {
        // Operator signs a blob authorizing 1 USDC, but the outer call to
        // the token claims 2 USDC — the token computes `hash` from the
        // outer call's own value, which no longer matches the digest
        // OmamorisanAccount recomputes from the blob's (untampered) fields.
        uint256 signedValue = 1_000_000;
        uint256 calledValue = 2_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(6));
        bytes memory encoded = _sign(recipient, signedValue, 0, validBefore, nonce, operatorPk);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), recipient, calledValue, 0, validBefore, nonce, encoded);
    }

    function test_rejects_replayedNonce() public {
        uint256 value = 1_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(7));
        bytes memory encoded = _sign(recipient, value, 0, validBefore, nonce, operatorPk);

        vm.prank(facilitator);
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(address(account), recipient, value, 0, validBefore, nonce, encoded);
    }

    function test_rejects_malformedSignatureBytes() public {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(8));

        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(account), recipient, 1_000_000, 0, validBefore, nonce, hex"1234");
    }

    function test_ownerCanWithdrawRealUsdc() public {
        vm.prank(owner);
        account.withdraw(owner, FUND_AMOUNT);
        assertEq(usdc.balanceOf(owner), FUND_AMOUNT);
        assertEq(usdc.balanceOf(address(account)), 0);
    }
}
