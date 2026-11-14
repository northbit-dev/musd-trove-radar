// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface IBorrowerOperationsSignaturesV3 {
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

    function adjustTroveWithSignature(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    function getNonce(address user) external view returns (uint256);
    function borrowerOperations() external view returns (address);
}

interface IBorrowerOperationsV3 {
    function minNetDebt() external view returns (uint256);
}

interface IERC20V3 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITroveManagerV3 {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint8);
    function getTroveDebt(address borrower) external view returns (uint256);
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        );
    function MCR() external view returns (uint256);
}

interface ISortedTrovesV3 {
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
}

interface IPriceFeedV3 {
    function fetchPrice() external view returns (uint256);
}

/// @title TroveGuard v3
/// @notice Same model as v2 (BTC + MUSD reserve, ladder of BorrowerOperationsSignatures permits keyed by
/// nonce, permissionless `protect`), plus:
///  * `Adjust` rungs: one `adjustTroveWithSignature` permit that adds BTC and repays MUSD in a single step;
///  * a target ICR: one `protect` call keeps spending rungs (up to `maxRungs`) until the trove is back at
///    the target, so small rungs give a partial, just-enough repayment instead of one big fixed one;
///  * a redemption trigger: `protect` is also allowed when less than `redemptionBuffer` MUSD of
///    redeemable debt sits ahead of the trove in the redemption order (walked on-chain, bounded).
contract TroveGuardV3 {
    enum Kind {
        AddColl,
        RepayMUSD,
        Adjust
    }

    enum Reason {
        None,
        LowICR,
        RedemptionFront
    }

    struct Permit {
        Kind kind;
        uint64 deadline;
        uint128 btc;
        uint128 musd;
        bytes signature;
    }

    struct Config {
        uint128 triggerICR;
        uint128 keeperTip;
        uint128 targetICR;
        uint128 redemptionBuffer;
        uint64 generation;
        uint8 maxRungs;
        bool active;
    }

    struct Status {
        bool protectable;
        Reason reason;
        uint256 icr;
        uint256 musdAhead;
        uint256 nonce;
        Permit next;
        uint256 reserve;
        uint256 musdReserve;
    }

    uint8 private constant TROVE_ACTIVE = 1;
    uint256 private constant MIN_TRIGGER = 1.1e18;
    uint256 private constant MAX_TRIGGER = 10e18;
    uint8 public constant MAX_RUNGS = 5;
    /// @notice Most troves `protect` walks from the back of SortedTroves for the redemption trigger.
    uint256 public constant MAX_WALK = 40;
    uint256 public constant MUSD_GAS_COMPENSATION = 200e18;

    IBorrowerOperationsSignaturesV3 public immutable borrowerOperationsSignatures;
    IBorrowerOperationsV3 public immutable borrowerOperations;
    ITroveManagerV3 public immutable troveManager;
    ISortedTrovesV3 public immutable sortedTroves;
    IPriceFeedV3 public immutable priceFeed;
    IERC20V3 public immutable musd;
    uint256 public immutable mcr;

    mapping(address => Config) public configs;
    mapping(address => uint256) public reserves;
    mapping(address => uint256) public musdReserves;
    mapping(address => mapping(uint64 => mapping(uint256 => Permit))) private _permits;
    address[] private _guarded;
    mapping(address => bool) private _known;
    uint256 private _lock = 1;

    event Configured(
        address indexed borrower, uint256 triggerICR, uint256 keeperTip, uint256 targetICR, uint256 redemptionBuffer, uint8 maxRungs
    );
    event Deposited(address indexed borrower, uint256 amount);
    event Withdrawn(address indexed borrower, uint256 amount);
    event MUSDDeposited(address indexed borrower, uint256 amount);
    event MUSDWithdrawn(address indexed borrower, uint256 amount);
    event PermitStored(address indexed borrower, uint256 indexed nonce, Kind kind, uint256 btc, uint256 musd, uint256 deadline);
    event Cancelled(address indexed borrower, uint256 refunded, uint256 musdRefunded);
    event Protected(
        address indexed borrower,
        address indexed keeper,
        uint256 nonce,
        Kind kind,
        Reason reason,
        uint256 btc,
        uint256 musd,
        uint256 icrBefore,
        uint256 icrAfter
    );
    event KeeperPaid(address indexed borrower, address indexed keeper, uint256 rungs, uint256 tip);

    error InvalidConfig();
    error InvalidPermit(uint256 nonce);
    error NotActive();
    error TroveNotActive();
    error HealthyTrove(uint256 icr, uint256 trigger, uint256 musdAhead);
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

    constructor(
        IBorrowerOperationsSignaturesV3 bos,
        ITroveManagerV3 tm,
        ISortedTrovesV3 st,
        IPriceFeedV3 feed,
        IERC20V3 musdToken
    ) {
        borrowerOperationsSignatures = bos;
        borrowerOperations = IBorrowerOperationsV3(bos.borrowerOperations());
        troveManager = tm;
        sortedTroves = st;
        priceFeed = feed;
        musd = musdToken;
        mcr = tm.MCR();
    }


    /// @param triggerICR Protect when ICR drops below this (1e18 = 100 %), 110 %..1000 %.
    /// @param keeperTip BTC paid from the reserve per rung spent.
    /// @param targetICR 0 = one rung per call (v2 behaviour); otherwise keep spending rungs until ICR >= target.
    /// @param redemptionBuffer 0 = off; otherwise also protect when less than this much redeemable MUSD is ahead.
    /// @param maxRungs Rungs one `protect` may spend, 1..MAX_RUNGS.
    function configure(uint128 triggerICR, uint128 keeperTip, uint128 targetICR, uint128 redemptionBuffer, uint8 maxRungs)
        external
        payable
    {
        if (triggerICR < MIN_TRIGGER || triggerICR > MAX_TRIGGER) revert InvalidConfig();
        if (targetICR != 0 && (targetICR < triggerICR || targetICR > MAX_TRIGGER)) revert InvalidConfig();
        if (maxRungs == 0 || maxRungs > MAX_RUNGS) revert InvalidConfig();
        Config storage c = configs[msg.sender];
        c.triggerICR = triggerICR;
        c.keeperTip = keeperTip;
        c.targetICR = targetICR;
        c.redemptionBuffer = redemptionBuffer;
        c.maxRungs = maxRungs;
        c.active = true;
        if (!_known[msg.sender]) {
            _known[msg.sender] = true;
            _guarded.push(msg.sender);
        }
        emit Configured(msg.sender, triggerICR, keeperTip, targetICR, redemptionBuffer, maxRungs);
        if (msg.value > 0) _deposit(msg.sender, msg.value);
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        _deposit(msg.sender, msg.value);
    }

    function depositMUSD(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        musdReserves[msg.sender] += amount;
        emit MUSDDeposited(msg.sender, amount);
        if (!musd.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// @notice Store permits for consecutive nonces from `firstNonce`. AddColl: btc > 0, musd = 0.
    /// RepayMUSD: musd > 0, btc = 0. Adjust: both > 0, signed as
    /// `AdjustTrove(collWithdrawal=0, debtChange=musd, isDebtIncrease=false, assetAmount=btc, borrower, recipient=borrower, nonce, deadline)`.
    function storePermits(uint256 firstNonce, Permit[] calldata permits) external {
        uint256 current = borrowerOperationsSignatures.getNonce(msg.sender);
        if (firstNonce < current) revert StaleNonce(firstNonce, current);
        uint64 gen = configs[msg.sender].generation;
        for (uint256 i; i < permits.length; ++i) {
            Permit calldata p = permits[i];
            bool ok = p.kind == Kind.AddColl
                ? p.btc > 0 && p.musd == 0
                : p.kind == Kind.RepayMUSD ? p.musd > 0 && p.btc == 0 : p.btc > 0 && p.musd > 0;
            if (!ok || p.signature.length == 0) revert InvalidPermit(firstNonce + i);
            _permits[msg.sender][gen][firstNonce + i] = p;
            emit PermitStored(msg.sender, firstNonce + i, p.kind, p.btc, p.musd, p.deadline);
        }
    }

    function withdraw(uint256 amount) external nonReentrant {
        uint256 available = reserves[msg.sender];
        if (amount > available) revert InsufficientReserve(amount, available);
        reserves[msg.sender] = available - amount;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    function withdrawMUSD(uint256 amount) external nonReentrant {
        uint256 available = musdReserves[msg.sender];
        if (amount > available) revert InsufficientMUSDReserve(amount, available);
        musdReserves[msg.sender] = available - amount;
        emit MUSDWithdrawn(msg.sender, amount);
        if (!musd.transfer(msg.sender, amount)) revert TransferFailed();
    }

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


    /// @notice Spend rungs for `borrower` while it needs protection. Callable by anyone.
    /// @return rungs Rungs spent (>= 1; reverts otherwise).
    function protect(address borrower, address upperHint, address lowerHint)
        external
        nonReentrant
        returns (uint256 rungs)
    {
        Config memory c = configs[borrower];
        if (!c.active) revert NotActive();
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) revert TroveNotActive();

        uint256 price = priceFeed.fetchPrice();
        (Reason reason, uint256 icr, uint256 ahead) = _check(borrower, c, price);
        if (reason == Reason.None) revert HealthyTrove(icr, c.triggerICR, ahead);

        // The first rung must exist and be funded; later rungs stop the loop quietly when missing.
        icr = _spend(borrower, c, price, icr, reason, upperHint, lowerHint);
        rungs = 1;
        while (rungs < c.maxRungs && c.targetICR != 0 && icr < c.targetICR && _ready(borrower, c)) {
            icr = _spend(borrower, c, price, icr, reason, upperHint, lowerHint);
            ++rungs;
        }

        uint256 tip = uint256(c.keeperTip) * rungs;
        emit KeeperPaid(borrower, msg.sender, rungs, tip);
        if (tip > 0) _send(msg.sender, tip);
    }

    /// @notice Keeper view: what `protect` would do right now.
    function status(address borrower) external view returns (Status memory s) {
        Config memory c = configs[borrower];
        s.reserve = reserves[borrower];
        s.musdReserve = musdReserves[borrower];
        s.nonce = borrowerOperationsSignatures.getNonce(borrower);
        s.next = _permits[borrower][c.generation][s.nonce];
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) return s;
        (s.reason, s.icr, s.musdAhead) = _check(borrower, c, priceFeed.fetchPrice());
        s.protectable = c.active && s.reason != Reason.None && _ready(borrower, c);
    }

    /// @notice Redeemable MUSD ahead of `borrower` in the redemption order, walking at most MAX_WALK troves.
    /// @return found Whether `borrower` was reached within the walk (or `limit`).
    function redemptionAhead(address borrower, uint256 limit) public view returns (bool found, uint256 ahead) {
        return _ahead(borrower, limit == 0 ? type(uint256).max : limit, priceFeed.fetchPrice());
    }

    function permitOf(address borrower, uint256 nonce) external view returns (Permit memory) {
        return _permits[borrower][configs[borrower].generation][nonce];
    }

    function guardedCount() external view returns (uint256) {
        return _guarded.length;
    }

    function guardedSlice(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 end = start + count;
        if (end > _guarded.length) end = _guarded.length;
        if (start >= end) return out;
        out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = _guarded[i];
        }
    }


    function _check(address borrower, Config memory c, uint256 price)
        private
        view
        returns (Reason reason, uint256 icr, uint256 ahead)
    {
        icr = troveManager.getCurrentICR(borrower, price);
        if (icr < c.triggerICR) return (Reason.LowICR, icr, 0);
        if (c.redemptionBuffer != 0) {
            bool found;
            (found, ahead) = _ahead(borrower, c.redemptionBuffer, price);
            if (found) return (Reason.RedemptionFront, icr, ahead);
        }
    }

    /// Mirrors TroveManager.redeemCollateral: start at the lowest NICR (SortedTroves.getLast), skip troves
    /// below MCR, count each trove's debt minus the gas compensation. Stops early once `limit` is reached.
    function _ahead(address borrower, uint256 limit, uint256 price) private view returns (bool, uint256 ahead) {
        address node = sortedTroves.getLast();
        for (uint256 i; i < MAX_WALK && node != address(0); ++i) {
            if (node == borrower) return (true, ahead);
            if (troveManager.getCurrentICR(node, price) >= mcr) {
                (, uint256 p, uint256 it,, uint256 pp, uint256 pi) = troveManager.getEntireDebtAndColl(node);
                uint256 debt = p + it + pp + pi;
                if (debt > MUSD_GAS_COMPENSATION) ahead += debt - MUSD_GAS_COMPENSATION;
                if (ahead >= limit) return (false, ahead);
            }
            node = sortedTroves.getPrev(node);
        }
        return (false, ahead);
    }

    function _ready(address borrower, Config memory c) private view returns (bool) {
        Permit storage p = _permits[borrower][c.generation][borrowerOperationsSignatures.getNonce(borrower)];
        return p.signature.length > 0 && block.timestamp <= p.deadline
            && reserves[borrower] >= uint256(p.btc) + c.keeperTip && musdReserves[borrower] >= p.musd
            && _repayFits(borrower, p.musd);
    }

    // BorrowerOperations reverts a repayment that leaves net debt under minNetDebt, which would sink the whole ladder.
    function _repayFits(address borrower, uint256 amount) private view returns (bool) {
        return amount == 0
            || troveManager.getTroveDebt(borrower) >= amount + MUSD_GAS_COMPENSATION + borrowerOperations.minNetDebt();
    }

    function _spend(
        address borrower,
        Config memory c,
        uint256 price,
        uint256 icrBefore,
        Reason reason,
        address upperHint,
        address lowerHint
    ) private returns (uint256 icrAfter) {
        uint256 nonce = borrowerOperationsSignatures.getNonce(borrower);
        Permit memory p = _take(borrower, c, nonce);
        _execute(p, borrower, upperHint, lowerHint);
        icrAfter = troveManager.getCurrentICR(borrower, price);
        if (icrAfter <= icrBefore) revert ICRNotImproved();
        emit Protected(borrower, msg.sender, nonce, p.kind, reason, p.btc, p.musd, icrBefore, icrAfter);
    }

    /// Checks the rung at `nonce`, debits both reserves (BTC: amount + tip) and deletes the permit.
    function _take(address borrower, Config memory c, uint256 nonce) private returns (Permit memory p) {
        p = _permits[borrower][c.generation][nonce];
        if (p.signature.length == 0) revert NoPermit(nonce);
        if (block.timestamp > p.deadline) revert PermitExpired(nonce);
        uint256 cost = uint256(p.btc) + c.keeperTip;
        uint256 available = reserves[borrower];
        if (cost > available) revert InsufficientReserve(cost, available);
        reserves[borrower] = available - cost;
        available = musdReserves[borrower];
        if (p.musd > available) revert InsufficientMUSDReserve(p.musd, available);
        musdReserves[borrower] = available - p.musd;
        delete _permits[borrower][c.generation][nonce];
    }

    // MUSD burns repaid debt from the caller of BorrowerOperationsSignatures (this contract), so no approval.
    function _execute(Permit memory p, address borrower, address upperHint, address lowerHint) private {
        if (p.kind == Kind.AddColl) {
            borrowerOperationsSignatures.addCollWithSignature{value: p.btc}(
                upperHint, lowerHint, borrower, p.signature, p.deadline
            );
        } else if (p.kind == Kind.RepayMUSD) {
            borrowerOperationsSignatures.repayMUSDWithSignature(
                p.musd, upperHint, lowerHint, borrower, p.signature, p.deadline
            );
        } else {
            borrowerOperationsSignatures.adjustTroveWithSignature{value: p.btc}(
                0, p.musd, false, upperHint, lowerHint, borrower, borrower, p.signature, p.deadline
            );
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
