// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {NexusSwap} from "../src/NexusSwap.sol";
import {Sk256} from "../src/Sk256.sol";

interface IMeta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

//NexusSwap on a fork of a real chain with the real stablecoins (nothing is sent to that chain: anvil/forge only reads
//its state). Skipped without FORK_RPC. tools/fork-check.sh runs it for every chain in mainnet/chains.json:
//  FORK_RPC=<rpc> FORK_TOKENS=0x..,0x.. FORK_DECIMALS=6,6 forge test --match-contract ForkTest -vv
contract ForkTest is Test {
    NexusSwap swap;
    //addresses nobody has a key for: makeAddr("bob") is a public key on every chain and sweeper bots have taken it
    //over with EIP-7702 delegations (on BSC its code forwards what it gets)
    address alice = address(uint160(uint256(keccak256("nexus-dex fork sender"))));
    address bob = address(uint160(uint256(keccak256("nexus-dex fork recipient"))));
    uint256 n;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        uint256 g = gasleft();
        swap = new NexusSwap();
        console2.log("chain id", block.chainid, "block", block.number);
        console2.log("gas deploy", g - gasleft());
    }

    function testRealTokens() public {
        address[] memory tokens = vm.envAddress("FORK_TOKENS", ",");
        uint256[] memory decimals = vm.envUint("FORK_DECIMALS", ",");
        for (uint256 i = 0; i < tokens.length; i++) {
            IMeta t = IMeta(tokens[i]);
            console2.log("token", tokens[i], t.symbol(), t.decimals());
            assertEq(uint256(t.decimals()), decimals[i], "decimals differ from mainnet/chains.json");
            roundTrip(tokens[i], 25 * 10 ** decimals[i]);
        }
        roundTrip(address(0), 0.01 ether);
    }

    //lock and claim with the secret, then lock and refund after the deadline
    function roundTrip(address token, uint256 amount) internal {
        give(token, alice, amount * 2);
        uint256 bobBefore = bal(token, bob);
        uint256 g;

        (bytes32 secret, bytes32 hashlock) = secretPair();
        uint64 deadline = uint64(block.timestamp + 6 hours);
        g = gasleft();
        bytes32 id = lockAs(token, amount, hashlock, deadline);
        console2.log("  gas lock", g - gasleft());
        g = gasleft();
        swap.claim(id, secret);
        console2.log("  gas claim", g - gasleft());
        assertEq(bal(token, bob) - bobBefore, amount, "bob got the amount");

        (, bytes32 hashlock2) = secretPair();
        uint256 aliceBefore = bal(token, alice);
        bytes32 id2 = lockAs(token, amount, hashlock2, deadline);
        assertEq(aliceBefore - bal(token, alice), amount, "the lock took the amount");
        vm.expectRevert(NexusSwap.NotExpired.selector);
        swap.refund(id2);
        vm.warp(deadline);
        g = gasleft();
        swap.refund(id2);
        console2.log("  gas refund", g - gasleft());
        assertEq(bal(token, alice), aliceBefore, "alice got the refund");
    }

    function lockAs(address token, uint256 amount, bytes32 hashlock, uint64 deadline) internal returns (bytes32 id) {
        vm.startPrank(alice);
        if (token == address(0)) {
            id = swap.lock{value: amount}(bob, token, amount, hashlock, deadline, bytes32(0));
        } else {
            //approve through a plain call: USDT on Ethereum returns nothing; reset to 0 first like a wallet would
            (bool ok,) = token.call(abi.encodeWithSelector(0x095ea7b3, address(swap), 0));
            (bool ok2,) = token.call(abi.encodeWithSelector(0x095ea7b3, address(swap), amount));
            require(ok && ok2, "approve");
            id = swap.lock(bob, token, amount, hashlock, deadline, bytes32(0));
        }
        vm.stopPrank();
    }

    function secretPair() internal returns (bytes32 secret, bytes32 hashlock) {
        secret = keccak256(abi.encode("fork secret", n++));
        hashlock = Sk256.hash(secret);
    }

    function give(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            vm.deal(to, to.balance + amount);
        } else {
            deal(token, to, IMeta(token).balanceOf(to) + amount);
        }
    }

    function bal(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : IMeta(token).balanceOf(who);
    }
}
