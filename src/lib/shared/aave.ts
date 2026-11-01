/**
 * Aave V4 on Base — "Equities" hub / "MAG7" spoke, which lends USDC against
 * Coinbase tokenised stocks (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, TSLAc).
 *
 * Addresses: bgd-labs/aave-address-book src/AaveV4Base.sol (AaveV4BaseSpokes, AaveV4BaseHubs).
 * ABI fragments transcribed from aave/aave-v4 src/spoke/interfaces/ISpoke.sol,
 * src/spoke/interfaces/IAaveOracle.sol and src/hub/interfaces/IHub.sol.
 *
 * Units (aave-v4 SpokeUtils): Value = 1e26 per USD; debt value is additionally RAY (1e27)
 * scaled; health factor and average collateral factor are WAD (1e18); collateral factor
 * and risk premium are BPS; oracle prices have 8 decimals; drawn rate is RAY per year.
 */

import { STOCK_TOKENS } from "./stock-tokens";

export const AAVE_CHAIN_ID = 8453;
export const AAVE_CHAIN_HEX = "0x2105";
export const AAVE_MAG7_SPOKE = "0x17905Db0e4A3514467539956c084180616AE7B8D" as const;
export const AAVE_MAG7_ORACLE = "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47" as const;
export const AAVE_EQUITIES_HUB = "0xa4d5947Eb727A052bae69C593FfC84247EC9864E" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const VALUE_PER_USD = 10n ** 26n;
export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;

const reserveTuple = {
  type: "tuple",
  components: [
    { name: "underlying", type: "address" },
    { name: "hub", type: "address" },
    { name: "assetId", type: "uint16" },
    { name: "decimals", type: "uint8" },
    { name: "collateralRisk", type: "uint24" },
    { name: "flags", type: "uint8" },
    { name: "dynamicConfigKey", type: "uint32" },
  ],
} as const;

const amountFn = (name: "supply" | "withdraw" | "borrow" | "repay") =>
  ({
    type: "function",
    name,
    stateMutability: "nonpayable",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  }) as const;

export const SPOKE_ABI = [
  { type: "function", name: "getReserveCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getReserve", stateMutability: "view", inputs: [{ name: "reserveId", type: "uint256" }], outputs: [{ name: "", ...reserveTuple }] },
  {
    type: "function",
    name: "getReserveConfig",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collateralRisk", type: "uint24" },
          { name: "paused", type: "bool" },
          { name: "frozen", type: "bool" },
          { name: "borrowable", type: "bool" },
          { name: "receiveSharesEnabled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDynamicReserveConfig",
    stateMutability: "view",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "dynamicConfigKey", type: "uint32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collateralFactor", type: "uint16" },
          { name: "maxLiquidationBonus", type: "uint32" },
          { name: "liquidationFee", type: "uint16" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "riskPremium", type: "uint256" },
          { name: "avgCollateralFactor", type: "uint256" },
          { name: "healthFactor", type: "uint256" },
          { name: "totalCollateralValue", type: "uint256" },
          { name: "totalDebtValueRay", type: "uint256" },
          { name: "activeCollateralCount", type: "uint256" },
          { name: "borrowCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getUserSuppliedAssets",
    stateMutability: "view",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getUserTotalDebt",
    stateMutability: "view",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getUserReserveStatus",
    stateMutability: "view",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "bool" },
    ],
  },
  amountFn("supply"),
  amountFn("withdraw"),
  amountFn("borrow"),
  amountFn("repay"),
  {
    type: "function",
    name: "setUsingAsCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "usingAsCollateral", type: "bool" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
] as const;

export const ORACLE_ABI = [
  {
    type: "function",
    name: "getReservesPrices",
    stateMutability: "view",
    inputs: [{ name: "reserveIds", type: "uint256[]" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

export const HUB_ABI = [
  {
    type: "function",
    name: "getAssetDrawnRate",
    stateMutability: "view",
    inputs: [{ name: "assetId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Stock ticker for an Aave reserve, identified by its underlying token address in the
 * tokenised-stock registry (never guessed from the symbol: "USDC" also ends in "C").
 */
export function tickerForReserve(underlying: string): string | null {
  const u = underlying.toLowerCase();
  for (const [ticker, reg] of Object.entries(STOCK_TOKENS)) {
    if (reg.all.some((t) => t.chainId === AAVE_CHAIN_ID && t.address.toLowerCase() === u)) return ticker;
  }
  return null;
}
