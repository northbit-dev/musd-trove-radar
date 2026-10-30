// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFork, ITroveDebt} from "./MezoFork.sol";
import {TroveGuard, IERC20} from "../TroveGuard.sol";

/// Fuzzed protect() against a Mezo Testnet fork. Runs are kept low because every run replays forked state.
contract TroveGuardFuzzTest is MezoFork {
    TroveGuard guard;
    address borrower;
    uint256 borrowerKey;
    address keeper = makeAddr("keeper");
    ITroveDebt constant TROVES = ITroveDebt(address(TM));

    function setUp() public {
        vm.skip(!_onMezoFork());
        guard = new TroveGuard(BOS, TM, FEED, IERC20(address(MUSD)));
        (borrower, borrowerKey) = makeAddrAndKey("fuzz-borrower");
        _setPrice(realPrice);
        vm.deal(borrower, 2 ether);
        vm.prank(borrower);
        BO.openTrove{value: 0.05 ether}(2000e18, address(0), address(0));
    }

    struct Before {
        uint256 guardBtc;
        uint256 guardMusd;
        uint256 keeperBtc;
        uint256 borrowerBtc;
        uint256 borrowerMusd;
        uint256 coll;
        uint256 debt;
        uint256 reserve;
        uint256 musdReserve;
    }

    function _snapshot() internal view returns (Before memory b) {
        b = Before(
            address(guard).balance,
            MUSD.balanceOf(address(guard)),
            keeper.balance,
            borrower.balance,
            MUSD.balanceOf(borrower),
            TROVES.getTroveColl(borrower),
            TROVES.getTroveDebt(borrower),
            guard.reserves(borrower),
            guard.musdReserves(borrower)
        );
    }

    struct Input {
        uint128 trigger;
        uint128 tip;
        uint128 amount;
        uint128 reserve;
        uint128 musdReserve;
        bool repay;
        uint32 deadlineOffset;
        uint32 warp;
        uint64 targetICR;
    }

    function _arm(Input memory x) internal returns (uint256 nonce) {
        x.trigger = uint128(bound(x.trigger, 1.1e18, 10e18));
        x.tip = uint128(bound(x.tip, 0, 0.01 ether));
        x.amount = x.repay ? uint128(bound(x.amount, 1, 400e18)) : uint128(bound(x.amount, 1, 0.5 ether));
        x.reserve = uint128(bound(x.reserve, 0, 1 ether));
        x.musdReserve = uint128(bound(x.musdReserve, 0, 1000e18));
        x.targetICR = uint64(bound(x.targetICR, 1.1e18, 3e18));

        vm.startPrank(borrower);
        guard.configure{value: x.reserve}(x.trigger, x.tip);
        if (x.musdReserve > 0) {
            MUSD.approve(address(guard), x.musdReserve);
            guard.depositMUSD(x.musdReserve);
        }
        nonce = BOS.getNonce(borrower);
        uint64 dl = uint64(block.timestamp + x.deadlineOffset);
        TroveGuard.Kind kind = x.repay ? TroveGuard.Kind.RepayMUSD : TroveGuard.Kind.AddColl;
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](1);
        ps[0] = TroveGuard.Permit(kind, x.amount, dl, _signKind(kind, borrowerKey, borrower, x.amount, nonce, dl));
        guard.storePermits(nonce, ps);
        vm.stopPrank();

        vm.warp(block.timestamp + x.warp);
        _setPrice(realPrice * x.targetICR / TM.getCurrentICR(borrower, realPrice));
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_protectNeverOverspendsOrMisroutes(Input memory x) public {
        uint256 nonce = _arm(x);
        Before memory b = _snapshot();
        (bool protectable,,,,,,,) = guard.status(borrower);
        vm.prank(keeper);
        try guard.protect(borrower, address(0), address(0)) {
            assertTrue(protectable, "status() agreed");
            _checkSpent(x, b);
            assertEq(guard.permitOf(borrower, nonce).signature.length, 0, "permit consumed");
        } catch {
            assertEq(abi.encode(_snapshot()), abi.encode(b), "a revert moves nothing");
        }
    }

    function _checkSpent(Input memory x, Before memory b) internal view {
        uint256 btcOut = x.repay ? x.tip : uint256(x.amount) + x.tip;
        assertLe(btcOut, b.reserve, "BTC spend within reserve");
        assertEq(b.guardBtc - address(guard).balance, btcOut, "guard BTC out");
        assertEq(keeper.balance - b.keeperBtc, x.tip, "keeper got exactly the tip");
        assertEq(borrower.balance, b.borrowerBtc, "borrower EOA untouched");
        assertEq(MUSD.balanceOf(borrower), b.borrowerMusd, "borrower MUSD untouched");
        assertEq(guard.reserves(borrower), b.reserve - btcOut);
        if (x.repay) {
            assertLe(x.amount, b.musdReserve, "MUSD spend within reserve");
            assertEq(b.guardMusd - MUSD.balanceOf(address(guard)), x.amount, "guard MUSD out");
            assertEq(b.debt - TROVES.getTroveDebt(borrower), x.amount, "debt repaid by amount");
            assertEq(TROVES.getTroveColl(borrower), b.coll);
        } else {
            assertEq(TROVES.getTroveColl(borrower) - b.coll, x.amount, "trove got exactly the top-up");
            assertEq(MUSD.balanceOf(address(guard)), b.guardMusd);
        }
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_configureBounds(uint128 trigger, uint128 tip) public {
        vm.prank(borrower);
        if (trigger < 1.1e18 || trigger > 10e18) {
            vm.expectRevert(TroveGuard.InvalidTrigger.selector);
            guard.configure(trigger, tip);
        } else {
            guard.configure(trigger, tip);
            (uint128 t, uint128 k,, bool active) = guard.configs(borrower);
            assertEq(t, trigger);
            assertEq(k, tip);
            assertTrue(active);
        }
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_onlyOwnerWithdraws(address caller, uint96 btc, uint96 musd, uint96 take) public {
        vm.assume(caller != borrower);
        btc = uint96(bound(btc, 1, 1 ether));
        musd = uint96(bound(musd, 1, 1000e18));
        take = uint96(bound(take, 1, type(uint96).max));
        vm.startPrank(borrower);
        guard.configure{value: btc}(1.5e18, 0);
        MUSD.approve(address(guard), musd);
        guard.depositMUSD(musd);
        vm.stopPrank();

        vm.startPrank(caller);
        vm.expectRevert();
        guard.withdraw(take);
        vm.expectRevert();
        guard.withdrawMUSD(take);
        guard.cancel();
        vm.stopPrank();
        assertEq(guard.reserves(borrower), btc);
        assertEq(guard.musdReserves(borrower), musd);
        assertEq(address(guard).balance, btc);
        assertEq(MUSD.balanceOf(address(guard)), musd);
    }
}
