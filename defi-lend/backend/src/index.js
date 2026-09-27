// Backend layer: REST API + blockchain event listener + WebSocket push.
// Reads on-chain state through a read-only provider (never holds keys),
// mirrors protocol events into a local JSON file, and pushes live updates
// to connected browsers. Swap the JSON file for MongoDB/Redis later if you like.

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { WebSocketServer } from "ws";
import "dotenv/config";
import { POOL_ABI, ERC20_ABI } from "./abis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");
const DB_PATH = path.join(__dirname, "..", "transactions.json");

if (!fs.existsSync(DEPLOYMENTS_PATH)) {
  console.error("deployments.json not found. Run the deploy script in /contracts first.");
  process.exit(1);
}
const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));

const RPC_URL = process.env.SEPOLIA_RPC_URL;
if (!RPC_URL) {
  console.error("Set SEPOLIA_RPC_URL in backend/.env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const pool = new ethers.Contract(deployments.pool, POOL_ABI, provider);

const symbolByToken = Object.fromEntries(
  Object.entries(deployments.assets).map(([sym, a]) => [a.token.toLowerCase(), sym])
);

// ---------- tiny JSON "database" ----------
let db = { transactions: [] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch { /* start fresh */ }
}
const saveDb = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// ---------- helpers ----------
const RAY_LIKE = 1e18;
const toApyPct = (annualRateWad) => (Number(annualRateWad) / RAY_LIKE) * 100;

async function fetchMarkets() {
  const markets = [];
  for (const [symbol, a] of Object.entries(deployments.assets)) {
    const [r, price] = await Promise.all([
      pool.getReserveData(a.token),
      pool.oracle().then((o) => new ethers.Contract(o, ["function getPrice(address) view returns (uint256)"], provider).getPrice(a.token)),
    ]);
    markets.push({
      symbol,
      asset: a.token,
      aToken: r.aToken,
      debtToken: r.debtToken,
      decimals: a.decimals,
      priceUsd: Number(price) / 1e8,
      supplyApy: toApyPct(r.liquidityRate),
      borrowApy: toApyPct(r.variableBorrowRate),
      totalSupplied: ethers.formatUnits(r.totalSupplied, a.decimals),
      totalBorrowed: ethers.formatUnits(r.totalBorrowed, a.decimals),
      availableLiquidity: ethers.formatUnits(r.availableLiquidity, a.decimals),
      utilizationPct: (Number(r.utilization) / RAY_LIKE) * 100,
      ltvPct: Number(r.ltv) / 100,
      liquidationThresholdPct: Number(r.liquidationThreshold) / 100,
    });
  }
  return markets;
}

async function fetchUser(address) {
  const data = await pool.getUserAccountData(address);
  const positions = [];
  for (const [symbol, a] of Object.entries(deployments.assets)) {
    const aToken = new ethers.Contract(a.aToken, ERC20_ABI, provider);
    const debtToken = new ethers.Contract(a.debtToken, ERC20_ABI, provider);
    const wallet = new ethers.Contract(a.token, ERC20_ABI, provider);
    const [supplied, borrowed, walletBal] = await Promise.all([
      aToken.balanceOf(address),
      debtToken.balanceOf(address),
      wallet.balanceOf(address),
    ]);
    positions.push({
      symbol,
      supplied: ethers.formatUnits(supplied, a.decimals),
      borrowed: ethers.formatUnits(borrowed, a.decimals),
      walletBalance: ethers.formatUnits(walletBal, a.decimals),
    });
  }

  const MAX = 2n ** 256n - 1n;
  return {
    address,
    totalCollateralUsd: Number(data.totalCollateralBase) / 1e8,
    totalDebtUsd: Number(data.totalDebtBase) / 1e8,
    availableBorrowsUsd: Number(data.availableBorrowsBase) / 1e8,
    ltvPct: Number(data.ltv) / 100,
    liquidationThresholdPct: Number(data.currentLiquidationThreshold) / 100,
    healthFactor: data.healthFactor === MAX ? null : Number(data.healthFactor) / RAY_LIKE,
    positions,
  };
}

// ---------- REST API ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true, network: deployments.network, pool: deployments.pool }));

app.get("/api/markets", async (_req, res) => {
  try { res.json(await fetchMarkets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/user/:address", async (req, res) => {
  try {
    if (!ethers.isAddress(req.params.address)) return res.status(400).json({ error: "invalid address" });
    res.json(await fetchUser(req.params.address));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/transactions/:address", (req, res) => {
  const addr = req.params.address.toLowerCase();
  res.json(db.transactions.filter((t) => t.user.toLowerCase() === addr).slice(-50).reverse());
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ---------- Event listener ----------
function record(type, user, asset, amountRaw, event) {
  const symbol = symbolByToken[asset.toLowerCase()] ?? asset;
  const decimals = deployments.assets[symbol]?.decimals ?? 18;
  const tx = {
    type,
    user,
    asset: symbol,
    amount: ethers.formatUnits(amountRaw, decimals),
    txHash: event.log.transactionHash,
    block: event.log.blockNumber,
    timestamp: new Date().toISOString(),
  };
  db.transactions.push(tx);
  saveDb();
  broadcast({ kind: "protocol_event", ...tx });
  console.log(`[event] ${type} ${tx.amount} ${symbol} by ${user}`);
}

pool.on("Supply", (asset, user, onBehalfOf, amount, event) => record("supply", onBehalfOf, asset, amount, event));
pool.on("Withdraw", (asset, user, _to, amount, event) => record("withdraw", user, asset, amount, event));
pool.on("Borrow", (asset, user, amount, _rate, event) => record("borrow", user, asset, amount, event));
pool.on("Repay", (asset, user, _repayer, amount, event) => record("repay", user, asset, amount, event));
pool.on("LiquidationCall", (collateral, _debtAsset, user, _debtCovered, seized, _liquidator, event) =>
  record("liquidation", user, collateral, seized, event)
);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`API + WebSocket on http://localhost:${PORT}`);
  console.log(`Watching Pool ${deployments.pool} on ${deployments.network}`);
});
