import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_URL, connectWallet, hasWallet, fmt, deployments,
} from "./lib/contracts";
import ActionModal from "./components/ActionModal";

export default function App() {
  const [address, setAddress] = useState(null);
  const [user, setUser] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [txs, setTxs] = useState([]);
  const [modal, setModal] = useState(null); // { action, market }
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  const refresh = useCallback(async (addr) => {
    try {
      const [m, u, t] = await Promise.all([
        fetch(`${API_URL}/api/markets`).then((r) => r.json()),
        addr ? fetch(`${API_URL}/api/user/${addr}`).then((r) => r.json()) : null,
        addr ? fetch(`${API_URL}/api/transactions/${addr}`).then((r) => r.json()) : [],
      ]);
      setMarkets(Array.isArray(m) ? m : []);
      if (u && !u.error) setUser(u);
      if (Array.isArray(t)) setTxs(t);
      setError(null);
    } catch {
      setError("Backend unreachable — is it running on " + API_URL + "?");
    }
  }, []);

  // initial + polling refresh
  useEffect(() => {
    refresh(address);
    const id = setInterval(() => refresh(address), 15000);
    return () => clearInterval(id);
  }, [address, refresh]);

  // live push from backend event listener
  useEffect(() => {
    const ws = new WebSocket(API_URL.replace(/^http/, "ws"));
    ws.onmessage = () => refresh(address);
    wsRef.current = ws;
    return () => ws.close();
  }, [address, refresh]);

  // react to account changes in the wallet
  useEffect(() => {
    if (!hasWallet()) return;
    const onAccounts = (accs) => setAddress(accs[0] ?? null);
    window.ethereum.on("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener("accountsChanged", onAccounts);
  }, []);

  const onConnect = async () => {
    try {
      setAddress(await connectWallet());
    } catch (e) {
      setError(e.shortMessage || e.message);
    }
  };

  const hf = user?.healthFactor;
  const hfClass = hf == null ? "hf-none" : hf >= 2 ? "hf-good" : hf >= 1.1 ? "hf-warn" : "hf-danger";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⌁</span> Ledgerline
          <span className="net-pill">Sepolia testnet · no real funds</span>
        </div>
        {address ? (
          <div className="addr">{address.slice(0, 6)}…{address.slice(-4)}</div>
        ) : (
          <button className="btn btn-primary" onClick={onConnect} disabled={!hasWallet()}>
            {hasWallet() ? "Connect wallet" : "Install MetaMask"}
          </button>
        )}
      </header>

      {error && <div className="banner">{error}</div>}

      {!address ? (
        <section className="landing">
          <h1>Lend, borrow, and get liquidated —<br />safely, with fake money.</h1>
          <p>
            An Aave-style pool deployed to Sepolia. Mint free test tokens, supply them
            as collateral, borrow against it, and watch interest accrue block by block.
          </p>
          <button className="btn btn-primary btn-lg" onClick={onConnect} disabled={!hasWallet()}>
            {hasWallet() ? "Connect wallet to start" : "Install MetaMask first"}
          </button>
        </section>
      ) : (
        <>
          <section className="stats">
            <Stat label="Your collateral" value={`$${fmt(user?.totalCollateralUsd ?? 0)}`} />
            <Stat label="Your debt" value={`$${fmt(user?.totalDebtUsd ?? 0)}`} />
            <Stat label="Can still borrow" value={`$${fmt(user?.availableBorrowsUsd ?? 0)}`} />
            <div className={`stat ${hfClass}`}>
              <div className="stat-label">Health factor</div>
              <div className="stat-value">{hf == null ? "∞" : fmt(hf, 2)}</div>
              <div className="stat-sub">{hf != null && hf < 1 ? "liquidatable" : "liquidation below 1.00"}</div>
            </div>
          </section>

          <section>
            <h2>Markets</h2>
            <table className="markets">
              <thead>
                <tr>
                  <th>Asset</th><th>Price</th><th>Supply APY</th><th>Borrow APY</th>
                  <th>Utilization</th><th>Wallet</th><th>Supplied</th><th>Borrowed</th><th></th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => {
                  const pos = user?.positions?.find((p) => p.symbol === m.symbol);
                  return (
                    <tr key={m.symbol}>
                      <td className="sym">{m.symbol}</td>
                      <td>${fmt(m.priceUsd)}</td>
                      <td className="apy">{fmt(m.supplyApy, 2)}%</td>
                      <td className="apy">{fmt(m.borrowApy, 2)}%</td>
                      <td>{fmt(m.utilizationPct, 1)}%</td>
                      <td>{fmt(pos?.walletBalance ?? 0, 4)}</td>
                      <td>{fmt(pos?.supplied ?? 0, 4)}</td>
                      <td>{fmt(pos?.borrowed ?? 0, 4)}</td>
                      <td className="actions">
                        <button className="btn btn-ghost" onClick={() => setModal({ action: "faucet", market: m })}>Faucet</button>
                        <button className="btn" onClick={() => setModal({ action: "supply", market: m })}>Supply</button>
                        <button className="btn" onClick={() => setModal({ action: "borrow", market: m })}>Borrow</button>
                        {Number(pos?.borrowed) > 0 && (
                          <button className="btn" onClick={() => setModal({ action: "repay", market: m })}>Repay</button>
                        )}
                        {Number(pos?.supplied) > 0 && (
                          <button className="btn" onClick={() => setModal({ action: "withdraw", market: m })}>Withdraw</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {txs.length > 0 && (
            <section>
              <h2>Your recent activity</h2>
              <ul className="txlist">
                {txs.slice(0, 8).map((t) => (
                  <li key={t.txHash + t.type}>
                    <span className={`tag tag-${t.type}`}>{t.type}</span>
                    {fmt(t.amount, 4)} {t.asset}
                    <a href={`https://sepolia.etherscan.io/tx/${t.txHash}`} target="_blank" rel="noreferrer">view tx</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {modal && (
        <ActionModal
          {...modal}
          address={address}
          user={user}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); refresh(address); }}
        />
      )}

      <footer>
        Pool <code>{deployments.pool}</code> · every action here is a Sepolia transaction with zero real value
      </footer>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
