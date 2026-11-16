// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NexusSwap} from "../src/NexusSwap.sol";
import {Sk256} from "../src/Sk256.sol";

//bool returning token (USDC, BSC USDT)
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool internal noReturn;
    uint256 internal feeBps;

    constructor(bool noReturn_, uint256 feeBps_) {
        noReturn = noReturn_;
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount * feeBps) / 10000;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        move(msg.sender, to, amount);
        return ret();
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        move(from, to, amount);
        return ret();
    }

    function ret() internal view returns (bool) {
        if (noReturn) {
            //like Ethereum USDT: no return data
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}

contract Hasher {
    function hash(bytes32 s) external pure returns (bytes32) {
        return Sk256.hash(s);
    }
}

//a recipient that tries to claim or refund again while it is being paid
contract Reenter {
    NexusSwap swap;
    bytes32 id;
    bytes32 secret;
    bool public triedAgain;
    bool public secondCallFailed;

    constructor(NexusSwap swap_) {
        swap = swap_;
    }

    function arm(bytes32 id_, bytes32 secret_) external {
        id = id_;
        secret = secret_;
    }

    receive() external payable {
        if (!triedAgain) {
            triedAgain = true;
            try swap.claim(id, secret) {} catch {
                secondCallFailed = true;
            }
        }
    }
}

//a token whose transfer hook locks again from inside transferFrom (ERC-777 style)
contract HookToken is MockToken {
    NexusSwap swap;
    bool armed;
    bool public innerFailed;

    constructor(NexusSwap swap_) MockToken(false, 0) {
        swap = swap_;
    }

    function arm() external {
        armed = true;
        balanceOf[address(this)] += 100e6;
        allowance[address(this)][address(swap)] = type(uint256).max;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (armed) {
            armed = false;
            try swap.lock(address(0xB0B), address(this), amount, bytes32(0), uint64(block.timestamp + 1 hours), bytes32("inner")) {} catch {
                innerFailed = true;
            }
        }
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        move(from, to, amount);
        return true;
    }
}

//a recipient that takes no native coins
contract NoReceive {}

contract NexusSwapTest is Test {
    NexusSwap swap;
    MockToken usdc;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 secret = keccak256("secret");
    bytes32 hashlock;
    uint64 deadline;

    function setUp() public {
        swap = new NexusSwap();
        usdc = new MockToken(false, 0);
        hashlock = new Hasher().hash(secret);
        deadline = uint64(block.timestamp + 12 hours);
        usdc.mint(alice, 1000e6);
        vm.prank(alice);
        usdc.approve(address(swap), type(uint256).max);
    }

    function lockAs(MockToken token, uint256 amount) internal returns (bytes32) {
        vm.prank(alice);
        return swap.lock(bob, address(token), amount, hashlock, deadline, bytes32("offer-1"));
    }

    function testClaimWithSecret() public {
        bytes32 id = lockAs(usdc, 100e6);
        uint256 before = gasleft();
        swap.claim(id, secret); //by anyone, here the test contract (a watcher)
        emit log_named_uint("claim gas", before - gasleft());
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(swap)), 0);
    }

    function testWrongSecret() public {
        bytes32 id = lockAs(usdc, 100e6);
        vm.expectRevert(NexusSwap.WrongSecret.selector);
        swap.claim(id, keccak256("nope"));
    }

    function testNoClaimAfterDeadline() public {
        bytes32 id = lockAs(usdc, 100e6);
        vm.warp(deadline);
        vm.expectRevert(NexusSwap.Expired.selector);
        swap.claim(id, secret);
    }

    function testRefundOnlyAfterDeadline() public {
        bytes32 id = lockAs(usdc, 100e6);
        vm.expectRevert(NexusSwap.NotExpired.selector);
        swap.refund(id);
        vm.warp(deadline);
        swap.refund(id);
        assertEq(usdc.balanceOf(alice), 1000e6);
        vm.expectRevert(NexusSwap.NotOpen.selector);
        swap.claim(id, secret);
    }

    function testNoDoubleClaim() public {
        bytes32 id = lockAs(usdc, 100e6);
        swap.claim(id, secret);
        vm.expectRevert(NexusSwap.NotOpen.selector);
        swap.claim(id, secret);
        vm.warp(deadline);
        vm.expectRevert(NexusSwap.NotOpen.selector);
        swap.refund(id);
    }

    function testSameLockTwiceRefused() public {
        lockAs(usdc, 100e6);
        vm.expectRevert(NexusSwap.AlreadyExists.selector);
        lockAs(usdc, 100e6);
    }

    function testBadParams() public {
        vm.startPrank(alice);
        vm.expectRevert(NexusSwap.BadParams.selector);
        swap.lock(bob, address(usdc), 100e6, hashlock, uint64(block.timestamp), bytes32(0));
        vm.expectRevert(NexusSwap.BadParams.selector);
        swap.lock(address(0), address(usdc), 100e6, hashlock, deadline, bytes32(0));
        vm.expectRevert(NexusSwap.BadParams.selector);
        swap.lock(bob, address(usdc), 0, hashlock, deadline, bytes32(0));
        vm.stopPrank();
    }

    function testDeadlineAtMostThirtyDays() public {
        vm.startPrank(alice);
        vm.expectRevert(NexusSwap.BadParams.selector);
        swap.lock(bob, address(usdc), 100e6, hashlock, uint64(block.timestamp + 30 days + 1), bytes32(0));
        swap.lock(bob, address(usdc), 100e6, hashlock, uint64(block.timestamp + 30 days), bytes32(0));
        vm.stopPrank();
    }

    function testClaimToOnlyByTheRecipient() public {
        bytes32 id = lockAs(usdc, 100e6);
        address carol = address(0xCA201);
        vm.expectRevert(NexusSwap.NotRecipient.selector);
        swap.claimTo(id, secret, carol);
        vm.prank(alice);
        vm.expectRevert(NexusSwap.NotRecipient.selector);
        swap.claimTo(id, secret, alice);
        vm.prank(bob);
        vm.expectRevert(NexusSwap.WrongSecret.selector);
        swap.claimTo(id, keccak256("nope"), carol);
        vm.prank(bob);
        swap.claimTo(id, secret, carol);
        assertEq(usdc.balanceOf(carol), 100e6);
        assertEq(usdc.balanceOf(bob), 0);
        vm.prank(bob);
        vm.expectRevert(NexusSwap.NotOpen.selector);
        swap.claimTo(id, secret, carol);
    }

    //a recipient that cannot take the payment (here: refuses the coin, as a frozen USDT address would) collects to
    //another address of its own
    function testClaimToWhenTheRecipientCannotReceive() public {
        NoReceive stuck = new NoReceive();
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        bytes32 id = swap.lock{value: 1 ether}(address(stuck), address(0), 1 ether, hashlock, deadline, bytes32("x"));
        vm.expectRevert(NexusSwap.TransferFailed.selector);
        swap.claim(id, secret);
        address carol = address(0xCA201);
        vm.prank(address(stuck));
        swap.claimTo(id, secret, carol);
        assertEq(carol.balance, 1 ether);
    }

    function testTokenWithoutReturnValue() public {
        MockToken usdt = new MockToken(true, 0);
        usdt.mint(alice, 50e6);
        vm.prank(alice);
        usdt.approve(address(swap), type(uint256).max);
        bytes32 id = lockAs(usdt, 50e6);
        swap.claim(id, secret);
        assertEq(usdt.balanceOf(bob), 50e6);
    }

    function lockNative(address to, uint256 amount, uint256 value) internal returns (bytes32) {
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        return swap.lock{value: value}(to, address(0), amount, hashlock, deadline, bytes32("offer-n"));
    }

    function testNativeClaim() public {
        bytes32 id = lockNative(bob, 1 ether, 1 ether);
        assertEq(address(swap).balance, 1 ether);
        swap.claim(id, secret);
        assertEq(bob.balance, 1 ether);
        assertEq(address(swap).balance, 0);
    }

    function testNativeRefund() public {
        bytes32 id = lockNative(bob, 1 ether, 1 ether);
        vm.warp(deadline);
        swap.refund(id);
        assertEq(alice.balance, 10 ether);
        assertEq(address(swap).balance, 0);
    }

    function testNativeValueMustMatch() public {
        vm.expectRevert(NexusSwap.WrongValue.selector);
        lockNative(bob, 1 ether, 0.5 ether);
        vm.expectRevert(NexusSwap.WrongValue.selector);
        lockNative(bob, 1 ether, 2 ether);
    }

    function testNoValueWithAToken() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(NexusSwap.WrongValue.selector);
        swap.lock{value: 1}(bob, address(usdc), 100e6, hashlock, deadline, bytes32("offer-1"));
    }

    function testNoStrayCoins() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(swap).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function testReenteringRecipientGetsPaidOnce() public {
        Reenter r = new Reenter(swap);
        bytes32 id = lockNative(address(r), 1 ether, 1 ether);
        r.arm(id, secret);
        swap.claim(id, secret);
        assertTrue(r.triedAgain());
        assertTrue(r.secondCallFailed());
        assertEq(address(r).balance, 1 ether);
        assertEq(address(swap).balance, 0);
    }

    //a recipient that refuses coins only blocks its own payment; the sender gets the coins back after the deadline
    function testRefusingRecipientCannotTrapTheSender() public {
        NoReceive nr = new NoReceive();
        bytes32 id = lockNative(address(nr), 1 ether, 1 ether);
        vm.expectRevert(NexusSwap.TransferFailed.selector);
        swap.claim(id, secret);
        vm.warp(deadline);
        swap.refund(id);
        assertEq(alice.balance, 10 ether);
    }

    function testFeeOnTransferRefused() public {
        MockToken feeToken = new MockToken(false, 100); //1 %
        feeToken.mint(alice, 100e6);
        vm.prank(alice);
        feeToken.approve(address(swap), type(uint256).max);
        vm.expectRevert(NexusSwap.TransferFailed.selector);
        lockAs(feeToken, 100e6);
    }

    //a sender that cannot take its refund (frozen, or refuses the coin) has it paid to another address of its own
    function testRefundToOnlyBySenderAfterDeadline() public {
        NoReceive stuck = new NoReceive();
        vm.deal(address(stuck), 1 ether);
        vm.prank(address(stuck));
        bytes32 id = swap.lock{value: 1 ether}(bob, address(0), 1 ether, hashlock, deadline, bytes32("x"));
        address carol = address(0xCA201);
        vm.prank(address(stuck));
        vm.expectRevert(NexusSwap.NotExpired.selector);
        swap.refundTo(id, carol);
        vm.warp(deadline);
        vm.expectRevert(NexusSwap.TransferFailed.selector);
        swap.refund(id);
        vm.expectRevert(NexusSwap.NotSender.selector);
        swap.refundTo(id, carol);
        vm.prank(bob);
        vm.expectRevert(NexusSwap.NotSender.selector);
        swap.refundTo(id, bob);
        vm.prank(address(stuck));
        vm.expectRevert(NexusSwap.BadParams.selector);
        swap.refundTo(id, address(0));
        vm.prank(address(stuck));
        swap.refundTo(id, carol);
        assertEq(carol.balance, 1 ether);
        vm.prank(address(stuck));
        vm.expectRevert(NexusSwap.NotOpen.selector);
        swap.refundTo(id, carol);
    }

    function testReenteringTokenCannotCountADepositTwice() public {
        HookToken hook = new HookToken(swap);
        hook.mint(alice, 100e6);
        vm.prank(alice);
        hook.approve(address(swap), type(uint256).max);
        hook.arm();
        bytes32 id = lockAs(MockToken(address(hook)), 100e6);
        assertTrue(hook.innerFailed());
        (,,,,, uint256 amount,) = swap.locks(id);
        assertEq(amount, 100e6);
        assertEq(hook.balanceOf(address(swap)), 100e6);
    }
}
