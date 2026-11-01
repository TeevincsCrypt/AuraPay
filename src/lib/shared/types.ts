/** Types shared between API routes and the client. No secrets live here. */

export type PayCurrency = "NIM" | "USDT" | "DEMO";
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
  appMode: "development" | "demo" | "sandbox" | "production";
  simulatorsAllowed: boolean;
  database: { kind: string; persistent: boolean; ok: boolean; error?: string };
  reloadly: { state: "sandbox" | "production" | "disconnected"; reason?: string };
  nimiq: { network: "mainnet" | "testnet"; merchantConfigured: boolean; rpcConfigured: boolean };
  polygon: { merchantConfigured: boolean; rpcUrlHost: string };
  rails: Record<PayCurrency, RailStatus>;
  rates: { state: "live" | "unavailable"; source: string; nimUsd?: number; usdtUsd?: number; reason?: string };
  marketData: { state: "live" | "demo" | "unavailable"; provider: string; reason?: string };
  brokerage: { state: "connected" | "unavailable"; provider?: string; reason: string };
  lending: { state: "connected" | "simulator" | "unavailable"; provider?: string; reason: string };
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
// Markets & investing
// ---------------------------------------------------------------------------

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
  source: "finnhub" | "demo" | "unavailable";
}

export interface PricePoint {
  t: string; // ISO date
  c: number;
}

export interface MarketStatus {
  isOpen: boolean | null;
  session: string | null;
  source: "finnhub" | "demo" | "unavailable";
}

export interface PositionDTO {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  costBasisUsd: number;
  price: number | null;
  marketValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPercent: number | null;
  dayChangeUsd: number | null;
  isSimulated: boolean;
  verified: boolean;
  priceSource: StockQuote["source"];
}

export interface PortfolioDTO {
  positions: PositionDTO[];
  totals: {
    investedUsd: number;
    marketValueUsd: number | null;
    dayChangeUsd: number | null;
    dayChangePercent: number | null;
    totalPnlUsd: number | null;
    totalPnlPercent: number | null;
  };
  hasSimulated: boolean;
  hasVerified: boolean;
}

export interface LoanDTO {
  id: string;
  ref: string;
  isSimulated: boolean;
  principalUsdt: number;
  apr: number;
  termDays: number;
  maxLtv: number;
  liquidationLtv: number;
  accruedInterest: number;
  totalOwed: number;
  repaidUsdt: number;
  outstanding: number;
  collateral: { symbol: string; quantity: number; valueAtLock: number; currentValue: number | null }[];
  collateralValue: number | null;
  currentLtv: number | null;
  health: number | null;
  status: "active" | "repaid" | "liquidated" | "cancelled";
  openedAt: string;
  dueAt: string;
  closedAt: string | null;
}
