// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MezoFork} from "./MezoFork.sol";
import {TroveGuard, IERC20} from "../TroveGuard.sol";

/// Drives a TroveGuard with random sequences of borrower and keeper actions on a Mezo Testnet fork.
contract GuardHandler is MezoFork {
    TroveGuard public immutable guard;
    address[] public actors;
    mapping(address => uint256) public keyOf;
    address public keeper = makeAddr("inv-keeper");

    mapping(address => bool) public cancelledSinceStore;
    uint256 public protectsAfterCancel;
    uint256 public protects;
    uint256 public calls;

    constructor(TroveGuard guard_, address[] memory actors_, uint256[] memory keys) {
        guard = guard_;
        actors = actors_;
        for (uint256 i; i < actors_.length; ++i) {
            keyOf[actors_[i]] = keys[i];
        }
        _setPrice(realPrice);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function configure(uint256 seed, uint128 trigger, uint128 tip, uint96 value) external {
        address a = _actor(seed);
        trigger = uint128(bound(trigger, 1.1e18, 10e18));
        tip = uint128(bound(tip, 0, 0.001 ether));
        value = uint96(bound(value, 0, a.balance));
        ++calls;
        vm.prank(a);
        guard.configure{value: value}(trigger, tip);
    }

    function deposit(uint256 seed, uint96 value) external {
        address a = _actor(seed);
        value = uint96(bound(value, 0, a.balance));
        ++calls;
        vm.prank(a);
        guard.deposit{value: value}();
    }

    function depositMUSD(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        amount = uint96(bound(amount, 0, MUSD.balanceOf(a)));
        ++calls;
        vm.startPrank(a);
        MUSD.approve(address(guard), amount);
        guard.depositMUSD(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        amount = uint96(bound(amount, 0, guard.reserves(a)));
        ++calls;
        vm.prank(a);
        guard.withdraw(amount);
    }

    function withdrawMUSD(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        amount = uint96(bound(amount, 0, guard.musdReserves(a)));
        ++calls;
        vm.prank(a);
        guard.withdrawMUSD(amount);
    }

    function storePermits(uint256 seed, uint8 count, uint256 kinds) external {
        address a = _actor(seed);
        count = uint8(bound(count, 1, 3));
        uint256 nonce = BOS.getNonce(a);
        uint64 dl = uint64(block.timestamp + 1 days);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](count);
        for (uint256 i; i < count; ++i) {
            TroveGuard.Kind kind = (kinds >> i) & 1 == 1 ? TroveGuard.Kind.RepayMUSD : TroveGuard.Kind.AddColl;
            uint128 amount = kind == TroveGuard.Kind.RepayMUSD ? 100e18 : 0.002 ether;
            ps[i] = TroveGuard.Permit(kind, amount, dl, _signKind(kind, keyOf[a], a, amount, nonce + i, dl));
        }
        ++calls;
        vm.prank(a);
        guard.storePermits(nonce, ps);
        cancelledSinceStore[a] = false;
    }

    function cancel(uint256 seed) external {
        address a = _actor(seed);
        ++calls;
        vm.prank(a);
        guard.cancel();
        cancelledSinceStore[a] = true;
    }

    function setPrice(uint256 pct) external {
        pct = bound(pct, 50, 100);
        ++calls;
        _setPrice(realPrice * pct / 100);
    }

    function protect(uint256 seed) external {
        address a = _actor(seed);
        ++calls;
        vm.prank(keeper);
        try guard.protect(a, address(0), address(0)) {
            ++protects;
            if (cancelledSinceStore[a]) ++protectsAfterCancel;
        } catch {}
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract TroveGuardInvariantTest is StdInvariant, MezoFork {
    TroveGuard guard;
    GuardHandler handler;
    address[] actors;

    function setUp() public {
        vm.skip(!_onMezoFork());
        guard = new TroveGuard(BOS, TM, FEED, IERC20(address(MUSD)));
        _setPrice(realPrice);
        uint256[] memory keys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            (address a, uint256 k) = makeAddrAndKey(string(abi.encodePacked("inv-actor-", vm.toString(i))));
            actors.push(a);
            keys[i] = k;
            vm.deal(a, 1 ether);
            vm.prank(a);
            BO.openTrove{value: 0.1 ether}(3000e18, address(0), address(0));
        }
        handler = new GuardHandler(guard, actors, keys);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 25
    function invariant_btcReservesBackedByBalance() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += guard.reserves(actors[i]);
        }
        assertEq(sum, address(guard).balance);
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 25
    function invariant_musdReservesBackedByBalance() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += guard.musdReserves(actors[i]);
        }
        assertEq(sum, MUSD.balanceOf(address(guard)));
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 25
    function invariant_noUsablePermitAfterCancel() public view {
        assertEq(handler.protectsAfterCancel(), 0);
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            if (!handler.cancelledSinceStore(a)) continue;
            uint256 nonce = BOS.getNonce(a);
            for (uint256 j; j < 3; ++j) {
                assertEq(guard.permitOf(a, nonce + j).signature.length, 0);
            }
            (bool protectable,,,,,,,) = guard.status(a);
            assertFalse(protectable);
        }
    }

    function afterInvariant() external view {
        assertGt(handler.calls(), 0);
    }
}
