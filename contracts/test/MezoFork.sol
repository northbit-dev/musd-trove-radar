// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TroveGuard, IBorrowerOperationsSignatures, ITroveManager, IPriceFeed, IERC20} from "../TroveGuard.sol";

interface IBorrowerOperations {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;
}

interface IMUSD {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface ITroveDebt {
    function getTroveDebt(address borrower) external view returns (uint256);
    function getTroveColl(address borrower) external view returns (uint256);
}

/// Mezo Testnet (chainId 31611) contracts and helpers shared by the fork test suites.
abstract contract MezoFork is Test {
    IBorrowerOperationsSignatures constant BOS =
        IBorrowerOperationsSignatures(0xD757e3646AF370b15f32EB557F0F8380Df7D639e);
    IBorrowerOperations constant BO = IBorrowerOperations(0xCdF7028ceAB81fA0C6971208e83fa7872994beE5);
    ITroveManager constant TM = ITroveManager(0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0);
    IPriceFeed constant FEED = IPriceFeed(0x86bCF0841622a5dAC14A313a15f96A95421b9366);
    address constant ORACLE = 0x7b7c000000000000000000000000000000000015;
    IMUSD constant MUSD = IMUSD(0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503);

    bytes32 constant ADD_COLL_TYPEHASH =
        keccak256("AddColl(uint256 assetAmount,address borrower,uint256 nonce,uint256 deadline)");
    bytes32 constant REPAY_MUSD_TYPEHASH =
        keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)");

    uint256 realPrice = 78_000e18;
    uint256 currentPrice;

    function _onMezoFork() internal view returns (bool) {
        return block.chainid == 31611;
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

    function _signKind(TroveGuard.Kind kind, uint256 key, address who, uint256 amount, uint256 nonce, uint256 dl)
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
        bytes32 typeHash = kind == TroveGuard.Kind.AddColl ? ADD_COLL_TYPEHASH : REPAY_MUSD_TYPEHASH;
        bytes32 structHash = keccak256(abi.encode(typeHash, amount, who, nonce, dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
