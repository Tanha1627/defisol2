const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const WAD = 10n ** 18n;
const pct = (n) => (WAD * BigInt(n)) / 100n;

describe("Pool", () => {
  let deployer, alice, bob, liquidator;
  let oracle, pool, weth, usdc, aWeth, aUsdc, debtUsdc;

  const wethAmt = (n) => ethers.parseUnits(n, 18);
  const usdcAmt = (n) => ethers.parseUnits(n, 6);

  beforeEach(async () => {
    [deployer, alice, bob, liquidator] = await ethers.getSigners();

    oracle = await (await ethers.getContractFactory("MockPriceOracle")).deploy();
    pool = await (await ethers.getContractFactory("Pool")).deploy(await oracle.getAddress());

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20.deploy("Mock WETH", "WETH", 18, wethAmt("10"));
    usdc = await MockERC20.deploy("Mock USDC", "USDC", 6, usdcAmt("10000"));

    const AToken = await ethers.getContractFactory("AToken");
    const DebtToken = await ethers.getContractFactory("VariableDebtToken");
    const poolAddr = await pool.getAddress();

    aWeth = await AToken.deploy("aWETH", "aWETH", 18, poolAddr, await weth.getAddress());
    const debtWeth = await DebtToken.deploy("dWETH", "dWETH", 18, poolAddr, await weth.getAddress());
    aUsdc = await AToken.deploy("aUSDC", "aUSDC", 6, poolAddr, await usdc.getAddress());
    debtUsdc = await DebtToken.deploy("dUSDC", "dUSDC", 6, poolAddr, await usdc.getAddress());

    await oracle.setPrice(await weth.getAddress(), 3000_00000000n); // $3000
    await oracle.setPrice(await usdc.getAddress(), 1_00000000n);    // $1

    await pool.initReserve(await weth.getAddress(), await aWeth.getAddress(), await debtWeth.getAddress(),
      18, 7500, 8000, 10500, pct(0), pct(4), pct(75), (WAD * 80n) / 100n);
    await pool.initReserve(await usdc.getAddress(), await aUsdc.getAddress(), await debtUsdc.getAddress(),
      6, 8000, 8500, 10400, pct(0), pct(4), pct(60), (WAD * 90n) / 100n);

    // Bob seeds USDC liquidity so Alice can borrow it
    await usdc.mint(bob.address, usdcAmt("50000"));
    await usdc.connect(bob).approve(poolAddr, usdcAmt("50000"));
    await pool.connect(bob).supply(await usdc.getAddress(), usdcAmt("50000"), bob.address);
  });

  it("supplies and mints aTokens 1:1 at the start", async () => {
    await weth.connect(alice).faucet();
    await weth.connect(alice).approve(await pool.getAddress(), wethAmt("1"));
    await pool.connect(alice).supply(await weth.getAddress(), wethAmt("1"), alice.address);
    expect(await aWeth.balanceOf(alice.address)).to.equal(wethAmt("1"));

    const data = await pool.getUserAccountData(alice.address);
    expect(data.totalCollateralBase).to.equal(3000_00000000n); // $3000
  });

  it("borrows within LTV and blocks borrows beyond it", async () => {
    await weth.connect(alice).faucet();
    await weth.connect(alice).approve(await pool.getAddress(), wethAmt("1"));
    await pool.connect(alice).supply(await weth.getAddress(), wethAmt("1"), alice.address);

    // 75% LTV on $3000 => $2250 max
    await pool.connect(alice).borrow(await usdc.getAddress(), usdcAmt("2000"));
    expect(await usdc.balanceOf(alice.address)).to.equal(usdcAmt("2000"));

    await expect(
      pool.connect(alice).borrow(await usdc.getAddress(), usdcAmt("500"))
    ).to.be.revertedWith("Pool: collateral cannot cover borrow");
  });

  it("accrues interest for suppliers and borrowers over time", async () => {
    await weth.connect(alice).faucet();
    await weth.connect(alice).approve(await pool.getAddress(), wethAmt("1"));
    await pool.connect(alice).supply(await weth.getAddress(), wethAmt("1"), alice.address);
    await pool.connect(alice).borrow(await usdc.getAddress(), usdcAmt("2000"));

    const debtBefore = await debtUsdc.balanceOf(alice.address);
    const supplyBefore = await aUsdc.balanceOf(bob.address);

    await network.provider.send("evm_increaseTime", [365 * 24 * 3600]); // 1 year
    await network.provider.send("evm_mine");

    expect(await debtUsdc.balanceOf(alice.address)).to.be.gt(debtBefore);
    expect(await aUsdc.balanceOf(bob.address)).to.be.gt(supplyBefore);
  });

  it("repays in full with max uint and frees collateral for withdrawal", async () => {
    await weth.connect(alice).faucet();
    await weth.connect(alice).approve(await pool.getAddress(), wethAmt("1"));
    await pool.connect(alice).supply(await weth.getAddress(), wethAmt("1"), alice.address);
    await pool.connect(alice).borrow(await usdc.getAddress(), usdcAmt("1000"));

    // Withdrawing all collateral while in debt must fail
    await expect(
      pool.connect(alice).withdraw(await weth.getAddress(), ethers.MaxUint256, alice.address)
    ).to.be.revertedWith("Pool: withdrawal breaks health factor");

    await usdc.mint(alice.address, usdcAmt("100")); // cover accrued interest
    await usdc.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(alice).repay(await usdc.getAddress(), ethers.MaxUint256, alice.address);
    expect(await debtUsdc.balanceOf(alice.address)).to.equal(0n);

    await pool.connect(alice).withdraw(await weth.getAddress(), ethers.MaxUint256, alice.address);
    expect(await aWeth.balanceOf(alice.address)).to.equal(0n);
  });

  it("liquidates an unhealthy position with a bonus", async () => {
    await weth.connect(alice).faucet();
    await weth.connect(alice).approve(await pool.getAddress(), wethAmt("1"));
    await pool.connect(alice).supply(await weth.getAddress(), wethAmt("1"), alice.address);
    await pool.connect(alice).borrow(await usdc.getAddress(), usdcAmt("2000"));

    // WETH crashes to $2000: debt $2000 vs threshold 80% x $2000 = $1600 => HF < 1
    await oracle.setPrice(await weth.getAddress(), 2000_00000000n);
    const hf = (await pool.getUserAccountData(alice.address)).healthFactor;
    expect(hf).to.be.lt(WAD);

    await usdc.mint(liquidator.address, usdcAmt("1000"));
    await usdc.connect(liquidator).approve(await pool.getAddress(), usdcAmt("1000"));
    await pool.connect(liquidator).liquidationCall(
      await weth.getAddress(), await usdc.getAddress(), alice.address, usdcAmt("1000")
    );

    // Liquidator receives $1000 x 1.05 = $1050 of WETH at $2000 => 0.525 WETH
    expect(await weth.balanceOf(liquidator.address)).to.equal(wethAmt("0.525"));
  });
});
