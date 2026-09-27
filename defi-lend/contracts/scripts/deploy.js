// Deploys the whole protocol to whichever network you pass with --network.
// Writes all addresses to deployments.json and copies them into
// ../backend and ../frontend/src so the other layers pick them up automatically.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const WAD = 10n ** 18n;
const pct = (n) => (WAD * BigInt(n)) / 100n; // annual rate, e.g. pct(4) = 4%

// Assets to list. faucetAmount is what one "Get test tokens" click mints.
const ASSETS = [
  {
    name: "Mock Wrapped Ether", symbol: "WETH", decimals: 18,
    priceUsd: 3000_00000000n,                 // $3,000 (8 decimals)
    faucetAmount: 10n * 10n ** 18n,           // 10 WETH per faucet call
    ltv: 7500, liqThreshold: 8000, liqBonus: 10500,
    baseRate: pct(0), slope1: pct(4), slope2: pct(75), optimalUtil: (WAD * 80n) / 100n,
  },
  {
    name: "Mock USD Coin", symbol: "USDC", decimals: 6,
    priceUsd: 1_00000000n,                    // $1
    faucetAmount: 10_000n * 10n ** 6n,        // 10,000 USDC
    ltv: 8000, liqThreshold: 8500, liqBonus: 10400,
    baseRate: pct(0), slope1: pct(4), slope2: pct(60), optimalUtil: (WAD * 90n) / 100n,
  },
  {
    name: "Mock Dai", symbol: "DAI", decimals: 18,
    priceUsd: 1_00000000n,                    // $1
    faucetAmount: 10_000n * 10n ** 18n,       // 10,000 DAI
    ltv: 7500, liqThreshold: 8000, liqBonus: 10500,
    baseRate: pct(0), slope1: pct(4), slope2: pct(60), optimalUtil: (WAD * 90n) / 100n,
  },
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying to ${hre.network.name} as ${deployer.address}`);
  console.log(`Balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH\n`);

  // 1. Oracle
  const Oracle = await hre.ethers.getContractFactory("MockPriceOracle");
  const oracle = await Oracle.deploy();
  await oracle.waitForDeployment();
  console.log(`MockPriceOracle  ${await oracle.getAddress()}`);

  // 2. Pool
  const Pool = await hre.ethers.getContractFactory("Pool");
  const pool = await Pool.deploy(await oracle.getAddress());
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`Pool             ${poolAddress}`);

  // 3. Tokens + reserves
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const AToken = await hre.ethers.getContractFactory("AToken");
  const DebtToken = await hre.ethers.getContractFactory("VariableDebtToken");

  const deployed = {};
  for (const a of ASSETS) {
    const token = await MockERC20.deploy(a.name, a.symbol, a.decimals, a.faucetAmount);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    const aToken = await AToken.deploy(`Aave-like ${a.symbol}`, `a${a.symbol}`, a.decimals, poolAddress, tokenAddress);
    await aToken.waitForDeployment();

    const debtToken = await DebtToken.deploy(`Variable Debt ${a.symbol}`, `varDebt${a.symbol}`, a.decimals, poolAddress, tokenAddress);
    await debtToken.waitForDeployment();

    await (await oracle.setPrice(tokenAddress, a.priceUsd)).wait();

    await (await pool.initReserve(
      tokenAddress,
      await aToken.getAddress(),
      await debtToken.getAddress(),
      a.decimals,
      a.ltv,
      a.liqThreshold,
      a.liqBonus,
      a.baseRate,
      a.slope1,
      a.slope2,
      a.optimalUtil
    )).wait();

    deployed[a.symbol] = {
      token: tokenAddress,
      aToken: await aToken.getAddress(),
      debtToken: await debtToken.getAddress(),
      decimals: a.decimals,
    };
    console.log(`${a.symbol.padEnd(5)} token ${tokenAddress}`);
  }

  // 4. Write addresses for the other layers
  const out = {
    network: hre.network.name,
    chainId: hre.network.config.chainId ?? 31337,
    pool: poolAddress,
    oracle: await oracle.getAddress(),
    assets: deployed,
    deployedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(out, null, 2);
  fs.writeFileSync(path.join(__dirname, "..", "deployments.json"), json);

  const backendDir = path.join(__dirname, "..", "..", "backend");
  const frontendDir = path.join(__dirname, "..", "..", "frontend", "src");
  if (fs.existsSync(backendDir)) fs.writeFileSync(path.join(backendDir, "deployments.json"), json);
  if (fs.existsSync(frontendDir)) fs.writeFileSync(path.join(frontendDir, "deployments.json"), json);

  console.log(`\nAddresses written to contracts/deployments.json (and copied to backend + frontend).`);
  console.log(`Next: npm run seed:sepolia to add starter liquidity.\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
