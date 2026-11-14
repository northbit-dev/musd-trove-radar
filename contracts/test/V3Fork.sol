// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFork} from "./MezoFork.sol";
import {
    TroveGuardV3,
    IBorrowerOperationsSignaturesV3,
    ITroveManagerV3,
    ISortedTrovesV3,
    IPriceFeedV3,
    IERC20V3
} from "../TroveGuardV3.sol";

/// TroveGuard v3 deployed on an anvil fork of Mezo Testnet, with signing helpers for every rung kind.
abstract contract V3Fork is MezoFork {
    ISortedTrovesV3 constant ST = ISortedTrovesV3(0x722E4D24FD6Ff8b0AC679450F3D91294607268fA);
    bytes32 constant ADJUST_TROVE_TYPEHASH = keccak256(
        "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );

    uint128 constant TRIGGER = 1.25e18;
    uint128 constant TIP = 0.0001 ether;

    TroveGuardV3 guard;
    address borrower;
    uint256 borrowerKey;
    address keeper = makeAddr("keeper");
    uint64 deadline;

    function setUp() public {
        vm.skip(!_onMezoFork());
        guard = new TroveGuardV3(
            IBorrowerOperationsSignaturesV3(address(BOS)),
            ITroveManagerV3(address(TM)),
            ST,
            IPriceFeedV3(address(FEED)),
            IERC20V3(address(MUSD))
        );
        (borrower, borrowerKey) = makeAddrAndKey("borrower3");
        _setPrice(realPrice);
        deadline = uint64(block.timestamp + 365 days);
        vm.deal(borrower, 1 ether);
    }


    function _open(uint256 coll, uint256 debt) internal {
        vm.prank(borrower);
        BO.openTrove{value: coll}(debt, address(0), address(0));
    }

    function _configure(uint128 target, uint128 buffer, uint8 maxRungs) internal {
        vm.prank(borrower);
        guard.configure{value: 0.05 ether}(TRIGGER, TIP, target, buffer, maxRungs);
    }

    function _depositMUSD(uint256 amount) internal {
        vm.startPrank(borrower);
        MUSD.approve(address(guard), amount);
        guard.depositMUSD(amount);
        vm.stopPrank();
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                address(BOS)
            )
        );
    }

    function _signV3(TroveGuardV3.Kind kind, uint256 btc, uint256 musd, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash;
        if (kind == TroveGuardV3.Kind.AddColl) {
            structHash = keccak256(abi.encode(ADD_COLL_TYPEHASH, btc, borrower, nonce, uint256(deadline)));
        } else if (kind == TroveGuardV3.Kind.RepayMUSD) {
            structHash = keccak256(abi.encode(REPAY_MUSD_TYPEHASH, musd, borrower, nonce, uint256(deadline)));
        } else {
            structHash = keccak256(
                abi.encode(ADJUST_TROVE_TYPEHASH, uint256(0), musd, false, btc, borrower, borrower, nonce, uint256(deadline))
            );
        }
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(borrowerKey, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permit(TroveGuardV3.Kind kind, uint128 btc, uint128 musd, uint256 nonce)
        internal
        view
        returns (TroveGuardV3.Permit memory)
    {
        return TroveGuardV3.Permit(kind, deadline, btc, musd, _signV3(kind, btc, musd, nonce));
    }

    function _store(TroveGuardV3.Permit[] memory ps) internal {
        uint256 n = BOS.getNonce(borrower); // read first: an external call would consume the prank
        vm.prank(borrower);
        guard.storePermits(n, ps);
    }

    function _dropICRTo(uint256 targetICR) internal {
        uint256 icr = TM.getCurrentICR(borrower, realPrice);
        _setPrice(realPrice * targetICR / icr);
    }

    function _repayLadder(uint256 rungs, uint128 each) internal {
        uint256 n = BOS.getNonce(borrower);
        TroveGuardV3.Permit[] memory ps = new TroveGuardV3.Permit[](rungs);
        for (uint256 i; i < rungs; ++i) ps[i] = _permit(TroveGuardV3.Kind.RepayMUSD, 0, each, n + i);
        _store(ps);
    }
}
