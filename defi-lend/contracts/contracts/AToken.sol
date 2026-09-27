// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolIndex {
    function getNormalizedIncome(address asset) external view returns (uint256);
}

/// @title AToken — interest-bearing receipt token (like Aave's aWETH/aUSDC).
/// @notice Balances are stored "scaled" (divided by the liquidity index at
/// deposit time) and rescaled by the current index on every read, so your
/// balance grows every second without any transaction. Transfers are disabled
/// in this educational build: hold it, watch it grow, withdraw through the Pool.
contract AToken {
    uint256 private constant WAD = 1e18;

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    address public immutable POOL;
    address public immutable UNDERLYING;

    uint256 public scaledTotalSupply;
    mapping(address => uint256) public scaledBalanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    modifier onlyPool() {
        require(msg.sender == POOL, "AToken: caller is not Pool");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address pool,
        address underlying
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        POOL = pool;
        UNDERLYING = underlying;
    }

    /// @notice Current balance in underlying units, interest included.
    function balanceOf(address user) public view returns (uint256) {
        return (scaledBalanceOf[user] * IPoolIndex(POOL).getNormalizedIncome(UNDERLYING)) / WAD;
    }

    /// @notice Total supplied to the pool for this asset, interest included.
    function totalSupply() external view returns (uint256) {
        return (scaledTotalSupply * IPoolIndex(POOL).getNormalizedIncome(UNDERLYING)) / WAD;
    }

    /// @param amount underlying amount being deposited
    /// @param index liquidity index at mint time (WAD)
    function mint(address user, uint256 amount, uint256 index) external onlyPool {
        uint256 scaled = (amount * WAD) / index;
        require(scaled > 0, "AToken: amount too small");
        scaledBalanceOf[user] += scaled;
        scaledTotalSupply += scaled;
        emit Transfer(address(0), user, amount);
    }

    /// @param amount underlying amount being withdrawn
    /// @param index liquidity index at burn time (WAD)
    function burn(address user, uint256 amount, uint256 index) external onlyPool {
        // Round the scaled amount up so "withdraw everything" never leaves dust,
        // then clamp to the stored balance to absorb rounding.
        uint256 scaled = (amount * WAD + index - 1) / index;
        uint256 bal = scaledBalanceOf[user];
        require(bal > 0, "AToken: nothing to burn");
        if (scaled > bal) scaled = bal;
        scaledBalanceOf[user] = bal - scaled;
        scaledTotalSupply -= scaled;
        emit Transfer(user, address(0), amount);
    }

    // ---- Transfers intentionally disabled in this build ----
    function transfer(address, uint256) external pure returns (bool) {
        revert("AToken: transfers disabled in this demo");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("AToken: transfers disabled in this demo");
    }
}
