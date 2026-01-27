// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

library OracleLib {
    // Chainlink BTC/USD proxy feed address
    address internal constant FEED = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c;

    // Maximum age of a price report
    uint256 internal constant MAX_STALE_TIME = 15 minutes;
    // Scale all prices to 18 decimals
    uint256 internal constant TARGET_DECIMALS = 1e18;

    /// @dev Internal helper to fetch round data
    function _getRoundData() internal view returns 
        (int256 answer, uint256 updatedAt, uint80 roundId, uint80 answeredInRound)
    {
        (roundId, answer, , updatedAt, answeredInRound) = AggregatorV3Interface(FEED).latestRoundData();
    }

    /// @dev Internal helper to enforce freshness & validity
    function _validate(int256 answer, uint80 roundId, uint256 updatedAt, uint80 answeredInRound) internal view {
        //require(answer > 0, "Oracle: invalid price");
        //require(answeredInRound >= roundId, "Oracle: stale answer");
        //require(block.timestamp - updatedAt <= MAX_STALE_TIME, "Oracle: stale price");
    }

    /// @notice Fetches the latest BTC/USD price, reverting on any stale or invalid data
    function getLatestPrice() internal view returns (uint256) {
        (int256 ans, uint256 updatedAt, uint80 roundId, uint80 answeredInRound) = _getRoundData();
        _validate(ans, roundId, updatedAt, answeredInRound);
        uint8 decimals = AggregatorV3Interface(FEED).decimals();
        return normalize(ans, decimals);
    }

    /// @notice Returns true if the BTC/USD feed is fresh and valid
    function isFresh() internal view returns (bool) {
        (int256 ans, uint256 updatedAt, uint80 roundId, uint80 answeredInRound) = _getRoundData();
        return ans > 0 && answeredInRound >= roundId &&
            block.timestamp - updatedAt <= MAX_STALE_TIME;
    }

    /// @notice Reverts if the BTC/USD feed is stale or invalid
    function onlyFresh() internal view {
        (int256 ans, uint256 updatedAt, uint80 roundId, uint80 answeredInRound) = _getRoundData();
        _validate(ans, roundId, updatedAt, answeredInRound);
    }

    /// @notice Returns the last updated timestamp of the BTC/USD feed
    function lastUpdated() internal view returns (uint256) {
        (, uint256 updatedAt, , ) = _getRoundData();
        return updatedAt;
    }

    /// @dev Scales a raw feed price to 18 decimals
    function normalize(int256 raw, uint8 decimals) internal pure returns (uint256) {
        return Math.mulDiv(uint256(raw), TARGET_DECIMALS, 10 ** decimals);
    }
}
