// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolDebtIndex {
    function getNormalizedDebt(address asset) external view returns (uint256);
}

/// @title VariableDebtToken — tracks each user's variable-rate debt.
/// @notice Same scaled-balance trick as the aToken, but against the borrow
/// index, so your debt grows over time. Non-transferable (you can't send your
/// debt to someone else — this matches Aave).
contract VariableDebtToken {
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
        require(msg.sender == POOL, "DebtToken: caller is not Pool");
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

    /// @notice Current debt in underlying units, accrued interest included.
    function balanceOf(address user) public view returns (uint256) {
        return (scaledBalanceOf[user] * IPoolDebtIndex(POOL).getNormalizedDebt(UNDERLYING)) / WAD;
    }

    /// @notice Total outstanding borrows for this asset, interest included.
    function totalSupply() external view returns (uint256) {
        return (scaledTotalSupply * IPoolDebtIndex(POOL).getNormalizedDebt(UNDERLYING)) / WAD;
    }

    function mint(address user, uint256 amount, uint256 index) external onlyPool {
        uint256 scaled = (amount * WAD) / index;
        require(scaled > 0, "DebtToken: amount too small");
        scaledBalanceOf[user] += scaled;
        scaledTotalSupply += scaled;
        emit Transfer(address(0), user, amount);
    }

    function burn(address user, uint256 amount, uint256 index) external onlyPool {
        uint256 scaled = (amount * WAD + index - 1) / index;
        uint256 bal = scaledBalanceOf[user];
        require(bal > 0, "DebtToken: nothing to burn");
        if (scaled > bal) scaled = bal;
        scaledBalanceOf[user] = bal - scaled;
        scaledTotalSupply -= scaled;
        emit Transfer(user, address(0), amount);
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("DebtToken: non-transferable");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("DebtToken: non-transferable");
    }
}
