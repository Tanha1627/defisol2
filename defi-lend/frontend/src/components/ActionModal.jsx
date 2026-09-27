import { useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  deployments, poolWithSigner, tokenWithSigner, ensureAllowance, fmt, explorerTx,
} from "../lib/contracts";

const TITLES = {
  faucet: "Get test tokens",
  supply: "Supply",
  borrow: "Borrow",
  repay: "Repay",
  withdraw: "Withdraw",
};

export default function ActionModal({ action, market, address, user, onClose, onDone }) {
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState(null); // null | string
  const [txHash, setTxHash] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const asset = deployments.assets[market.symbol];
  const pos = user?.positions?.find((p) => p.symbol === market.symbol);

  const maxHint = useMemo(() => {
    switch (action) {
      case "supply": return { label: "wallet balance", value: pos?.walletBalance };
      case "withdraw": return { label: "supplied", value: pos?.supplied };
      case "repay": return { label: "your debt", value: pos?.borrowed };
      case "borrow": {
        const usd = user?.availableBorrowsUsd ?? 0;
        return { label: "borrow limit", value: (usd / market.priceUsd) * 0.99 }; // 1% headroom
      }
      default: return null;
    }
  }, [action, pos, user, market]);

  const run = async () => {
    setErr(null); setBusy(true);
    try {
      const pool = await poolWithSigner();
      let tx;

      if (action === "faucet") {
        setStatus("Confirm the mint in your wallet…");
        const token = await tokenWithSigner(asset.token);
        tx = await token.faucet();
      } else {
        const useMax = amount === "" || Number(amount) >= Number(maxHint?.value ?? Infinity);
        const parsed = useMax && (action === "withdraw" || action === "repay")
          ? ethers.MaxUint256
          : ethers.parseUnits(amount || "0", asset.decimals);
        if (parsed === 0n) throw new Error("Enter an amount");

        if (action === "supply" || action === "repay") {
          setStatus("Step 1/2 — approving the Pool to pull your tokens…");
          await ensureAllowance(asset.token, address, deployments.pool, 
            parsed === ethers.MaxUint256 ? ethers.parseUnits(maxHint.value, asset.decimals) * 2n : parsed);
          setStatus("Step 2/2 — confirm the transaction in your wallet…");
        } else {
          setStatus("Confirm the transaction in your wallet…");
        }

        if (action === "supply") tx = await pool.supply(asset.token, parsed, address);
        if (action === "borrow") tx = await pool.borrow(asset.token, parsed);
        if (action === "repay") tx = await pool.repay(asset.token, parsed, address);
        if (action === "withdraw") tx = await pool.withdraw(asset.token, parsed, address);
      }

      setTxHash(tx.hash);
      setStatus("Waiting for Sepolia to confirm…");
      await tx.wait();
      setStatus("Confirmed ✔");
      setTimeout(onDone, 900);
    } catch (e) {
      setErr(e.reason || e.shortMessage || e.message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{TITLES[action]} {market.symbol}</h3>

        {action === "faucet" ? (
          <p className="muted">
            Mints a fixed allotment of test {market.symbol} straight to your wallet.
            Free, other than a little Sepolia ETH for gas.
          </p>
        ) : (
          <>
            <div className="field">
              <input
                type="number" min="0" placeholder="0.0" value={amount}
                onChange={(e) => setAmount(e.target.value)} disabled={busy}
              />
              <span className="unit">{market.symbol}</span>
            </div>
            {maxHint?.value != null && (
              <button className="linkish" disabled={busy}
                onClick={() => setAmount(String(Number(Number(maxHint.value).toFixed(6))))}>
                max — {fmt(maxHint.value, 4)} ({maxHint.label})
              </button>
            )}
            <dl className="facts">
              {action === "supply" && <><dt>You receive</dt><dd>a{market.symbol}, growing at {fmt(market.supplyApy, 2)}% APY</dd></>}
              {action === "borrow" && <><dt>Interest</dt><dd>{fmt(market.borrowApy, 2)}% APY, accrues every second</dd></>}
              {action === "repay" && <><dt>Tip</dt><dd>use max to clear the debt — interest grows between blocks</dd></>}
              {action === "withdraw" && <><dt>Note</dt><dd>blocked if it would drop your health factor below 1</dd></>}
            </dl>
          </>
        )}

        {status && <div className="status">{status}{txHash && <> · <a href={explorerTx(txHash)} target="_blank" rel="noreferrer">Etherscan</a></>}</div>}
        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? "Working…" : TITLES[action]}
          </button>
        </div>
      </div>
    </div>
  );
}
