// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Sk256} from "../src/Sk256.sol";

contract Sk256Harness {
    function hash(bytes32 data) external pure returns (bytes32) {
        return Sk256.hash(data);
    }
}

//vectors from the wallet's tritium.ts sk256 (dex/spikes/sk256-vectors.test.ts), file in VECTORS
contract Sk256Test is Test {
    Sk256Harness harness;

    function setUp() public {
        harness = new Sk256Harness();
    }

    function testMatchesWalletVectors() public {
        string memory json = vm.readFile(vm.envString("VECTORS"));
        bytes32[] memory inputs = vm.parseJsonBytes32Array(json, ".inputs");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".hashes");
        assertEq(inputs.length, hashes.length);
        assertGt(inputs.length, 0);
        for (uint256 i = 0; i < inputs.length; i++) {
            assertEq(harness.hash(inputs[i]), hashes[i]);
        }
    }

    function testGas() public {
        uint256 before = gasleft();
        harness.hash(keccak256("gas"));
        emit log_named_uint("sk256 gas", before - gasleft());
    }
}
