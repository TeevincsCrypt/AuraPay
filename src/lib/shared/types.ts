/** Types shared between API routes and the client. No secrets live here. */

export type PayCurrency = "NIM" | "USDT";
export type UtilityService = "airtime" | "data" | "electricity";

export type ActivityStatus = "pending" | "processing" | "successful" | "failed" | "refunded" | "requires_review";

export type UtilityOrderStatus =
  | "quoted"
  | "payment_pending"
  | "paid"
  | "fulfilling"
  | "provider_pending"
  | "successful"
  | "failed"
  | "expired"
  | "requires_review"
  | "refunded";

export interface RailStatus {
  available: boolean;
  reason?: string;
}

export interface IntegrationStatus {
  database: { kind: string; persistent: boolean; ok: boolean; error?: string };
  reloadly: { state: "sandbox" | "production" | "disconnected"; reason?: string };
  nimiq: { network: "mainnet" | "testnet"; merchantConfigured: boolean; rpcConfigured: boolean };
  polygon: { merchantConfigured: boolean; rpcUrlHost: string };
  rails: Record<PayCurrency, RailStatus>;
  rates: { state: "live" | "unavailable"; source: string; nimUsd?: number; usdtUsd?: number; reason?: string };
  marketData: { state: "live" | "unavailable"; provider: string; reason?: string };
  investing: { state: "live" | "unavailable"; provider: string; reason: string };
  lending: { state: "live" | "unavailable"; provider: string; reason: string };
  merchant: { nimAddress?: string; polygonAddress?: string };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Utilities catalogue (normalised from Reloadly)
// ---------------------------------------------------------------------------

export interface CountryServices {
  countryCode: string;
  airtime: boolean;
  data: boolean;
  electricity: boolean;
  operatorCount: number;
  billerCount: number;
}

export interface OperatorProduct {
  /** Amount in the provider account (sender) currency. */
  senderAmount: number;
  /** Amount in local currency where known. */
  localAmount: number | null;
  description: string | null;
}

export interface OperatorDTO {
  id: number;
  name: string;
  logoUrl: string | null;
  isData: boolean;
  isBundle: boolean;
  denominationType: "FIXED" | "RANGE";
  supportsLocalAmounts: boolean;
  senderCurrency: string;
  localCurrency: string;
  localCurrencySymbol: string | null;
  fxRate: number | null; // local units per 1 sender unit
  minAmount: number | null;
  maxAmount: number | null;
  localMinAmount: number | null;
  localMaxAmount: number | null;
  products: OperatorProduct[];
  suggestedAmounts: number[];
}

export interface BillerDTO {
  id: number;
  name: string;
  countryCode: string;
  type: string;
  serviceType: string; // PREPAID | POSTPAID
  localCurrency: string;
  localAmountSupported: boolean;
  minLocalAmount: number | null;
  maxLocalAmount: number | null;
  localFee: number | null;
  senderCurrency: string | null;
  minSenderAmount: number | null;
  maxSenderAmount: number | null;
  fxRate: number | null;
}

export interface QuoteBreakdown {
  providerCostUsd: number;
  serviceFeeUsd: number;
  totalUsd: number;
  payCurrency: PayCurrency;
  payAmount: number;
  payAmountAtomic: string;
  exchangeRate: number; // USD per 1 unit of pay currency
  rateSource: string;
  expiresAt: string;
}

export interface UtilityOrderDTO {
  id: string;
  ref: string;
  environment: "sandbox" | "production";
  service: UtilityService;
  countryCode: string;
  operatorId: number;
  operatorName: string;
  recipient: string;
  recipientLabel: string | null;
  productDescription: string | null;
  amountLocal: number | null;
  localCurrency: string | null;
  amountSender: number;
  senderCurrency: string;
  quote: QuoteBreakdown;
  payToAddress: string | null;
  payerAddress: string | null;
  memo: string | null;
  status: UtilityOrderStatus;
  statusReason: string | null;
  isSimulatedPayment: boolean;
  providerTransactionId: string | null;
  providerStatus: string | null;
  deliveryDetails: Record<string, unknown> | null;
  paymentTxHash: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type ActivityCategory =
  | "stock_purchase"
  | "utility_purchase"
  | "loan_disbursement"
  | "loan_repayment"
  | "collateral_deposit"
  | "collateral_withdrawal"
  | "wallet_payment"
  | "refund";

export interface ActivityItem {
  id: string;
  ref: string;
  category: ActivityCategory;
  title: string;
  subtitle: string | null;
  amount: number;
  currency: string;
  amountUsd: number | null;
  status: ActivityStatus;
  isSimulated: boolean;
  environment: string;
  provider: string | null;
  providerRef: string | null;
  chainTxHash: string | null;
  sourceTable: string;
  sourceId: string;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Markets & investing (real tokenised stocks)
// ---------------------------------------------------------------------------

export interface QuoteToken {
  symbol: string;
  chainId: number;
  issuer: "Coinbase" | "xStocks";
  address: string;
  coingeckoId: string;
}

export interface StockQuote {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  description: string;
  logoUrl: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  open: number | null;
  previousClose: number | null;
  asOf: string | null;
  /** finnhub = listed share price; tokenized = market price of the tokenised stock. */
  source: "finnhub" | "tokenized" | "unavailable";
  token: QuoteToken | null;
  tokenPriceUsd: number | null;
}

export interface PricePoint {
  t: string; // ISO date
  c: number;
}

export interface MarketStatus {
  isOpen: boolean | null;
  session: string | null;
  source: "finnhub" | "unavailable";
}

export interface HoldingDTO {
  symbol: string;
  name: string;
  tokenSymbol: string;
  issuer: "Coinbase" | "xStocks";
  chainId: number;
  tokenAddress: string;
  owner: string;
  walletQuantity: number;
  /** Supplied as collateral to Aave V4 (still owned by the user). */
  suppliedQuantity: number;
  quantity: number;
  tokenPriceUsd: number | null;
  valueUsd: number | null;
  dayChangeUsd: number | null;
  costBasisUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface PortfolioDTO {
  evmAddresses: string[];
  holdings: HoldingDTO[];
  totals: {
    valueUsd: number | null;
    dayChangeUsd: number | null;
    dayChangePercent: number | null;
    costBasisUsd: number | null;
    totalPnlUsd: number | null;
    totalPnlPercent: number | null;
  };
  errors: string[];
}

export interface StockTradeDTO {
  ref: string;
  symbol: string;
  orderUid: string;
  chainId: number;
  targetChainId: number | null;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "unknown";
  sellAmount: number | null;
  executedSellAmount: number | null;
  executedBuyAmount: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Borrowing (Aave V4, MAG7 spoke on Base)
// ---------------------------------------------------------------------------

export interface LendingReserveDTO {
  reserveId: number;
  symbol: string; // underlying token symbol, e.g. NVDAc / USDC
  ticker: string | null; // stock ticker for collateral reserves
  underlying: string;
  decimals: number;
  priceUsd: number | null;
  collateralFactor: number; // 0..1
  borrowable: boolean;
  paused: boolean;
  frozen: boolean;
  borrowApr: number | null; // 0..1, base drawn rate (excl. user risk premium)
  walletBalance: number;
  supplied: number;
  usingAsCollateral: boolean;
  debt: number;
}

export interface BorrowOverviewDTO {
  available: boolean;
  reason: string | null;
  chainId: number;
  spoke: string;
  owner: string | null;
  reserves: LendingReserveDTO[];
  account: {
    healthFactor: number | null;
    collateralUsd: number;
    debtUsd: number;
    avgCollateralFactor: number | null;
    riskPremiumBps: number | null;
    borrowCapacityUsd: number;
  } | null;
}
