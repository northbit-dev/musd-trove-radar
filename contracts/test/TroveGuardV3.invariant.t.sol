// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MezoFork} from "./MezoFork.sol";
import {
    TroveGuardV3,
    IBorrowerOperationsSignaturesV3,
    ITroveManagerV3,
    ISortedTrovesV3,
    IPriceFeedV3,
    IERC20V3
} from "../TroveGuardV3.sol";

/// Drives a TroveGuardV3 with random sequences of borrower and keeper actions on a Mezo Testnet fork.
contract GuardV3Handler is MezoFork {
    bytes32 constant ADJUST_TROVE_TYPEHASH = keccak256(
        "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );

    TroveGuardV3 public immutable guard;
    address[] public actors;
    mapping(address => uint256) public keyOf;
    address public keeper = makeAddr("inv3-keeper");

    mapping(address => bool) public cancelledSinceStore;
    uint256 public protectsAfterCancel;
    uint256 public overspentRungs;
    uint256 public tipsPaid;
    uint256 public protects;
    uint256 public calls;

    constructor(TroveGuardV3 guard_, address[] memory actors_, uint256[] memory keys) {
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

    function configure(uint256 seed, uint128 trigger, uint128 tip, uint128 target, uint128 buffer, uint8 maxRungs, uint96 value)
        external
    {
        address a = _actor(seed);
        trigger = uint128(bound(trigger, 1.1e18, 3e18));
        tip = uint128(bound(tip, 0, 0.001 ether));
        target = target % 2 == 0 ? 0 : uint128(bound(target, trigger, 4e18));
        buffer = buffer % 2 == 0 ? 0 : uint128(bound(buffer, 1e18, 1_000_000e18));
        maxRungs = uint8(bound(maxRungs, 1, 5));
        value = uint96(bound(value, 0, a.balance));
        ++calls;
        vm.prank(a);
        guard.configure{value: value}(trigger, tip, target, buffer, maxRungs);
    }

    function deposit(uint256 seed, uint96 value) external {
        address a = _actor(seed);
        value = uint96(bound(value, 1, a.balance));
        ++calls;
        vm.prank(a);
        guard.deposit{value: value}();
    }

    function depositMUSD(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        amount = uint96(bound(amount, 1, MUSD.balanceOf(a)));
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

    function _sign(TroveGuardV3.Kind kind, address a, uint256 btc, uint256 musd, uint256 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                address(BOS)
            )
        );
        bytes32 structHash = kind == TroveGuardV3.Kind.AddColl
            ? keccak256(abi.encode(ADD_COLL_TYPEHASH, btc, a, nonce, dl))
            : kind == TroveGuardV3.Kind.RepayMUSD
                ? keccak256(abi.encode(REPAY_MUSD_TYPEHASH, musd, a, nonce, dl))
                : keccak256(abi.encode(ADJUST_TROVE_TYPEHASH, uint256(0), musd, false, btc, a, a, nonce, dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[a], keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function storePermits(uint256 seed, uint8 count, uint256 kinds) external {
        address a = _actor(seed);
        count = uint8(bound(count, 1, 5));
        uint256 nonce = BOS.getNonce(a);
        uint64 dl = uint64(block.timestamp + 1 days);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](count);
        for (uint256 i; i < count; ++i) {
            TroveGuardV3.Kind kind = TroveGuardV3.Kind((kinds >> (2 * i)) % 3);
            uint128 btc = kind == TroveGuardV3.Kind.RepayMUSD ? 0 : 0.002 ether;
            uint128 musd = kind == TroveGuardV3.Kind.AddColl ? 0 : 100e18;
            ps[i] = TroveGuardV3.Permit(kind, dl, btc, musd, _sign(kind, a, btc, musd, nonce + i, dl));
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

    /// Random sequences rarely line up config, reserves and permits, so this path arms an actor fully first.
    function armAndProtect(uint256 seed, uint256 kinds, uint128 target, uint8 maxRungs) external {
        address a = _actor(seed);
        if (MUSD.balanceOf(a) < 500e18 || a.balance < 0.03 ether) return;
        this.configure(seed, 3e18, 0.0005 ether, target, 0, maxRungs, 0.03 ether);
        this.depositMUSD(seed, 500e18);
        this.storePermits(seed, 5, kinds);
        this.protect(seed);
    }

    function protect(uint256 seed) public {
        address a = _actor(seed);
        (,,,,, uint8 maxRungs,) = guard.configs(a);
        uint256 before = keeper.balance;
        ++calls;
        // Zero hints make SortedTroves walk the whole testnet list per rung; gas is not what this handler checks.
        vm.pauseGasMetering();
        vm.prank(keeper);
        try guard.protect(a, address(0), address(0)) returns (uint256 rungs) {
            ++protects;
            tipsPaid += keeper.balance - before;
            if (rungs > maxRungs) ++overspentRungs;
            if (cancelledSinceStore[a]) ++protectsAfterCancel;
        } catch {}
        vm.resumeGasMetering();
    }
}

contract TroveGuardV3InvariantTest is StdInvariant, MezoFork {
    TroveGuardV3 guard;
    GuardV3Handler handler;
    address[] actors;

    function setUp() public {
        vm.skip(!_onMezoFork());
        guard = new TroveGuardV3(
            IBorrowerOperationsSignaturesV3(address(BOS)),
            ITroveManagerV3(address(TM)),
            ISortedTrovesV3(0x722E4D24FD6Ff8b0AC679450F3D91294607268fA),
            IPriceFeedV3(address(FEED)),
            IERC20V3(address(MUSD))
        );
        _setPrice(realPrice);
        uint256[] memory keys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            (address a, uint256 k) = makeAddrAndKey(string(abi.encodePacked("inv3-actor-", vm.toString(i))));
            actors.push(a);
            keys[i] = k;
            vm.deal(a, 1 ether);
            vm.prank(a);
            BO.openTrove{value: 0.1 ether}(3000e18, address(0), address(0));
        }
        handler = new GuardV3Handler(guard, actors, keys);
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
            for (uint256 j; j < 5; ++j) {
                assertEq(guard.permitOf(a, nonce + j).signature.length, 0);
            }
            assertFalse(guard.status(a).protectable);
        }
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 25
    function invariant_rungsAndTipsStayWithinConfig() public view {
        assertEq(handler.overspentRungs(), 0);
        assertEq(handler.tipsPaid(), handler.keeper().balance);
    }

    function afterInvariant() external view {
        assertGt(handler.calls(), 0);
    }
}
