// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {V3Fork} from "./V3Fork.sol";
import {TroveGuardV3, ITroveManagerV3} from "../TroveGuardV3.sol";

/// Fuzzed v3 ladders against a Mezo Testnet fork. Runs are kept low because every run replays forked state.
contract TroveGuardV3FuzzTest is V3Fork {
    struct Input {
        uint256 kinds;
        uint256 sizes;
        uint128 tip;
        uint128 target;
        uint8 maxRungs;
        uint64 icr;
        uint128 btcReserve;
        uint128 musdReserve;
    }

    struct Before {
        uint256 guardBtc;
        uint256 guardMusd;
        uint256 reserve;
        uint256 musdReserve;
        uint256 coll;
        uint256 debt;
        uint256 nonce;
        uint256 icr;
    }

    TroveGuardV3.Permit[5] ladder;

    function _arm(Input memory x) internal returns (Before memory b) {
        x.tip = uint128(bound(x.tip, 0, 0.001 ether));
        x.maxRungs = uint8(bound(x.maxRungs, 1, 5));
        x.target = x.target % 2 == 0 ? 0 : uint128(bound(x.target, TRIGGER, 3e18));
        x.icr = uint64(bound(x.icr, 1.12e18, TRIGGER - 1));
        _open(0.05 ether, 2400e18);
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](5);
        for (uint256 i; i < 5; ++i) {
            TroveGuardV3.Kind kind = TroveGuardV3.Kind((x.kinds >> (2 * i)) % 3);
            uint128 btc = kind == TroveGuardV3.Kind.RepayMUSD ? 0 : uint128(bound(x.sizes >> (40 * i) & 0xffff, 1, 0xffff)) * 1e13;
            uint128 musd = kind == TroveGuardV3.Kind.AddColl ? 0 : uint128(bound(x.sizes >> (40 * i + 16) & 0xffff, 1, 0xffff)) * 1e15;
            ps[i] = _permit(kind, btc, musd, n + i);
            ladder[i] = ps[i];
        }
        _store(ps);
        x.btcReserve = uint128(bound(x.btcReserve, 0, 0.5 ether));
        x.musdReserve = uint128(bound(x.musdReserve, 0, 400e18));
        vm.deal(borrower, 1 ether);
        vm.prank(borrower);
        guard.configure{value: x.btcReserve}(TRIGGER, x.tip, x.target, 0, x.maxRungs);
        if (x.musdReserve > 0) _depositMUSD(x.musdReserve);
        _dropICRTo(x.icr);
        (uint256 coll, uint256 p, uint256 it,, uint256 pp, uint256 pi) =
            ITroveManagerV3(address(TM)).getEntireDebtAndColl(borrower);
        b = Before(
            address(guard).balance,
            MUSD.balanceOf(address(guard)),
            guard.reserves(borrower),
            guard.musdReserves(borrower),
            coll,
            p + it + pp + pi,
            n,
            TM.getCurrentICR(borrower, FEED.fetchPrice())
        );
    }

    /// forge-config: default.fuzz.runs = 48
    function testFuzz_protectMovesExactlyWhatTheSpentRungsSay(Input memory x) public {
        Before memory b = _arm(x);
        uint256 keeperBefore = keeper.balance;
        // Zero hints make SortedTroves walk the whole testnet list per rung; gas is not what this test measures.
        vm.pauseGasMetering();
        vm.prank(keeper);
        try guard.protect(borrower, address(0), address(0)) returns (uint256 rungs) {
            assertGe(rungs, 1);
            assertLe(rungs, x.maxRungs);
            if (x.target == 0) assertEq(rungs, 1, "no target: one rung per call");
            assertEq(BOS.getNonce(borrower), b.nonce + rungs);

            uint256 btc;
            uint256 musd;
            for (uint256 i; i < rungs; ++i) {
                btc += ladder[i].btc;
                musd += ladder[i].musd;
            }
            uint256 tip = uint256(x.tip) * rungs;
            assertEq(keeper.balance - keeperBefore, tip, "tip per rung");
            assertEq(b.guardBtc - address(guard).balance, btc + tip, "guard BTC out = rungs + tips");
            assertEq(b.reserve - guard.reserves(borrower), btc + tip);
            assertEq(b.guardMusd - MUSD.balanceOf(address(guard)), musd, "guard MUSD out = repaid");
            assertEq(b.musdReserve - guard.musdReserves(borrower), musd);
            (uint256 coll,,,,,) = ITroveManagerV3(address(TM)).getEntireDebtAndColl(borrower);
            assertEq(coll, b.coll + btc, "every BTC sent lands in the trove");

            uint256 icr = TM.getCurrentICR(borrower, FEED.fetchPrice());
            assertGt(icr, b.icr);
            if (x.target != 0 && rungs < x.maxRungs && icr < x.target) {
                assertFalse(_nextReady(x.tip), "stopped early with a usable rung");
            }
        } catch {
            assertEq(address(guard).balance, b.guardBtc, "a failed protect moves no BTC");
            assertEq(MUSD.balanceOf(address(guard)), b.guardMusd, "a failed protect moves no MUSD");
            assertEq(BOS.getNonce(borrower), b.nonce);
            TroveGuardV3.Permit memory first = ladder[0];
            bool funded = b.reserve >= first.btc + x.tip && b.musdReserve >= first.musd;
            assertFalse(funded, "a funded first rung must be protectable");
        }
    }

    function _nextReady(uint256 tip) internal view returns (bool) {
        TroveGuardV3.Permit memory p = guard.permitOf(borrower, BOS.getNonce(borrower));
        return p.signature.length > 0 && guard.reserves(borrower) >= p.btc + tip && guard.musdReserves(borrower) >= p.musd
            && ITroveManagerV3(address(TM)).getTroveDebt(borrower) >= p.musd + 200e18 + 1800e18;
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_configureRejectsOutOfRangeSettings(uint128 trigger, uint128 target, uint8 maxRungs) public {
        bool ok = trigger >= 1.1e18 && trigger <= 10e18 && (target == 0 || (target >= trigger && target <= 10e18))
            && maxRungs >= 1 && maxRungs <= 5;
        vm.prank(borrower);
        if (!ok) vm.expectRevert(TroveGuardV3.InvalidConfig.selector);
        guard.configure(trigger, 0, target, 0, maxRungs);
        if (ok) {
            (uint128 t,, uint128 tg,,, uint8 m, bool active) = guard.configs(borrower);
            assertEq(t, trigger);
            assertEq(tg, target);
            assertEq(m, maxRungs);
            assertTrue(active);
        }
    }
}
