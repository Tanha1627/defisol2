// Human-readable ABIs — only what the backend needs.

export const POOL_ABI = [
  "function oracle() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveData(address asset) view returns (address aToken, address debtToken, uint256 liquidityRate, uint256 variableBorrowRate, uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, uint256 utilization, uint16 ltv, uint16 liquidationThreshold)",
  "event Supply(address indexed asset, address indexed user, address indexed onBehalfOf, uint256 amount)",
  "event Withdraw(address indexed asset, address indexed user, address indexed to, uint256 amount)",
  "event Borrow(address indexed asset, address indexed user, uint256 amount, uint256 borrowRate)",
  "event Repay(address indexed asset, address indexed user, address indexed repayer, uint256 amount)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtCovered, uint256 collateralSeized, address liquidator)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
