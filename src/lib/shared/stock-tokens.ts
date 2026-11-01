/**
 * Tokenised-stock registry (generated from CoW Protocol's RWA registry, data/RWAs.json,
 * version 0.1.9, 2026-10-28T11:16:36.810Z: github.com/cowprotocol/cowswap/tree/develop/apps/rwa-frontend).
 *
 * Only issuers whose EVM token balance can be valued directly at the token's market price are
 * listed (Coinbase: price-accrual; xStocks: rebasing, balanceOf already scaled), on chains Nimiq
 * Pay's EVM wallet supports. `primary` is the token AuraPay buys: Coinbase tokens on Base where
 * available, because the same tokens are accepted as collateral by Aave V4's MAG7 spoke on Base.
 */

export interface StockToken {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  issuer: "Coinbase" | "xStocks";
  coingeckoId: string;
}

export const STOCK_TOKENS: Record<string, { primary: StockToken; all: StockToken[] }> = {
  NVDA: {
    primary: { chainId: 8453, address: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAC", decimals: 8, issuer: "Coinbase", coingeckoId: "nvidia-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d", symbol: "NVDAx", decimals: 18, issuer: "xStocks", coingeckoId: "nvidia-xstock" },
      { chainId: 1, address: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d", symbol: "NVDAx", decimals: 18, issuer: "xStocks", coingeckoId: "nvidia-xstock" },
      { chainId: 8453, address: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAC", decimals: 8, issuer: "Coinbase", coingeckoId: "nvidia-coinbase-tokenized-stock" },
    ],
  },
  AAPL: {
    primary: { chainId: 8453, address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLC", decimals: 8, issuer: "Coinbase", coingeckoId: "apple-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a", symbol: "AAPLx", decimals: 18, issuer: "xStocks", coingeckoId: "apple-xstock" },
      { chainId: 1, address: "0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a", symbol: "AAPLx", decimals: 18, issuer: "xStocks", coingeckoId: "apple-xstock" },
      { chainId: 8453, address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLC", decimals: 8, issuer: "Coinbase", coingeckoId: "apple-coinbase-tokenized-stock" },
    ],
  },
  MSFT: {
    primary: { chainId: 8453, address: "0xB200000000000000000000Ab99cFa739E253872B", symbol: "MSFTC", decimals: 8, issuer: "Coinbase", coingeckoId: "microsoft-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0x5621737f42dAE558b81269FcB9E9E70c19Aa6b35", symbol: "MSFTx", decimals: 18, issuer: "xStocks", coingeckoId: "microsoft-xstock" },
      { chainId: 1, address: "0x5621737f42dAE558b81269FcB9E9E70c19Aa6b35", symbol: "MSFTx", decimals: 18, issuer: "xStocks", coingeckoId: "microsoft-xstock" },
      { chainId: 8453, address: "0xB200000000000000000000Ab99cFa739E253872B", symbol: "MSFTC", decimals: 8, issuer: "Coinbase", coingeckoId: "microsoft-coinbase-tokenized-stock" },
    ],
  },
  TSLA: {
    primary: { chainId: 8453, address: "0xb2000000000000000000001e800a7f5189430cD0", symbol: "TSLAC", decimals: 8, issuer: "Coinbase", coingeckoId: "tesla-coinbase-tokenized-stocks" },
    all: [
      { chainId: 42161, address: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0", symbol: "TSLAx", decimals: 18, issuer: "xStocks", coingeckoId: "tesla-xstock" },
      { chainId: 1, address: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0", symbol: "TSLAx", decimals: 18, issuer: "xStocks", coingeckoId: "tesla-xstock" },
      { chainId: 8453, address: "0xb2000000000000000000001e800a7f5189430cD0", symbol: "TSLAC", decimals: 8, issuer: "Coinbase", coingeckoId: "tesla-coinbase-tokenized-stocks" },
    ],
  },
  AMZN: {
    primary: { chainId: 8453, address: "0xb200000000000000000000d9192b6B456483C2E8", symbol: "AMZNC", decimals: 8, issuer: "Coinbase", coingeckoId: "amazon-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0x3557Ba345B01EFa20A1bdDC61F573BFD87195081", symbol: "AMZNx", decimals: 18, issuer: "xStocks", coingeckoId: "amazon-xstock" },
      { chainId: 1, address: "0x3557Ba345B01EFa20A1bdDC61F573BFD87195081", symbol: "AMZNx", decimals: 18, issuer: "xStocks", coingeckoId: "amazon-xstock" },
      { chainId: 8453, address: "0xb200000000000000000000d9192b6B456483C2E8", symbol: "AMZNC", decimals: 8, issuer: "Coinbase", coingeckoId: "amazon-coinbase-tokenized-stock" },
    ],
  },
  GOOGL: {
    primary: { chainId: 8453, address: "0xb2000000000000000000002D0BA3164cc74f58B7", symbol: "GOOGLC", decimals: 8, issuer: "Coinbase", coingeckoId: "alphabet-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F", symbol: "GOOGLx", decimals: 18, issuer: "xStocks", coingeckoId: "alphabet-xstock" },
      { chainId: 1, address: "0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F", symbol: "GOOGLx", decimals: 18, issuer: "xStocks", coingeckoId: "alphabet-xstock" },
      { chainId: 8453, address: "0xb2000000000000000000002D0BA3164cc74f58B7", symbol: "GOOGLC", decimals: 8, issuer: "Coinbase", coingeckoId: "alphabet-coinbase-tokenized-stock" },
    ],
  },
  META: {
    primary: { chainId: 8453, address: "0xb2000000000000000000008bC8786B856E61707C", symbol: "METAC", decimals: 8, issuer: "Coinbase", coingeckoId: "meta-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0x96702be57Cd9777f835117a809C7124fe4ec989A", symbol: "METAx", decimals: 18, issuer: "xStocks", coingeckoId: "meta-xstock" },
      { chainId: 1, address: "0x96702be57Cd9777f835117a809C7124fe4ec989A", symbol: "METAx", decimals: 18, issuer: "xStocks", coingeckoId: "meta-xstock" },
      { chainId: 8453, address: "0xb2000000000000000000008bC8786B856E61707C", symbol: "METAC", decimals: 8, issuer: "Coinbase", coingeckoId: "meta-coinbase-tokenized-stock" },
    ],
  },
  AMD: {
    primary: { chainId: 8453, address: "0xB2000000000000000000000d8Ce462E99ee7A47B", symbol: "AMDC", decimals: 8, issuer: "Coinbase", coingeckoId: "advanced-micro-devices-inc-coinbase-tokenized-stock" },
    all: [
      { chainId: 1, address: "0x3522513E5F146a2006e2901b05f16B2821485E19", symbol: "AMDX", decimals: 18, issuer: "xStocks", coingeckoId: "amd-xstock" },
      { chainId: 8453, address: "0xB2000000000000000000000d8Ce462E99ee7A47B", symbol: "AMDC", decimals: 8, issuer: "Coinbase", coingeckoId: "advanced-micro-devices-inc-coinbase-tokenized-stock" },
    ],
  },
  NFLX: {
    primary: { chainId: 8453, address: "0xb20000000000000000000058B8c947e44011dFE6", symbol: "NFLXC", decimals: 8, issuer: "Coinbase", coingeckoId: "netflix-inc-coinbase-tokenized-stock" },
    all: [
      { chainId: 42161, address: "0xA6a65AC27E76cD53cB790473E4345c46e5eBf961", symbol: "NFLXX", decimals: 18, issuer: "xStocks", coingeckoId: "netflix-xstock" },
      { chainId: 1, address: "0xA6a65AC27E76cD53cB790473E4345c46e5eBf961", symbol: "NFLXX", decimals: 18, issuer: "xStocks", coingeckoId: "netflix-xstock" },
      { chainId: 8453, address: "0xb20000000000000000000058B8c947e44011dFE6", symbol: "NFLXC", decimals: 8, issuer: "Coinbase", coingeckoId: "netflix-inc-coinbase-tokenized-stock" },
    ],
  },
  COIN: {
    primary: { chainId: 42161, address: "0x364f210f430eC2448Fc68A49203040F6124096F0", symbol: "COINX", decimals: 18, issuer: "xStocks", coingeckoId: "coinbase-xstock" },
    all: [
      { chainId: 42161, address: "0x364f210f430eC2448Fc68A49203040F6124096F0", symbol: "COINX", decimals: 18, issuer: "xStocks", coingeckoId: "coinbase-xstock" },
      { chainId: 1, address: "0x364f210f430eC2448Fc68A49203040F6124096F0", symbol: "COINX", decimals: 18, issuer: "xStocks", coingeckoId: "coinbase-xstock" },
    ],
  },
};

export const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 137: "Polygon", 8453: "Base", 42161: "Arbitrum" };

export const ISSUER_LEGAL_URL: Record<StockToken["issuer"], string> = {
  Coinbase: "https://www.coinbase.com/tokenize",
  xStocks: "https://assets.backed.fi/legal-documentation",
};

/** Native USDC on the chains stock tokens live on (6 decimals). */
export const USDC_BY_CHAIN: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
};

/** USDT on Polygon — the USDT in Nimiq Pay. */
export const USDT_POLYGON = "0xc2132D05D31c914a87C6611C10748aEb04B58e8F";
