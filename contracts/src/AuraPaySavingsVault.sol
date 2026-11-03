// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @title AuraPay Savings Vault
/// @notice Time-locked savings. Anyone can lock tokens for themselves until a timestamp they choose.
///         Before that time nobody can move them, not even the owner. After it, the lock can be
///         released by anyone, and it is always paid to its owner, so a scheduler can release it on
///         time without ever being able to take it. No admin, no fees, no upgrades.
contract AuraPaySavingsVault {
    struct Lock {
        address owner;
        address token;
        uint128 amount;
        uint64 unlockAt;
        bool released;
    }

    /// @notice Longest allowed lock (10 years), to catch obviously wrong timestamps.
    uint256 public constant MAX_LOCK_DURATION = 3650 days;

    Lock[] private _locks;
    uint256 private _status = 1;

    event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockAt);
    event Released(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, address caller);

    error ZeroAmount();
    error InvalidUnlockTime();
    error UnknownLock();
    error StillLocked(uint64 unlockAt);
    error AlreadyReleased();
    error TokenTransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_status != 1) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }

    /// @notice Locks `amount` of `token` from the caller until `unlockAt` (unix seconds).
    /// @dev The caller must have approved this contract for `amount`. The amount actually received
    ///      is what gets locked, so fee-on-transfer tokens can't over-credit a lock.
    function lock(address token, uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (unlockAt <= block.timestamp || unlockAt > block.timestamp + MAX_LOCK_DURATION) revert InvalidUnlockTime();
        if (token.code.length == 0) revert TokenTransferFailed();
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0 || received > type(uint128).max) revert ZeroAmount();
        id = _locks.length;
        _locks.push(Lock({owner: msg.sender, token: token, amount: uint128(received), unlockAt: unlockAt, released: false}));
        emit Locked(id, msg.sender, token, received, unlockAt);
    }

    /// @notice Pays a matured lock to its owner. Callable by anyone once `unlockAt` has passed.
    function release(uint256 id) external nonReentrant {
        if (id >= _locks.length) revert UnknownLock();
        Lock storage l = _locks[id];
        if (l.released) revert AlreadyReleased();
        if (block.timestamp < l.unlockAt) revert StillLocked(l.unlockAt);
        l.released = true;
        _call(l.token, abi.encodeWithSelector(0xa9059cbb, l.owner, uint256(l.amount))); // transfer
        emit Released(id, l.owner, l.token, l.amount, msg.sender);
    }

    function getLock(uint256 id) external view returns (Lock memory) {
        if (id >= _locks.length) revert UnknownLock();
        return _locks[id];
    }

    function lockCount() external view returns (uint256) {
        return _locks.length;
    }

    /// @dev ERC-20 call that accepts tokens returning nothing (like USDT on Ethereum) or `true`.
    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenTransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }
}
