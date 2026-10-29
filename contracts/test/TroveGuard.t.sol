// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TroveGuard, IBorrowerOperationsSignatures, ITroveManager, IPriceFeed} from "../TroveGuard.sol";

interface IBorrowerOperations {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;
}

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
contract TroveGuardForkTest is Test {
    IBorrowerOperationsSignatures constant BOS =
        IBorrowerOperationsSignatures(0xD757e3646AF370b15f32EB557F0F8380Df7D639e);
    IBorrowerOperations constant BO = IBorrowerOperations(0xCdF7028ceAB81fA0C6971208e83fa7872994beE5);
    ITroveManager constant TM = ITroveManager(0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0);
    IPriceFeed constant FEED = IPriceFeed(0x86bCF0841622a5dAC14A313a15f96A95421b9366);
    address constant ORACLE = 0x7b7c000000000000000000000000000000000015;

    bytes32 constant ADD_COLL_TYPEHASH =
        keccak256("AddColl(uint256 assetAmount,address borrower,uint256 nonce,uint256 deadline)");

    uint128 constant TRIGGER = 1.25e18;
    uint128 constant TOP_UP = 0.01 ether;
    uint128 constant TIP = 0.0001 ether;

    TroveGuard guard;
    address borrower;
    uint256 borrowerKey;
    address keeper = makeAddr("keeper");
    uint256 realPrice = 78_000e18;
    uint256 currentPrice;
    uint64 deadline;

    receive() external payable {}

    function setUp() public {
        vm.skip(block.chainid != 31611);
        guard = new TroveGuard(BOS, TM, FEED);
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

    // The live oracle reads a Mezo precompile that anvil cannot execute, so the fork mocks the feed it wraps.
    function _setPrice(uint256 price) internal {
        currentPrice = price;
        vm.mockCall(ORACLE, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.mockCall(
            ORACLE,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(price), block.timestamp, block.timestamp, uint80(1))
        );
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
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                address(BOS)
            )
        );
        bytes32 structHash = keccak256(abi.encode(ADD_COLL_TYPEHASH, amount, who, nonce, dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _ladder(uint256 rungs) internal {
        uint256 first = BOS.getNonce(borrower);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](rungs);
        for (uint256 i; i < rungs; ++i) {
            ps[i] = TroveGuard.Permit(TOP_UP, deadline, _sign(borrowerKey, borrower, TOP_UP, first + i, deadline));
        }
        vm.prank(borrower);
        guard.storePermits(first, ps);
    }

    function test_protectTopsUpBelowTrigger() public {
        _ladder(1);
        _dropICRTo(1.2e18);
        uint256 price = FEED.fetchPrice();
        uint256 icrBefore = TM.getCurrentICR(borrower, price);
        uint256 nonceBefore = BOS.getNonce(borrower);
        (bool ok,,,,,) = guard.status(borrower);
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
        ps[0] = TroveGuard.Permit(TOP_UP, deadline, _sign(borrowerKey, borrower, TOP_UP, n, deadline));
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(TroveGuard.StaleNonce.selector, n, n + 1));
        guard.storePermits(n, ps);
    }

    function test_foreignSignatureCannotMoveFunds() public {
        (address mallory, uint256 malloryKey) = makeAddrAndKey("mallory");
        uint256 n = BOS.getNonce(borrower);
        TroveGuard.Permit[] memory ps = new TroveGuard.Permit[](1);
        ps[0] = TroveGuard.Permit(TOP_UP, deadline, _sign(malloryKey, borrower, TOP_UP, n, deadline));

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
}
