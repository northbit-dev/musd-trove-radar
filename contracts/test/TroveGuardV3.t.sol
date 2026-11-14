// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {V3Fork} from "./V3Fork.sol";
import {TroveGuardV3, ITroveManagerV3} from "../TroveGuardV3.sol";

/// Fork tests for TroveGuard v3. Run against an anvil fork of Mezo Testnet.
contract TroveGuardV3ForkTest is V3Fork {
    function test_adjustRungAddsCollAndRepaysInOneStep() public {
        _open(0.05 ether, 2000e18);
        _configure(0, 0, 1);
        _depositMUSD(150e18);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](1);
        ps[0] = _permit(TroveGuardV3.Kind.Adjust, 0.004 ether, 150e18, n);
        _store(ps);

        _dropICRTo(1.2e18);
        (uint256 collBefore, uint256 principalBefore,,,,) = ITroveManagerV3(address(TM)).getEntireDebtAndColl(borrower);
        TroveGuardV3.Status memory s = guard.status(borrower);
        assertTrue(s.protectable);
        assertEq(uint8(s.reason), uint8(TroveGuardV3.Reason.LowICR));

        vm.prank(keeper);
        uint256 rungs = guard.protect(borrower, address(0), address(0));

        (uint256 collAfter, uint256 principalAfter,,,,) = ITroveManagerV3(address(TM)).getEntireDebtAndColl(borrower);
        assertEq(rungs, 1);
        assertEq(collAfter, collBefore + 0.004 ether, "BTC added");
        assertLt(principalAfter, principalBefore, "MUSD repaid");
        assertEq(BOS.getNonce(borrower), n + 1);
        assertEq(guard.reserves(borrower), 0.05 ether - 0.004 ether - TIP);
        assertEq(guard.musdReserves(borrower), 0);
        assertEq(keeper.balance, TIP);
    }

    function test_adjustPermitWithWrongAmountsReverts() public {
        _open(0.05 ether, 2000e18);
        _configure(0, 0, 1);
        _depositMUSD(150e18);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](1);
        ps[0] = _permit(TroveGuardV3.Kind.Adjust, 0.004 ether, 150e18, n);
        ps[0].musd = 100e18; // stored amounts no longer match what was signed
        _store(ps);
        _dropICRTo(1.2e18);
        vm.prank(keeper);
        vm.expectRevert();
        guard.protect(borrower, address(0), address(0));
        assertEq(guard.reserves(borrower), 0.05 ether, "reverted protect leaves reserves untouched");
    }

    function test_storeRejectsMalformedRungs() public {
        _open(0.05 ether, 2000e18);
        _configure(0, 0, 1);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](1);
        ps[0] = _permit(TroveGuardV3.Kind.AddColl, 0.004 ether, 0, n);
        ps[0].musd = 1; // AddColl must not carry MUSD
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(TroveGuardV3.InvalidPermit.selector, n));
        guard.storePermits(n, ps);
    }


    function test_targetICRSpendsRungsUntilTargetAndStops() public {
        _open(0.05 ether, 2000e18);
        _configure(1.3e18, 0, 5);
        _depositMUSD(500e18);
        _repayLadder(5, 100e18);
        _dropICRTo(1.2e18);
        uint256 n = BOS.getNonce(borrower);

        vm.prank(keeper);
        uint256 rungs = guard.protect(borrower, address(0), address(0));

        uint256 icr = TM.getCurrentICR(borrower, FEED.fetchPrice());
        assertGe(icr, 1.3e18, "reached target");
        assertGt(rungs, 1, "needed more than one rung");
        assertLt(rungs, 5, "stopped once the target was reached");
        assertEq(BOS.getNonce(borrower), n + rungs);
        assertEq(guard.musdReserves(borrower), 500e18 - 100e18 * rungs, "only what was needed was repaid");
        assertEq(keeper.balance, uint256(TIP) * rungs);
    }

    function test_maxRungsCapsOneCall() public {
        _open(0.05 ether, 2000e18);
        _configure(2e18, 0, 2);
        _depositMUSD(500e18);
        _repayLadder(5, 100e18);
        _dropICRTo(1.2e18);
        vm.prank(keeper);
        assertEq(guard.protect(borrower, address(0), address(0)), 2);
    }

    function test_loopStopsQuietlyWhenLadderRunsOut() public {
        _open(0.05 ether, 2000e18);
        _configure(2e18, 0, 5);
        _depositMUSD(500e18);
        _repayLadder(2, 100e18);
        _dropICRTo(1.2e18);
        vm.prank(keeper);
        assertEq(guard.protect(borrower, address(0), address(0)), 2);
    }


    function test_rungUnderMinNetDebtStopsTheLoopInsteadOfRevertingIt() public {
        _open(0.05 ether, 2000e18);
        _configure(2e18, 0, 5);
        _depositMUSD(250e18);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](2);
        ps[0] = _permit(TroveGuardV3.Kind.RepayMUSD, 0, 100e18, n);
        ps[1] = _permit(TroveGuardV3.Kind.RepayMUSD, 0, 150e18, n + 1);
        _store(ps);
        _dropICRTo(1.2e18);

        vm.prank(keeper);
        assertEq(guard.protect(borrower, address(0), address(0)), 1);
        assertEq(guard.musdReserves(borrower), 150e18);
        assertFalse(guard.status(borrower).protectable, "remaining rung would breach minNetDebt");
    }


    /// Opens a trove just above MCR so it sits near the back of SortedTroves (lowest NICR).
    function _openNearFront() internal {
        // ~112 % ICR at the fork price: debt ~2,000 MUSD incl. fee and gas compensation.
        _open(0.0288 ether, 1800e18);
        uint256 icr = TM.getCurrentICR(borrower, realPrice);
        assertGt(icr, 1.1e18);
        assertLt(icr, 1.2e18);
    }

    function test_redemptionTriggerFiresWhileICRIsAboveTrigger() public {
        _openNearFront();
        (bool found, uint256 ahead) = guard.redemptionAhead(borrower, 0);
        vm.skip(!found); // testnet state moved: more than MAX_WALK troves below us
        vm.prank(borrower);
        guard.configure{value: 0.05 ether}(1.1e18, TIP, 0, uint128(ahead + 1000e18), 1);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](1);
        ps[0] = _permit(TroveGuardV3.Kind.AddColl, 0.01 ether, 0, n);
        _store(ps);

        TroveGuardV3.Status memory s = guard.status(borrower);
        assertGe(s.icr, 1.1e18, "ICR is not the reason");
        assertEq(uint8(s.reason), uint8(TroveGuardV3.Reason.RedemptionFront));
        assertTrue(s.protectable);

        vm.prank(keeper);
        guard.protect(borrower, address(0), address(0));
        (bool stillFound, uint256 aheadAfter) = guard.redemptionAhead(borrower, 0);
        assertTrue(!stillFound || aheadAfter > ahead, "moved back in the redemption queue");
    }

    function test_redemptionTriggerQuietWhenEnoughMUSDAhead() public {
        _openNearFront();
        (bool found, uint256 ahead) = guard.redemptionAhead(borrower, 0);
        vm.skip(!found || ahead < 2e18);
        vm.prank(borrower);
        guard.configure{value: 0.05 ether}(1.1e18, TIP, 0, 1e18, 1);
        vm.prank(keeper);
        vm.expectRevert();
        guard.protect(borrower, address(0), address(0));
    }

    function test_redemptionWalkIsBounded() public {
        _open(0.5 ether, 2000e18); // ~1,900 % ICR: far from the front
        (bool found,) = guard.redemptionAhead(borrower, 0);
        assertFalse(found);
        vm.prank(borrower);
        guard.configure{value: 0.05 ether}(1.1e18, TIP, 0, type(uint128).max, 1);
        uint256 g = gasleft();
        guard.status(borrower);
        assertLt(g - gasleft(), 3_000_000, "status stays cheap with a huge buffer");
    }


    function test_cancelInvalidatesLadderAndRefunds() public {
        _open(0.05 ether, 2000e18);
        _configure(0, 0, 1);
        _depositMUSD(100e18);
        _repayLadder(1, 100e18);
        uint256 balBefore = borrower.balance;
        vm.prank(borrower);
        guard.cancel();
        assertEq(borrower.balance, balBefore + 0.05 ether);
        assertEq(guard.permitOf(borrower, BOS.getNonce(borrower)).signature.length, 0);
    }
}
