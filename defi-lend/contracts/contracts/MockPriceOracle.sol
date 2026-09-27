// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockPriceOracle — owner-settable USD prices with 8 decimals,
/// matching Chainlink's convention so you can swap in real Chainlink
/// aggregators later without changing Pool math.
contract MockPriceOracle {
    address public owner;
    mapping(address => uint256) private prices; // asset => USD price, 1e8

    event PriceSet(address indexed asset, uint256 price);

    modifier onlyOwner() {
        require(msg.sender == owner, "Oracle: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @param price USD price with 8 decimals (e.g. $3,000 => 3000e8)
    function setPrice(address asset, uint256 price) external onlyOwner {
        prices[asset] = price;
        emit PriceSet(asset, price);
    }

    function getPrice(address asset) external view returns (uint256) {
        uint256 p = prices[asset];
        require(p > 0, "Oracle: price not set");
        return p;
    }
}
