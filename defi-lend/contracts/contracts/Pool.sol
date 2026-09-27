// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AToken.sol";
import "./VariableDebtToken.sol";
import "./MockPriceOracle.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title Pool — a simplified Aave v3-style lending pool for Sepolia.
///
/// Faithful to the real thing where it matters for learning:
///   - scaled aToken / debtToken balances against liquidity & borrow indexes
///   - utilization-based interest rates (base + slope1 up to the kink, slope2 after)
///   - LTV vs liquidation-threshold distinction, weighted per collateral asset
///   - health factor, and public liquidation with a bonus when HF < 1
///
/// Deliberately simplified for the testnet build:
///   - linear (not compounded-per-second) interest accrual
///   - no isolation mode, e-mode, flash loans, stable-rate borrows, or treasury fee
contract Pool {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant CLOSE_FACTOR_BPS = 5_000; // liquidators may repay up to 50% of debt

    struct ReserveData {
        bool isActive;
        AToken aToken;
        VariableDebtToken debtToken;
        uint8 decimals;
        // risk parameters (basis points)
        uint16 ltv;                  // e.g. 7500 = borrow up to 75% of value
        uint16 liquidationThreshold; // e.g. 8000 = liquidatable past 80%
        uint16 liquidationBonus;     // e.g. 10500 = liquidator gets 105% of debt value
        // interest state
        uint256 liquidityIndex;            // WAD, grows with supply interest
        uint256 variableBorrowIndex;       // WAD, grows with borrow interest
        uint256 currentLiquidityRate;      // WAD, annual
        uint256 currentVariableBorrowRate; // WAD, annual
        uint40 lastUpdateTimestamp;
        // interest rate model (WAD)
        uint256 baseRate;
        uint256 slope1;
        uint256 slope2;
        uint256 optimalUtilization;
    }

    address public owner;
    MockPriceOracle public oracle;
    mapping(address => ReserveData) public reserves;
    address[] public reservesList;

    bool private locked;

    event ReserveInitialized(address indexed asset, address aToken, address debtToken);
    event Supply(address indexed asset, address indexed user, address indexed onBehalfOf, uint256 amount);
    event Withdraw(address indexed asset, address indexed user, address indexed to, uint256 amount);
    event Borrow(address indexed asset, address indexed user, uint256 amount, uint256 borrowRate);
    event Repay(address indexed asset, address indexed user, address indexed repayer, uint256 amount);
    event LiquidationCall(
        address indexed collateralAsset,
        address indexed debtAsset,
        address indexed user,
        uint256 debtCovered,
        uint256 collateralSeized,
        address liquidator
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Pool: not owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Pool: reentrancy");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _oracle) {
        owner = msg.sender;
        oracle = MockPriceOracle(_oracle);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function initReserve(
        address asset,
        address aToken,
        address debtToken,
        uint8 decimals_,
        uint16 ltv,
        uint16 liquidationThreshold,
        uint16 liquidationBonus,
        uint256 baseRate,
        uint256 slope1,
        uint256 slope2,
        uint256 optimalUtilization
    ) external onlyOwner {
        require(!reserves[asset].isActive, "Pool: reserve exists");
        require(ltv <= liquidationThreshold && liquidationThreshold <= BPS, "Pool: bad risk params");
        require(liquidationBonus > BPS, "Pool: bonus must exceed 100%");

        ReserveData storage r = reserves[asset];
        r.isActive = true;
        r.aToken = AToken(aToken);
        r.debtToken = VariableDebtToken(debtToken);
        r.decimals = decimals_;
        r.ltv = ltv;
        r.liquidationThreshold = liquidationThreshold;
        r.liquidationBonus = liquidationBonus;
        r.liquidityIndex = WAD;
        r.variableBorrowIndex = WAD;
        r.lastUpdateTimestamp = uint40(block.timestamp);
        r.baseRate = baseRate;
        r.slope1 = slope1;
        r.slope2 = slope2;
        r.optimalUtilization = optimalUtilization;

        reservesList.push(asset);
        emit ReserveInitialized(asset, aToken, debtToken);
    }

    // ---------------------------------------------------------------
    // Core actions
    // ---------------------------------------------------------------

    /// @notice Deposit `amount` of `asset`; receive interest-bearing aTokens.
    function supply(address asset, uint256 amount, address onBehalfOf) external nonReentrant {
        ReserveData storage r = _activeReserve(asset);
        require(amount > 0, "Pool: amount is zero");

        _accrueInterest(r);
        require(
            IERC20Minimal(asset).transferFrom(msg.sender, address(this), amount),
            "Pool: transferFrom failed"
        );
        r.aToken.mint(onBehalfOf, amount, r.liquidityIndex);
        _updateRates(asset, r);

        emit Supply(asset, msg.sender, onBehalfOf, amount);
    }

    /// @notice Withdraw supplied `asset`. Pass type(uint256).max to withdraw everything.
    function withdraw(address asset, uint256 amount, address to) external nonReentrant returns (uint256) {
        ReserveData storage r = _activeReserve(asset);
        _accrueInterest(r);

        uint256 userBalance = r.aToken.balanceOf(msg.sender);
        if (amount == type(uint256).max) amount = userBalance;
        require(amount > 0 && amount <= userBalance, "Pool: invalid withdraw amount");
        require(IERC20Minimal(asset).balanceOf(address(this)) >= amount, "Pool: not enough liquidity");

        r.aToken.burn(msg.sender, amount, r.liquidityIndex);
        require(IERC20Minimal(asset).transfer(to, amount), "Pool: transfer failed");
        _updateRates(asset, r);

        // The withdrawal must not push the caller below a health factor of 1.
        (, uint256 totalDebtBase, , , , uint256 healthFactor) = getUserAccountData(msg.sender);
        require(totalDebtBase == 0 || healthFactor >= WAD, "Pool: withdrawal breaks health factor");

        emit Withdraw(asset, msg.sender, to, amount);
        return amount;
    }

    /// @notice Borrow `asset` against your supplied collateral.
    function borrow(address asset, uint256 amount) external nonReentrant {
        ReserveData storage r = _activeReserve(asset);
        require(amount > 0, "Pool: amount is zero");

        _accrueInterest(r);

        (, , uint256 availableBorrowsBase, , , ) = getUserAccountData(msg.sender);
        uint256 amountBase = (amount * oracle.getPrice(asset)) / (10 ** uint256(r.decimals));
        require(amountBase > 0, "Pool: amount too small");
        require(amountBase <= availableBorrowsBase, "Pool: collateral cannot cover borrow");
        require(IERC20Minimal(asset).balanceOf(address(this)) >= amount, "Pool: not enough liquidity");

        r.debtToken.mint(msg.sender, amount, r.variableBorrowIndex);
        require(IERC20Minimal(asset).transfer(msg.sender, amount), "Pool: transfer failed");
        _updateRates(asset, r);

        emit Borrow(asset, msg.sender, amount, r.currentVariableBorrowRate);
    }

    /// @notice Repay debt. Pass type(uint256).max to repay everything
    /// (approve a little extra first — debt grows every second).
    function repay(address asset, uint256 amount, address onBehalfOf) external nonReentrant returns (uint256) {
        ReserveData storage r = _activeReserve(asset);
        _accrueInterest(r);

        uint256 debt = r.debtToken.balanceOf(onBehalfOf);
        require(debt > 0, "Pool: nothing to repay");
        uint256 payback = amount >= debt ? debt : amount;
        require(payback > 0, "Pool: amount is zero");

        require(
            IERC20Minimal(asset).transferFrom(msg.sender, address(this), payback),
            "Pool: transferFrom failed"
        );
        r.debtToken.burn(onBehalfOf, payback, r.variableBorrowIndex);
        _updateRates(asset, r);

        emit Repay(asset, onBehalfOf, msg.sender, payback);
        return payback;
    }

    /// @notice Liquidate an unhealthy position (health factor < 1). The caller
    /// repays up to 50% of the user's debt in `debtAsset` and seizes
    /// `collateralAsset` worth (debt repaid x liquidationBonus).
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover
    ) external nonReentrant {
        ReserveData storage cr = _activeReserve(collateralAsset);
        ReserveData storage dr = _activeReserve(debtAsset);
        _accrueInterest(cr);
        _accrueInterest(dr);

        (, , , , , uint256 healthFactor) = getUserAccountData(user);
        require(healthFactor < WAD, "Pool: health factor above 1");

        uint256 userDebt = dr.debtToken.balanceOf(user);
        require(userDebt > 0, "Pool: user has no debt in this asset");
        uint256 maxClose = (userDebt * CLOSE_FACTOR_BPS) / BPS;
        uint256 actualDebt = debtToCover > maxClose ? maxClose : debtToCover;
        require(actualDebt > 0, "Pool: nothing to liquidate");

        // collateral seized = debt value x bonus, converted into collateral units
        uint256 debtPrice = oracle.getPrice(debtAsset);
        uint256 collPrice = oracle.getPrice(collateralAsset);
        uint256 collateralAmount = (actualDebt * debtPrice * (10 ** uint256(cr.decimals)) * cr.liquidationBonus)
            / (collPrice * (10 ** uint256(dr.decimals)) * BPS);

        uint256 userCollateral = cr.aToken.balanceOf(user);
        if (collateralAmount > userCollateral) {
            // Not enough collateral for the full bonus: seize it all and scale
            // the repaid debt down proportionally.
            collateralAmount = userCollateral;
            actualDebt = (collateralAmount * collPrice * (10 ** uint256(dr.decimals)) * BPS)
                / (debtPrice * (10 ** uint256(cr.decimals)) * cr.liquidationBonus);
            require(actualDebt > 0, "Pool: collateral too small");
        }

        require(
            IERC20Minimal(debtAsset).transferFrom(msg.sender, address(this), actualDebt),
            "Pool: transferFrom failed"
        );
        dr.debtToken.burn(user, actualDebt, dr.variableBorrowIndex);
        cr.aToken.burn(user, collateralAmount, cr.liquidityIndex);
        require(IERC20Minimal(collateralAsset).transfer(msg.sender, collateralAmount), "Pool: transfer failed");

        _updateRates(debtAsset, dr);
        _updateRates(collateralAsset, cr);

        emit LiquidationCall(collateralAsset, debtAsset, user, actualDebt, collateralAmount, msg.sender);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @notice Aggregated account data. All "Base" values are USD with 8 decimals.
    function getUserAccountData(address user)
        public
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        uint256 weightedLtv;
        uint256 weightedThreshold;

        for (uint256 i = 0; i < reservesList.length; i++) {
            address asset = reservesList[i];
            ReserveData storage r = reserves[asset];
            uint256 price = oracle.getPrice(asset);
            uint256 unit = 10 ** uint256(r.decimals);

            uint256 collateralBal = r.aToken.balanceOf(user);
            if (collateralBal > 0) {
                uint256 v = (collateralBal * price) / unit;
                totalCollateralBase += v;
                weightedLtv += v * r.ltv;
                weightedThreshold += v * r.liquidationThreshold;
            }

            uint256 debtBal = r.debtToken.balanceOf(user);
            if (debtBal > 0) {
                totalDebtBase += (debtBal * price) / unit;
            }
        }

        if (totalCollateralBase > 0) {
            ltv = weightedLtv / totalCollateralBase;
            currentLiquidationThreshold = weightedThreshold / totalCollateralBase;
        }

        uint256 borrowCapacity = (totalCollateralBase * ltv) / BPS;
        availableBorrowsBase = borrowCapacity > totalDebtBase ? borrowCapacity - totalDebtBase : 0;

        healthFactor = totalDebtBase == 0
            ? type(uint256).max
            : (totalCollateralBase * currentLiquidationThreshold * WAD) / (totalDebtBase * BPS);
    }

    function getReservesList() external view returns (address[] memory) {
        return reservesList;
    }

    /// @notice Liquidity index projected to now (WAD). aTokens read this.
    function getNormalizedIncome(address asset) external view returns (uint256) {
        ReserveData storage r = reserves[asset];
        return _projectIndex(r.liquidityIndex, r.currentLiquidityRate, r.lastUpdateTimestamp);
    }

    /// @notice Borrow index projected to now (WAD). Debt tokens read this.
    function getNormalizedDebt(address asset) external view returns (uint256) {
        ReserveData storage r = reserves[asset];
        return _projectIndex(r.variableBorrowIndex, r.currentVariableBorrowRate, r.lastUpdateTimestamp);
    }

    /// @notice Everything a UI needs about one market, in a single call.
    function getReserveData(address asset)
        external
        view
        returns (
            address aToken,
            address debtToken,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 totalSupplied,
            uint256 totalBorrowed,
            uint256 availableLiquidity,
            uint256 utilization,
            uint16 ltv,
            uint16 liquidationThreshold
        )
    {
        ReserveData storage r = _activeReserve(asset);
        totalSupplied = r.aToken.totalSupply();
        totalBorrowed = r.debtToken.totalSupply();
        availableLiquidity = IERC20Minimal(asset).balanceOf(address(this));
        uint256 total = totalBorrowed + availableLiquidity;
        utilization = total == 0 ? 0 : (totalBorrowed * WAD) / total;
        return (
            address(r.aToken),
            address(r.debtToken),
            r.currentLiquidityRate,
            r.currentVariableBorrowRate,
            totalSupplied,
            totalBorrowed,
            availableLiquidity,
            utilization,
            r.ltv,
            r.liquidationThreshold
        );
    }

    // ---------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------

    function _activeReserve(address asset) internal view returns (ReserveData storage r) {
        r = reserves[asset];
        require(r.isActive, "Pool: reserve not active");
    }

    function _projectIndex(uint256 index, uint256 rate, uint40 last) internal view returns (uint256) {
        uint256 dt = block.timestamp - last;
        if (dt == 0 || rate == 0) return index;
        return (index * (WAD + (rate * dt) / SECONDS_PER_YEAR)) / WAD;
    }

    /// @dev Roll both indexes forward to the current timestamp.
    function _accrueInterest(ReserveData storage r) internal {
        uint40 nowTs = uint40(block.timestamp);
        if (r.lastUpdateTimestamp == nowTs) return;
        r.liquidityIndex = _projectIndex(r.liquidityIndex, r.currentLiquidityRate, r.lastUpdateTimestamp);
        r.variableBorrowIndex = _projectIndex(r.variableBorrowIndex, r.currentVariableBorrowRate, r.lastUpdateTimestamp);
        r.lastUpdateTimestamp = nowTs;
    }

    /// @dev Recompute rates from utilization after every state-changing action.
    function _updateRates(address asset, ReserveData storage r) internal {
        uint256 totalDebt = r.debtToken.totalSupply();
        uint256 available = IERC20Minimal(asset).balanceOf(address(this));
        uint256 total = totalDebt + available;
        uint256 util = total == 0 ? 0 : (totalDebt * WAD) / total;

        uint256 borrowRate;
        if (util <= r.optimalUtilization) {
            borrowRate = r.baseRate + (r.slope1 * util) / r.optimalUtilization;
        } else {
            borrowRate = r.baseRate + r.slope1
                + (r.slope2 * (util - r.optimalUtilization)) / (WAD - r.optimalUtilization);
        }

        r.currentVariableBorrowRate = borrowRate;
        // Suppliers earn the borrow rate scaled by utilization (no reserve factor here).
        r.currentLiquidityRate = (borrowRate * util) / WAD;
    }
}
