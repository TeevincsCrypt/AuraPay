import { parseAbi } from "viem";

/** Everything here runs on Polygon PoS (chainId 137 / 0x89). */
export const POLYGON = { chainId: 137, chainIdHex: "0x89", explorer: "https://polygonscan.com" } as const;

export const TOKENS = {
  USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const, decimals: 6, symbol: "USDT" },
  /** Aave V3 interest-bearing USDT (1:1 with supplied USDT plus accrued interest). */
  aPolUSDT: { address: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620" as const, decimals: 6, symbol: "aPolUSDT" },
} as const;

/** Aave V3 Pool (Polygon). */
export const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;
/** QuickSwap V2 router (Uniswap V2 compatible). */
export const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" as const;

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  // ReserveDataLegacy (stable across Aave V3.x)
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

export const V2_ROUTER_ABI = parseAbi([
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
export const V2_FACTORY_ABI = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);
export const V2_PAIR_ABI = parseAbi(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)"]);

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Aave stores rates as RAY (1e27) per year, compounded per second. */
export function aaveApy(currentLiquidityRateRay: bigint): number {
  const SECONDS = 31_536_000;
  const apr = Number(currentLiquidityRateRay) / 1e27;
  return Math.pow(1 + apr / SECONDS, SECONDS) - 1;
}

export function toUnits(amount: string | number, decimals: number): bigint {
  const [i, f = ""] = String(amount).trim().split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error("Invalid amount");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export function fromUnits(units: bigint, decimals: number): number {
  return Number(units) / 10 ** decimals;
}
