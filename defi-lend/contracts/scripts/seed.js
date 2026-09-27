// Seeds the pool with starter liquidity from the deployer wallet so other
// users have something to borrow. Mints mock tokens (free) and supplies them.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const SEED = {
  WETH: "50",      // 50 WETH
  USDC: "100000",  // 100,000 USDC
  DAI: "100000",   // 100,000 DAI
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployments = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8")
  );

  const pool = await hre.ethers.getContractAt("Pool", deployments.pool);

  for (const [symbol, info] of Object.entries(deployments.assets)) {
    const amount = hre.ethers.parseUnits(SEED[symbol] ?? "0", info.decimals);
    if (amount === 0n) continue;

    const token = await hre.ethers.getContractAt("MockERC20", info.token);
    console.log(`Minting ${SEED[symbol]} ${symbol}...`);
    await (await token.mint(deployer.address, amount)).wait();

    console.log(`Approving Pool...`);
    await (await token.approve(deployments.pool, amount)).wait();

    console.log(`Supplying ${SEED[symbol]} ${symbol} to the pool...`);
    await (await pool.supply(info.token, amount, deployer.address)).wait();
  }

  console.log("\nDone. The pool has liquidity — users can now borrow.\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
