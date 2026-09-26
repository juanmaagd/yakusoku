// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {OmamorisanAccount} from "../src/OmamorisanAccount.sol";
import {OmamorisanAccountFactory} from "../src/OmamorisanAccountFactory.sol";
import {MockFiatToken} from "./mocks/MockFiatToken.sol";

contract OmamorisanAccountFactoryTest is Test {
    MockFiatToken internal token;
    OmamorisanAccountFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");

    function setUp() public {
        token = new MockFiatToken(keccak256("mock-domain-separator"));
        factory = new OmamorisanAccountFactory(address(token));
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(bytes("OmamorisanAccountFactory: token=0"));
        new OmamorisanAccountFactory(address(0));
    }

    function test_predictAddress_matchesDeployedAddressAndEmits() public {
        address[] memory recipients = new address[](1);
        recipients[0] = makeAddr("recipient");
        bytes32 salt = keccak256("salt-1");

        address predicted = factory.predictAddress(owner, operator, 100e6, recipients, salt);

        vm.expectEmit(true, true, true, true, address(factory));
        emit OmamorisanAccountFactory.AccountCreated(predicted, owner, operator, salt);
        address deployed = factory.createAccount(owner, operator, 100e6, recipients, salt);

        assertEq(deployed, predicted);
        assertEq(OmamorisanAccount(deployed).owner(), owner);
        assertEq(OmamorisanAccount(deployed).operator(), operator);
        assertEq(OmamorisanAccount(deployed).perPaymentLimit(), 100e6);
        assertTrue(OmamorisanAccount(deployed).recipients(recipients[0]));
    }

    function test_createAccount_revertsOnReuseOfSameSalt() public {
        address[] memory recipients = new address[](0);
        bytes32 salt = keccak256("salt-2");
        factory.createAccount(owner, operator, 1, recipients, salt);
        vm.expectRevert();
        factory.createAccount(owner, operator, 1, recipients, salt);
    }

    function test_predictAddress_differsPerSalt() public view {
        address[] memory recipients = new address[](0);
        address a = factory.predictAddress(owner, operator, 1, recipients, keccak256("salt-a"));
        address b = factory.predictAddress(owner, operator, 1, recipients, keccak256("salt-b"));
        assertTrue(a != b);
    }

    function test_predictAddress_differsPerArguments() public {
        address[] memory recipients = new address[](0);
        bytes32 salt = keccak256("salt-same");
        address a = factory.predictAddress(owner, operator, 1, recipients, salt);
        address b = factory.predictAddress(owner, makeAddr("otherOperator"), 1, recipients, salt);
        assertTrue(a != b);
    }
}
