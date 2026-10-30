// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFork, ITroveDebt} from "./MezoFork.sol";
import {TroveGuard, IERC20} from "../TroveGuard.sol";

contract ReentrantKeeper {
    TroveGuard immutable guard;
    address immutable target;

    constructor(TroveGuard g, address t) {
        guard = g;
        target = t;
    }

    function poke() external {
        guard.protect(target, address(0), address(0));
    }

    receive() external payable {
        guard.protect(target, address(0), address(0));
    }
}

/// Runs against an anvil fork of Mezo Testnet (chainId 31611); see README "TroveGuard".
contract TroveGuardForkTest is MezoFork {
    uint128 constant TRIGGER = 1.25e18;
    uint128 constant TOP_UP = 0.01 ether;
    uint128 constant TIP = 0.0001 ether;
    uint128 constant REPAY = 100e18;

    TroveGuard guard;
    address borrower;
    uint256 borrowerKey;
    address keeper = makeAddr("keeper");
    uint64 deadline;

    receive() external payable {}

    function setUp() public {
        vm.skip(!_onMezoFork());
        guard = new TroveGuard(BOS, TM, FEED, IERC20(address(MUSD)));
        (borrower, borrowerKey) = makeAddrAndKey("borrower");
        _setPrice(realPrice);
        deadline = uint64(block.timestamp + 365 days);

        vm.deal(borrower, 1 ether);
        vm.prank(borrower);
        BO.openTrove{value: 0.05 ether}(2000e18, address(0), address(0));
        assertGt(TM.getCurrentICR(borrower, realPrice), 1.4e18);

        vm.prank(borrower);
        guard.configure{value: 0.05 ether}(TRIGGER, TIP);
    }

    function _dropICRTo(uint256 targetICR) internal {
        uint256 icr = TM.getCurrentICR(borrower, realPrice);
        _setPrice(realPrice * targetICR / icr);
    }

    function _sign(uint256 key, address who, uint256 amount, uint256 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        return _signKind(TroveGuard.Kind.AddColl, key, who, amount, nonce, dl);
    }

    function _ladder(uint256 rungs) internal {
        uint256 first = BOS.getNonce(borrower);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](rungs);
        for (uint256 i; i < rungs; ++i) {
            ps[i] = TroveGuard.Permit(
                TroveGuard.Kind.AddColl, TOP_UP, deadline, _sign(borrowerKey, borrower, TOP_UP, first + i, deadline)
            );
        }
        vm.prank(borrower);
        guard.storePermits(first, ps);
    }

    function _mixedLadder(TroveGuard.Kind[] memory kinds) internal {
        uint256 first = BOS.getNonce(borrower);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](kinds.length);
        for (uint256 i; i < kinds.length; ++i) {
            uint128 amount = kinds[i] == TroveGuard.Kind.AddColl ? TOP_UP : REPAY;
            ps[i] = TroveGuard.Permit(
                kinds[i], amount, deadline, _signKind(kinds[i], borrowerKey, borrower, amount, first + i, deadline)
            );
        }
        vm.prank(borrower);
        guard.storePermits(first, ps);
    }

    function _depositMUSD(uint256 amount) internal {
        vm.startPrank(borrower);
        MUSD.approve(address(guard), amount);
        guard.depositMUSD(amount);
        vm.stopPrank();
    }

    function _kinds(TroveGuard.Kind a) internal pure returns (TroveGuard.Kind[] memory k) {
        k = new TroveGuard.Kind[](1);
        k[0] = a;
    }

    function test_protectTopsUpBelowTrigger() public {
        _ladder(1);
        _dropICRTo(1.2e18);
        uint256 price = FEED.fetchPrice();
        uint256 icrBefore = TM.getCurrentICR(borrower, price);
        uint256 nonceBefore = BOS.getNonce(borrower);
        (bool ok,,,,,,,) = guard.status(borrower);
        assertTrue(ok);

        vm.prank(keeper);
        guard.protect(borrower, address(0), address(0));

        assertGt(TM.getCurrentICR(borrower, price), icrBefore);
        assertEq(BOS.getNonce(borrower), nonceBefore + 1);
        assertEq(guard.reserves(borrower), 0.05 ether - TOP_UP - TIP);
        assertEq(keeper.balance, TIP);
    }

    function test_triggerBoundaryIsStrict() public {
        _ladder(1);
        vm.expectPartialRevert(TroveGuard.HealthyTrove.selector);
        guard.protect(borrower, address(0), address(0));

        _dropICRTo(1.2e18);
        uint128 icr = uint128(TM.getCurrentICR(borrower, FEED.fetchPrice()));
        vm.prank(borrower);
        guard.configure(icr, TIP);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.HealthyTrove.selector, icr, icr));
        guard.protect(borrower, address(0), address(0));

        vm.prank(borrower);
        guard.configure(icr + 1, TIP);
        guard.protect(borrower, address(0), address(0));
    }

    function test_permitIsSingleUse() public {
        _ladder(1);
        _dropICRTo(1.15e18);
        uint256 nonce = BOS.getNonce(borrower);
        bytes memory sig = guard.permitOf(borrower, nonce).signature;
        guard.protect(borrower, address(0), address(0));

        _dropICRTo(1.15e18);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.NoPermit.selector, nonce + 1));
        guard.protect(borrower, address(0), address(0));

        vm.deal(address(this), TOP_UP);
        vm.expectRevert("BorrowerOperationsSignatures: Invalid signature");
        BOS.addCollWithSignature{value: TOP_UP}(address(0), address(0), borrower, sig, deadline);
    }

    function test_ladderSurvivesExternalNonceUse() public {
        _ladder(3);
        _dropICRTo(1.15e18);
        uint256 n = BOS.getNonce(borrower);

        address stranger = makeAddr("stranger");
        vm.deal(stranger, TOP_UP);
        bytes memory sig = guard.permitOf(borrower, n).signature;
        vm.prank(stranger);
        BOS.addCollWithSignature{value: TOP_UP}(address(0), address(0), borrower, sig, deadline);
        assertEq(BOS.getNonce(borrower), n + 1);

        _dropICRTo(1.15e18);
        guard.protect(borrower, address(0), address(0));
        _dropICRTo(1.15e18);
        guard.protect(borrower, address(0), address(0));
        assertEq(BOS.getNonce(borrower), n + 3);
        assertEq(guard.reserves(borrower), 0.05 ether - 2 * (TOP_UP + TIP));
    }

    function test_storePermitsRejectsStaleNonce() public {
        uint256 n = BOS.getNonce(borrower);
        _ladder(1);
        _dropICRTo(1.15e18);
        guard.protect(borrower, address(0), address(0));

        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](1);
        ps[0] = TroveGuard.Permit(TroveGuard.Kind.AddColl, TOP_UP, deadline, _sign(borrowerKey, borrower, TOP_UP, n, deadline));
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.StaleNonce.selector, n, n + 1));
        guard.storePermits(n, ps);
    }

    function test_foreignSignatureCannotMoveFunds() public {
        (address mallory, uint256 malloryKey) = makeAddrAndKey("mallory");
        uint256 n = BOS.getNonce(borrower);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](1);
        ps[0] = TroveGuard.Permit(TroveGuard.Kind.AddColl, TOP_UP, deadline, _sign(malloryKey, borrower, TOP_UP, n, deadline));

        vm.prank(mallory);
        guard.storePermits(n, ps);
        _dropICRTo(1.15e18);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.NoPermit.selector, n));
        guard.protect(borrower, address(0), address(0));

        vm.prank(borrower);
        guard.storePermits(n, ps);
        vm.expectRevert("BorrowerOperationsSignatures: Invalid signature");
        guard.protect(borrower, address(0), address(0));
        assertEq(guard.reserves(borrower), 0.05 ether);
    }

    function test_onlyOwnerWithdrawsAndCancelInvalidates() public {
        _ladder(2);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.InsufficientReserve.selector, 1, 0));
        guard.withdraw(1);

        vm.prank(borrower);
        guard.withdraw(0.01 ether);
        assertEq(guard.reserves(borrower), 0.04 ether);

        uint256 balBefore = borrower.balance;
        vm.prank(borrower);
        guard.cancel();
        assertEq(borrower.balance, balBefore + 0.04 ether);
        assertEq(guard.permitOf(borrower, BOS.getNonce(borrower)).signature.length, 0);

        _dropICRTo(1.15e18);
        vm.expectRevert(TroveGuard.NotActive.selector);
        guard.protect(borrower, address(0), address(0));

        vm.prank(borrower);
        guard.configure{value: 0.02 ether}(TRIGGER, TIP);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.NoPermit.selector, BOS.getNonce(borrower)));
        guard.protect(borrower, address(0), address(0));
    }

    function test_failureModes() public {
        vm.prank(borrower);
        vm.expectRevert(TroveGuard.InvalidTrigger.selector);
        guard.configure(1.05e18, TIP);

        _ladder(1);
        _dropICRTo(1.15e18);

        vm.startPrank(borrower);
        guard.withdraw(0.045 ether);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.InsufficientReserve.selector, TOP_UP + TIP, 0.005 ether));
        guard.protect(borrower, address(0), address(0));

        vm.prank(borrower);
        guard.deposit{value: 0.045 ether}();
        vm.warp(uint256(deadline) + 1);
        _setPrice(currentPrice);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.PermitExpired.selector, BOS.getNonce(borrower)));
        guard.protect(borrower, address(0), address(0));

        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        guard.configure(TRIGGER, 0);
        vm.expectRevert(TroveGuard.TroveNotActive.selector);
        guard.protect(nobody, address(0), address(0));
    }

    function test_blocksReentrantKeeper() public {
        _ladder(2);
        _dropICRTo(1.15e18);
        ReentrantKeeper evil = new ReentrantKeeper(guard, borrower);
        uint256 nonce = BOS.getNonce(borrower);
        vm.expectRevert(TroveGuard.TransferFailed.selector);
        evil.poke();
        assertEq(BOS.getNonce(borrower), nonce);
        assertEq(guard.reserves(borrower), 0.05 ether);
    }

    function test_repayProtectRaisesICR() public {
        _depositMUSD(500e18);
        _mixedLadder(_kinds(TroveGuard.Kind.RepayMUSD));
        _dropICRTo(1.2e18);
        uint256 price = FEED.fetchPrice();
        uint256 icrBefore = TM.getCurrentICR(borrower, price);
        uint256 debtBefore = ITroveDebt(address(TM)).getTroveDebt(borrower);
        (bool ok,,,, TroveGuard.Kind kind, uint256 amount,, uint256 musdReserve) = guard.status(borrower);
        assertTrue(ok);
        assertEq(uint8(kind), uint8(TroveGuard.Kind.RepayMUSD));
        assertEq(amount, REPAY);
        assertEq(musdReserve, 500e18);

        vm.prank(keeper);
        guard.protect(borrower, address(0), address(0));

        assertGt(TM.getCurrentICR(borrower, price), icrBefore);
        assertEq(ITroveDebt(address(TM)).getTroveDebt(borrower), debtBefore - REPAY);
        assertEq(guard.musdReserves(borrower), 400e18);
        assertEq(MUSD.balanceOf(address(guard)), 400e18);
        assertEq(guard.reserves(borrower), 0.05 ether - TIP);
        assertEq(keeper.balance, TIP);
    }

    function test_mixedLadderAddRepayAdd() public {
        _depositMUSD(REPAY);
        TroveGuard.Kind[] memory k = new TroveGuard.Kind[](3);
        k[0] = TroveGuard.Kind.AddColl;
        k[1] = TroveGuard.Kind.RepayMUSD;
        k[2] = TroveGuard.Kind.AddColl;
        _mixedLadder(k);
        uint256 n = BOS.getNonce(borrower);
        uint256 debt0 = ITroveDebt(address(TM)).getTroveDebt(borrower);

        for (uint256 i; i < 3; ++i) {
            _dropICRTo(1.15e18);
            (,,,, TroveGuard.Kind kind,,,) = guard.status(borrower);
            assertEq(uint8(kind), uint8(k[i]));
            guard.protect(borrower, address(0), address(0));
            assertEq(BOS.getNonce(borrower), n + i + 1);
        }
        assertEq(ITroveDebt(address(TM)).getTroveDebt(borrower), debt0 - REPAY);
        assertEq(guard.musdReserves(borrower), 0);
        assertEq(guard.reserves(borrower), 0.05 ether - 2 * TOP_UP - 3 * TIP);
    }

    function test_insufficientMUSDReserve() public {
        _depositMUSD(50e18);
        _mixedLadder(_kinds(TroveGuard.Kind.RepayMUSD));
        _dropICRTo(1.15e18);
        (bool ok,,,,,,,) = guard.status(borrower);
        assertFalse(ok);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.InsufficientMUSDReserve.selector, REPAY, 50e18));
        guard.protect(borrower, address(0), address(0));

        _depositMUSD(50e18);
        guard.protect(borrower, address(0), address(0));
        assertEq(guard.musdReserves(borrower), 0);
    }

    function test_kindCannotBeSwapped() public {
        uint256 n = BOS.getNonce(borrower);
        _depositMUSD(REPAY);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](1);
        ps[0] = TroveGuard.Permit(TroveGuard.Kind.RepayMUSD, TOP_UP, deadline, _sign(borrowerKey, borrower, TOP_UP, n, deadline));
        vm.prank(borrower);
        guard.storePermits(n, ps);
        _dropICRTo(1.15e18);
        vm.expectRevert("BorrowerOperationsSignatures: Invalid signature");
        guard.protect(borrower, address(0), address(0));
        assertEq(guard.musdReserves(borrower), REPAY);
    }

    function test_cancelRefundsMUSDAndOnlyOwnerWithdraws() public {
        uint256 musdBefore = MUSD.balanceOf(borrower);
        _depositMUSD(300e18);
        _mixedLadder(_kinds(TroveGuard.Kind.RepayMUSD));

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.InsufficientMUSDReserve.selector, 1, 0));
        guard.withdrawMUSD(1);

        vm.prank(borrower);
        guard.withdrawMUSD(100e18);
        assertEq(MUSD.balanceOf(borrower), musdBefore - 200e18);

        uint256 btcBefore = borrower.balance;
        vm.prank(borrower);
        guard.cancel();
        assertEq(MUSD.balanceOf(borrower), musdBefore);
        assertEq(borrower.balance, btcBefore + 0.05 ether);
        assertEq(guard.musdReserves(borrower), 0);
        assertEq(MUSD.balanceOf(address(guard)), 0);
        assertEq(guard.permitOf(borrower, BOS.getNonce(borrower)).signature.length, 0);
    }
}
