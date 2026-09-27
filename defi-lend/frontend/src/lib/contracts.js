import { ethers } from "ethers";
import deployments from "../deployments.json";

export const SEPOLIA_CHAIN_ID = 11155111;
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";
export { deployments };

export const POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount)",
  "function repay(address asset, uint256 amount, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet()",
];

export function hasWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectWallet() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  await ensureSepolia();
  return accounts[0];
}

export async function ensureSepolia() {
  const chainIdHex = "0x" + SEPOLIA_CHAIN_ID.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    // 4902 = chain not added to the wallet yet
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainIdHex,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.sepolia.org"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        }],
      });
    } else {
      throw err;
    }
  }
}

export async function getSigner() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  return provider.getSigner();
}

export async function poolWithSigner() {
  return new ethers.Contract(deployments.pool, POOL_ABI, await getSigner());
}

export async function tokenWithSigner(address) {
  return new ethers.Contract(address, ERC20_ABI, await getSigner());
}

/** Approve `spender` for at least `amount`, skipping if allowance suffices. */
export async function ensureAllowance(tokenAddress, owner, spender, amount) {
  const token = await tokenWithSigner(tokenAddress);
  const current = await token.allowance(owner, spender);
  if (current >= amount) return null;
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait();
  return tx.hash;
}

export const fmt = (n, dp = 2) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });

export const explorerTx = (hash) => `https://sepolia.etherscan.io/tx/${hash}`;
