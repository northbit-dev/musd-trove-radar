// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// Stand-in for Mezo's BTC oracle on an anvil fork, where the real one needs a Mezo precompile.
/// Installed with anvil_setCode; the price is storage slot 0.
contract ForkFeed {
    int256 public answer;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
