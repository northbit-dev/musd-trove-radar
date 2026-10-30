// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface IBorrowerOperationsSignatures {
    function addCollWithSignature(
        address upperHint,
        address lowerHint,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) external;

    function getNonce(address user) external view returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITroveManager {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint8);
}

interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/// @title TroveGuard
/// @notice Automatic protection for MUSD troves on Mezo. A borrower parks a BTC and/or MUSD reserve
/// here, sets a trigger ICR and stores a ladder of pre-signed BorrowerOperationsSignatures permits,
/// one per future nonce. Each rung either adds BTC collateral (`addCollWithSignature`) or repays
/// MUSD debt (`repayMUSDWithSignature`). Anyone may call `protect`; when the trove's ICR is below
/// the trigger the guard spends one permit from the matching reserve and pays the caller a fixed
/// BTC tip. Funds only ever move into the borrower's own trove, to the caller as the tip, or back
/// to the borrower.
contract TroveGuard {
    enum Kind {
        AddColl,
        RepayMUSD
    }

    struct Permit {
        Kind kind;
        uint128 amount;
        uint64 deadline;
        bytes signature;
    }

    struct Config {
        uint128 triggerICR;
        uint128 keeperTip;
        uint64 generation;
        bool active;
    }

    uint8 private constant TROVE_ACTIVE = 1;
    uint256 private constant MIN_TRIGGER = 1.1e18;
    uint256 private constant MAX_TRIGGER = 10e18;

    IBorrowerOperationsSignatures public immutable borrowerOperationsSignatures;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    IERC20 public immutable musd;

    mapping(address => Config) public configs;
    mapping(address => uint256) public reserves;
    mapping(address => uint256) public musdReserves;
    mapping(address => mapping(uint64 => mapping(uint256 => Permit))) private _permits;
    address[] private _guarded;
    mapping(address => bool) private _known;
    uint256 private _lock = 1;

    event Configured(address indexed borrower, uint256 triggerICR, uint256 keeperTip);
    event Deposited(address indexed borrower, uint256 amount);
    event Withdrawn(address indexed borrower, uint256 amount);
    event MUSDDeposited(address indexed borrower, uint256 amount);
    event MUSDWithdrawn(address indexed borrower, uint256 amount);
    event PermitStored(address indexed borrower, uint256 indexed nonce, Kind kind, uint256 amount, uint256 deadline);
    event Cancelled(address indexed borrower, uint256 refunded, uint256 musdRefunded);
    event Protected(
        address indexed borrower,
        address indexed keeper,
        uint256 nonce,
        Kind kind,
        uint256 amount,
        uint256 tip,
        uint256 icrBefore,
        uint256 icrAfter
    );

    error InvalidTrigger();
    error NotActive();
    error TroveNotActive();
    error HealthyTrove(uint256 icr, uint256 trigger);
    error NoPermit(uint256 nonce);
    error PermitExpired(uint256 nonce);
    error StaleNonce(uint256 nonce, uint256 current);
    error InsufficientReserve(uint256 needed, uint256 available);
    error InsufficientMUSDReserve(uint256 needed, uint256 available);
    error ICRNotImproved();
    error ZeroAmount();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IBorrowerOperationsSignatures bos, ITroveManager tm, IPriceFeed feed, IERC20 musdToken) {
        borrowerOperationsSignatures = bos;
        troveManager = tm;
        priceFeed = feed;
        musd = musdToken;
    }

    /// @notice Turn the guard on (or update it) for the caller's trove. Any BTC sent is added to the reserve.
    /// @param triggerICR Protect when ICR drops below this (1e18 = 100 %). Must be within 110 %..1000 %.
    /// @param keeperTip BTC paid from the reserve to whoever triggers a top-up.
    function configure(uint128 triggerICR, uint128 keeperTip) external payable {
        if (triggerICR < MIN_TRIGGER || triggerICR > MAX_TRIGGER) revert InvalidTrigger();
        Config storage c = configs[msg.sender];
        c.triggerICR = triggerICR;
        c.keeperTip = keeperTip;
        c.active = true;
        if (!_known[msg.sender]) {
            _known[msg.sender] = true;
            _guarded.push(msg.sender);
        }
        emit Configured(msg.sender, triggerICR, keeperTip);
        if (msg.value > 0) _deposit(msg.sender, msg.value);
    }

    /// @notice Add BTC to the caller's reserve.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        _deposit(msg.sender, msg.value);
    }

    /// @notice Add MUSD to the caller's reserve. Approve this contract for `amount` first.
    function depositMUSD(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        musdReserves[msg.sender] += amount;
        emit MUSDDeposited(msg.sender, amount);
        if (!musd.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// @notice Store pre-signed permits for consecutive nonces starting at `firstNonce`.
    /// @dev Each signature must be the caller's EIP-712 `AddColl(assetAmount, borrower, nonce, deadline)`
    /// or `RepayMUSD(amount, borrower, nonce, deadline)` for BorrowerOperationsSignatures, matching the
    /// permit's kind. Both kinds share the borrower's single nonce, so one ladder may mix them.
    /// A bad signature only makes that rung revert inside MUSD.
    function storePermits(uint256 firstNonce, Permit[] calldata permits) external {
        uint256 current = borrowerOperationsSignatures.getNonce(msg.sender);
        if (firstNonce < current) revert StaleNonce(firstNonce, current);
        uint64 gen = configs[msg.sender].generation;
        for (uint256 i; i < permits.length; ++i) {
            Permit calldata p = permits[i];
            if (p.amount == 0) revert ZeroAmount();
            _permits[msg.sender][gen][firstNonce + i] = p;
            emit PermitStored(msg.sender, firstNonce + i, p.kind, p.amount, p.deadline);
        }
    }

    /// @notice Withdraw BTC from the caller's reserve.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 available = reserves[msg.sender];
        if (amount > available) revert InsufficientReserve(amount, available);
        reserves[msg.sender] = available - amount;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice Withdraw MUSD from the caller's reserve.
    function withdrawMUSD(uint256 amount) external nonReentrant {
        uint256 available = musdReserves[msg.sender];
        if (amount > available) revert InsufficientMUSDReserve(amount, available);
        musdReserves[msg.sender] = available - amount;
        emit MUSDWithdrawn(msg.sender, amount);
        if (!musd.transfer(msg.sender, amount)) revert TransferFailed();
    }

    /// @notice Disable the guard, invalidate every stored permit and refund both reserves.
    function cancel() external nonReentrant {
        Config storage c = configs[msg.sender];
        c.active = false;
        unchecked {
            ++c.generation;
        }
        uint256 refund = reserves[msg.sender];
        uint256 musdRefund = musdReserves[msg.sender];
        reserves[msg.sender] = 0;
        musdReserves[msg.sender] = 0;
        emit Cancelled(msg.sender, refund, musdRefund);
        if (musdRefund > 0 && !musd.transfer(msg.sender, musdRefund)) revert TransferFailed();
        if (refund > 0) _send(msg.sender, refund);
    }

    /// @notice Protect `borrower`'s trove with its next permit if its ICR is below the trigger. Callable by anyone.
    /// @dev Hints are passed straight to SortedTroves, which validates them and falls back to a search.
    function protect(address borrower, address upperHint, address lowerHint) external nonReentrant {
        Config memory c = configs[borrower];
        if (!c.active) revert NotActive();
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) revert TroveNotActive();

        uint256 price = priceFeed.fetchPrice();
        uint256 icrBefore = troveManager.getCurrentICR(borrower, price);
        if (icrBefore >= c.triggerICR) revert HealthyTrove(icrBefore, c.triggerICR);

        uint256 nonce = borrowerOperationsSignatures.getNonce(borrower);
        Permit memory p = _permits[borrower][c.generation][nonce];
        if (p.signature.length == 0) revert NoPermit(nonce);
        if (block.timestamp > p.deadline) revert PermitExpired(nonce);

        bool repay = p.kind == Kind.RepayMUSD;
        uint256 cost = repay ? c.keeperTip : uint256(p.amount) + c.keeperTip;
        uint256 available = reserves[borrower];
        if (cost > available) revert InsufficientReserve(cost, available);
        reserves[borrower] = available - cost;
        if (repay) {
            uint256 musdAvailable = musdReserves[borrower];
            if (p.amount > musdAvailable) revert InsufficientMUSDReserve(p.amount, musdAvailable);
            musdReserves[borrower] = musdAvailable - p.amount;
        }
        delete _permits[borrower][c.generation][nonce];

        // MUSD burns the repaid amount from this contract (the caller of BorrowerOperationsSignatures), so no approval is needed.
        if (repay) {
            borrowerOperationsSignatures.repayMUSDWithSignature(
                p.amount, upperHint, lowerHint, borrower, p.signature, p.deadline
            );
        } else {
            borrowerOperationsSignatures.addCollWithSignature{value: p.amount}(
                upperHint, lowerHint, borrower, p.signature, p.deadline
            );
        }

        uint256 icrAfter = troveManager.getCurrentICR(borrower, price);
        if (icrAfter <= icrBefore) revert ICRNotImproved();

        emit Protected(borrower, msg.sender, nonce, p.kind, p.amount, c.keeperTip, icrBefore, icrAfter);
        if (c.keeperTip > 0) _send(msg.sender, c.keeperTip);
    }

    /// @notice Keeper view: whether `protect(borrower, ...)` would pass its own checks right now.
    function status(address borrower)
        external
        view
        returns (
            bool protectable,
            uint256 icr,
            uint256 trigger,
            uint256 nonce,
            Kind kind,
            uint256 amount,
            uint256 reserve,
            uint256 musdReserve
        )
    {
        Config memory c = configs[borrower];
        trigger = c.triggerICR;
        reserve = reserves[borrower];
        musdReserve = musdReserves[borrower];
        nonce = borrowerOperationsSignatures.getNonce(borrower);
        Permit storage p = _permits[borrower][c.generation][nonce];
        kind = p.kind;
        amount = p.amount;
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) {
            return (false, 0, trigger, nonce, kind, amount, reserve, musdReserve);
        }
        icr = troveManager.getCurrentICR(borrower, priceFeed.fetchPrice());
        bool funded = kind == Kind.RepayMUSD
            ? reserve >= c.keeperTip && musdReserve >= amount
            : reserve >= amount + c.keeperTip;
        protectable = c.active && icr < trigger && p.signature.length > 0 && block.timestamp <= p.deadline && funded;
    }

    /// @notice The stored permit for `borrower` at `nonce` in the current generation.
    function permitOf(address borrower, uint256 nonce) external view returns (Permit memory) {
        return _permits[borrower][configs[borrower].generation][nonce];
    }

    /// @notice Number of borrowers that have ever configured a guard.
    function guardedCount() external view returns (uint256) {
        return _guarded.length;
    }

    /// @notice Paginated list of borrowers that have ever configured a guard.
    function guardedSlice(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 end = start + count;
        if (end > _guarded.length) end = _guarded.length;
        if (start >= end) return out;
        out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = _guarded[i];
        }
    }

    function _deposit(address borrower, uint256 amount) private {
        reserves[borrower] += amount;
        emit Deposited(borrower, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
