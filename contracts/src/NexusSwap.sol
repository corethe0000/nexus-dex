// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Sk256} from "./Sk256.sol";

/// @title Hash time locked swaps of ERC-20 tokens or the native coin against Nexus
/// @notice The other leg is a DEBIT on Nexus locked to the same SK256 hash. Claim before the deadline with the
/// secret, refund after it. token = address(0) locks the chain's own coin (ETH, BNB, POL) sent with the call.
/// Holds no owner, no fees, no upgrade path.
contract NexusSwap {
    enum State {
        None,
        Open,
        Claimed,
        Refunded
    }

    struct Lock {
        address sender;
        address recipient;
        address token;
        uint64 deadline;
        State state;
        uint256 amount;
        bytes32 hashlock;
    }

    mapping(bytes32 => Lock) public locks;

    //set while lock, claim or refund runs: a token hook or a receiving contract cannot call back in (a re-entered
    //lock would see the outer deposit arrive and count it twice)
    bool private transient entered;

    event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef);
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    error AlreadyExists();
    error NotOpen();
    error Expired();
    error NotExpired();
    error WrongSecret();
    error BadParams();
    error TransferFailed();
    error WrongValue();
    error Reentered();
    error NotRecipient();
    error NotSender();

    modifier once() {
        if (entered) {
            revert Reentered();
        }
        entered = true;
        _;
        entered = false;
    }

    /// @notice the token address that stands for the chain's native coin
    address public constant NATIVE = address(0);

    /// @notice the longest a lock may run: a deadline further out is a mistake that would keep funds away for years
    uint64 public constant MAX_LOCK = 30 days;

    function lockId(address sender, address recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef) public pure returns (bytes32) {
        return keccak256(abi.encode(sender, recipient, token, amount, hashlock, deadline, nexusRef));
    }

    /// @param nexusRef swap reference shared with the Nexus leg (offer id), only for matching
    /// @dev for the native coin send exactly amount as value; for a token send no value
    function lock(address recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef) external payable once returns (bytes32 id) {
        if (recipient == address(0) || amount == 0 || deadline <= block.timestamp || deadline > block.timestamp + MAX_LOCK) {
            revert BadParams();
        }
        id = lockId(msg.sender, recipient, token, amount, hashlock, deadline, nexusRef);
        if (locks[id].state != State.None) {
            revert AlreadyExists();
        }
        uint256 received;
        if (token == NATIVE) {
            if (msg.value != amount) {
                revert WrongValue();
            }
            received = amount;
        } else {
            if (msg.value != 0) {
                revert WrongValue();
            }
            //a token that takes a fee on transfer is refused: the lock would hold less than both sides agreed on
            uint256 before = balanceOf(token);
            safeCall(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount));
            received = balanceOf(token) - before;
            if (received != amount) {
                revert TransferFailed();
            }
        }
        locks[id] = Lock(msg.sender, recipient, token, deadline, State.Open, received, hashlock);
        emit Locked(id, msg.sender, recipient, token, received, hashlock, deadline, nexusRef);
    }

    /// @notice anyone may claim (a watcher can do it for the recipient), the tokens always go to the recipient
    function claim(bytes32 id, bytes32 secret) external once {
        Lock storage l = opened(id, secret);
        pay(l.token, l.recipient, l.amount);
    }

    /// @notice the recipient itself may have the tokens paid to another address: a token that froze the recipient
    /// (USDT, USDC) would make claim fail, and the sender would get the lock back after the secret is out
    function claimTo(bytes32 id, bytes32 secret, address to) external once {
        Lock storage l = locks[id];
        if (msg.sender != l.recipient) {
            revert NotRecipient();
        }
        if (to == address(0)) {
            revert BadParams();
        }
        opened(id, secret);
        pay(l.token, to, l.amount);
    }

    //checks a claim and marks the lock claimed (the transfer follows)
    function opened(bytes32 id, bytes32 secret) private returns (Lock storage l) {
        l = locks[id];
        if (l.state != State.Open) {
            revert NotOpen();
        }
        if (block.timestamp >= l.deadline) {
            revert Expired();
        }
        if (Sk256.hash(secret) != l.hashlock) {
            revert WrongSecret();
        }
        l.state = State.Claimed;
        emit Claimed(id, secret);
    }

    /// @notice anyone may refund after the deadline, the tokens always go back to the sender
    function refund(bytes32 id) external once {
        Lock storage l = locks[id];
        if (l.state != State.Open) {
            revert NotOpen();
        }
        if (block.timestamp < l.deadline) {
            revert NotExpired();
        }
        l.state = State.Refunded;
        emit Refunded(id);
        pay(l.token, l.sender, l.amount);
    }

    /// @notice the sender itself may have the refund paid to another address, when its own cannot receive it
    function refundTo(bytes32 id, address to) external once {
        Lock storage l = locks[id];
        if (msg.sender != l.sender) {
            revert NotSender();
        }
        if (to == address(0)) {
            revert BadParams();
        }
        if (l.state != State.Open) {
            revert NotOpen();
        }
        if (block.timestamp < l.deadline) {
            revert NotExpired();
        }
        l.state = State.Refunded;
        emit Refunded(id);
        pay(l.token, to, l.amount);
    }

    //state is already final when this runs (checks, effects, then the transfer); calls back in are refused by once
    function pay(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) {
                revert TransferFailed();
            }
        } else {
            safeCall(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
    }

    function balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) {
            revert TransferFailed();
        }
        return abi.decode(data, (uint256));
    }

    //works with tokens that return nothing (USDT on Ethereum) and with ones that return a bool
    function safeCall(address token, bytes memory data) private {
        if (token.code.length == 0) {
            revert TransferFailed();
        }
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }
}
