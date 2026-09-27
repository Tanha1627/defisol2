# Ledgerline — an Aave-style lending protocol on Sepolia

A working, end-to-end Aave-like system built for learning. **Everything runs on the Sepolia testnet with mock tokens — no real money anywhere, ever.** Test ETH for gas comes free from faucets, and the WETH/USDC/DAI here are mock tokens you mint yourself with one click.

```
defi-lend/
├── contracts/   Solidity + Hardhat  (Pool, aTokens, debt tokens, oracle, mock tokens)
├── backend/     Node.js             (REST API, event listener, WebSocket push)
└── frontend/    React + Vite        (connect wallet, dashboard, markets, actions)
```

What it actually implements, faithfully to Aave v3's design:

- **Supply → receive aTokens** whose balance grows every second via a *liquidity index* (scaled balances, exactly Aave's mechanism)
- **Borrow → receive variable debt tokens** that grow via a *borrow index*
- **Utilization-based interest rates**: base rate + slope1 up to the optimal utilization "kink", steep slope2 beyond it
- **LTV vs liquidation threshold**, weighted across all your collateral
- **Health factor**, and public **liquidations with a bonus** when it drops below 1
- **Withdraw / repay**, including "max" flows that clear positions cleanly

Deliberately left out (so the core stays readable): flash loans, stable-rate borrows, e-mode/isolation mode, treasury reserve factor, and per-second compounding (interest accrues linearly between interactions — the indexes and everything downstream work identically).

---

## 0. Prerequisites (10 minutes, all free)

1. **Node.js 18+** — check with `node -v`
2. **MetaMask** browser extension — [metamask.io](https://metamask.io)
3. **A throwaway test wallet.** In MetaMask, create a *new* account you'll use only for this. You will paste its private key into a `.env` file for deployment, so it must never hold real funds.
4. **Sepolia ETH for gas.** Get some free from any of these faucets (0.05–0.5 ETH is plenty for deploying and dozens of transactions):
   - Google Cloud Web3 faucet: https://cloud.google.com/application/web3/faucet/ethereum/sepolia
   - Alchemy faucet: https://sepoliafaucet.com
   - Chainlink faucet: https://faucets.chain.link/sepolia
5. **A Sepolia RPC URL.** Create a free app at [alchemy.com](https://www.alchemy.com) or [infura.io](https://www.infura.io) and copy its Sepolia HTTPS endpoint. (The public `https://rpc.sepolia.org` also works but is flakier.)

To find the private key in MetaMask: account menu → Account details → Show private key.

---

## 1. Deploy the smart contracts

```bash
cd contracts
npm install

cp .env.example .env
# edit .env: paste your SEPOLIA_RPC_URL and the throwaway wallet's PRIVATE_KEY

npx hardhat compile

# Optional but recommended — run the test suite locally first:
npx hardhat test

# Deploy everything to Sepolia (~1-2 minutes, costs a little test ETH):
npm run deploy:sepolia

# Seed the pool with starter liquidity so borrowing works immediately:
npm run seed:sepolia
```

The deploy script:

- deploys the **MockPriceOracle** and sets prices (WETH $3,000 · USDC $1 · DAI $1)
- deploys the **Pool**
- for each asset, deploys the **mock token** (with a public faucet), its **aToken** and its **debt token**, then registers the reserve with its risk parameters
- writes every address to `contracts/deployments.json` **and copies it into `backend/` and `frontend/src/`** — the other layers pick them up automatically, no copy-pasting addresses.

Keep the printed addresses; you can look at every contract on https://sepolia.etherscan.io.

---

## 2. Run the backend

```bash
cd ../backend
npm install

cp .env.example .env
# edit .env: same SEPOLIA_RPC_URL (no private key here — the backend only reads)

npm start
```

You should see `API + WebSocket on http://localhost:3001`. Sanity-check it:

- http://localhost:3001/api/health
- http://localhost:3001/api/markets — live rates, utilization and liquidity straight from the chain

The backend also listens for `Supply / Borrow / Repay / Withdraw / LiquidationCall` events, logs them to `backend/transactions.json` (a stand-in for MongoDB), and pushes them over WebSocket so the UI refreshes the moment a transaction lands.

---

## 3. Run the frontend

```bash
cd ../frontend
npm install
npm run dev
```

Open http://localhost:5173, click **Connect wallet**, and approve. The app switches MetaMask to Sepolia automatically (adding the network if needed).

> Use any MetaMask account here — it doesn't need to be the deployer. Each user just needs a little faucet ETH for gas.

---

## 4. Try the full lending lifecycle

1. **Faucet** — on the WETH row, click *Faucet* and confirm. You just minted 10 test WETH to your wallet. Do the same for USDC if you like.
2. **Supply** — supply 1 WETH. Two wallet confirmations: an ERC-20 *approve*, then the *supply*. You now hold 1 aWETH and your dashboard shows $3,000 of collateral.
3. **Borrow** — borrow, say, 1,500 USDC. Your health factor drops (80% threshold × $3,000 ÷ $1,500 = 1.60). The borrow APY you see is live, computed from pool utilization.
4. **Watch interest accrue** — come back in an hour or a day. Your aWETH balance and your USDC debt have both grown, with no transaction needed: the indexes accrue continuously and balances are rescaled on every read.
5. **Repay** — click *Repay* → *max*. It approves a little extra headroom because debt keeps growing between blocks, then clears the whole position.
6. **Withdraw** — *Withdraw* → *max* returns your WETH plus earned interest. Try withdrawing while you still have debt: the contract rejects anything that would push your health factor below 1.

### Bonus: trigger a liquidation (the fun part)

The oracle is owner-settable, so you can simulate a price crash from `contracts/`:

```bash
npx hardhat console --network sepolia
```

```js
const d = require("./deployments.json");
const oracle = await ethers.getContractAt("MockPriceOracle", d.oracle);
await oracle.setPrice(d.assets.WETH.token, 2000n * 10n ** 8n); // WETH: $3,000 → $2,000
```

Any position that borrowed near its limit now has a health factor below 1. From a *second* MetaMask account (the liquidator), or the console:

```js
const pool = await ethers.getContractAt("Pool", d.pool);
const usdc = await ethers.getContractAt("MockERC20", d.assets.USDC.token);
await usdc.mint("<liquidator>", 1000n * 10n ** 6n);
await usdc.approve(d.pool, 1000n * 10n ** 6n);
await pool.liquidationCall(d.assets.WETH.token, d.assets.USDC.token, "<underwater user>", 1000n * 10n ** 6n);
```

The liquidator repays up to 50% of the debt and seizes WETH worth 105% of what they repaid. Don't forget to set the price back.

---

## How the pieces talk to each other

```
MetaMask ──signs tx──▶ Sepolia ──▶ Pool.sol ──emits events──▶ backend listener
    ▲                                 │                             │
    │                                 │ view calls                  ├─▶ transactions.json
frontend ◀──REST /api/markets, /api/user── backend ◀────────────────┘
    ▲                                                               │
    └───────────────── WebSocket push (instant refresh) ◀───────────┘
```

- **Reads are free**: the backend and dashboard call `view` functions — no gas.
- **Writes cost (test) gas**: supply/borrow/repay/withdraw are real Sepolia transactions signed in MetaMask. Private keys never leave the wallet; the backend holds no keys at all.
- **Interest needs no keeper**: `getNormalizedIncome`/`getNormalizedDebt` project the indexes to "now" on every read, and any state-changing call snapshots them first.

## Where this maps onto real Aave

| Here | Aave v3 |
|---|---|
| `Pool.sol` | `Pool.sol` + `PoolConfigurator` + libraries |
| `AToken` scaled balances vs `liquidityIndex` | identical mechanism (Aave uses 1e27 "ray", we use 1e18) |
| `VariableDebtToken` vs `variableBorrowIndex` | identical mechanism |
| base + slope1/slope2 around a kink | `DefaultReserveInterestRateStrategy` |
| `MockPriceOracle` (1e8 USD) | `AaveOracle` wrapping Chainlink feeds (same 1e8 convention — drop-in swap) |
| linear accrual between touches | compounded-per-second accrual |

## Troubleshooting

- **"insufficient funds for gas"** — the wallet you're using needs Sepolia ETH from a faucet (step 0.4). The deployer and each frontend user need their own.
- **Deploy hangs or times out** — public RPCs throttle; use a free Alchemy/Infura endpoint.
- **"Backend unreachable" banner** — start the backend (step 2), or set `VITE_API_URL` in `frontend/.env` if you changed the port.
- **Frontend shows empty markets** — the deploy script copies `deployments.json` into `frontend/src/`; if you deployed before creating the frontend folder, re-run `npm run deploy:sepolia` or copy the file manually, then restart `npm run dev`.
- **"Pool: not enough liquidity" when borrowing** — run `npm run seed:sepolia`, or supply that asset yourself first.
- **Repay "max" fails** — the approve needs headroom above the displayed debt (it grows every second). The UI approves extra automatically; in scripts, approve ~1% more.
- **MetaMask nonce errors after redeploying** — Settings → Advanced → Clear activity tab data.

## Next steps

This is the foundation the architecture diagrams build on. Natural extensions, in order: swap `MockPriceOracle` for real Chainlink Sepolia feeds → replace the JSON store with MongoDB + Redis exactly as in the diagram → add The Graph subgraph for history → then bolt the AI agent layer (FastAPI + policy) onto the same `/api` surface and events.
