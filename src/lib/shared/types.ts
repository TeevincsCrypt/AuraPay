/** Types shared between API routes and the client. No secrets live here. */

export type PayCurrency = "NIM" | "USDT";
export type UtilityService = "airtime" | "data" | "electricity" | "cable" | "internet";
/** Services paid to an account/meter/smartcard number (not a phone number). */
export const ACCOUNT_SERVICES: readonly UtilityService[] = ["electricity", "cable", "internet"];
/** Services sold as fixed-price packages/bundles. */
export const BUNDLE_SERVICES: readonly UtilityService[] = ["data", "cable", "internet"];
export type BillerService = "electricity" | "cable" | "internet";

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
  utilities: { provider: "flutterwave" | "reloadly" | null; state: "sandbox" | "production" | "disconnected"; reason?: string };
  nimiq: { network: "mainnet" | "testnet"; merchantConfigured: boolean; rpcConfigured: boolean };
  polygon: { merchantConfigured: boolean; rpcUrlHost: string };
  rails: Record<PayCurrency, RailStatus>;
  rates: { state: "live" | "unavailable"; source: string; nimUsd?: number; usdtUsd?: number; reason?: string };
  merchant: { nimAddress?: string; polygonAddress?: string };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Utilities catalogue (normalised from the active provider: Flutterwave or Reloadly)
// ---------------------------------------------------------------------------

export interface CountryServices {
  countryCode: string;
  airtime: boolean;
  data: boolean;
  electricity: boolean;
  cable: boolean;
  internet: boolean;
  operatorCount: number;
  billerCount: number;
}

export interface OperatorProduct {
  /** Provider product code (Flutterwave item_code; Reloadly fixed amount). */
  code: string;
  /** Amount in the provider account (sender) currency. */
  senderAmount: number;
  /** Amount in local currency where known. */
  localAmount: number | null;
  description: string | null;
}

export interface OperatorDTO {
  /** Provider operator code (Flutterwave biller code; Reloadly operator id). */
  code: string;
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
  /** Provider biller code (Flutterwave "<biller_code>:<item_code>"; Reloadly biller id). */
  code: string;
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
  /** Packages for cable TV / internet billers (empty for electricity). */
  products: OperatorProduct[];
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
  operatorCode: string;
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
  | "refund"
  | "bill_schedule"
  | "transfer_sent"
  | "transfer_received"
  | "earn_deposit"
  | "earn_withdraw"
  | "swap"
  | "savings_lock"
  | "savings_release";

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
// Scheduled bills (prepaid; paid out automatically at each run time)
// ---------------------------------------------------------------------------

export type ScheduleFrequency = "once" | "weekly" | "monthly";
export type ScheduleStatus = "quoted" | "payment_pending" | "active" | "completed" | "cancelled" | "expired" | "requires_review" | "refunded";

export interface ScheduleRunDTO {
  run: number;
  orderId: string;
  ref: string;
  status: UtilityOrderStatus;
  createdAt: string;
}

export interface BillScheduleDTO {
  id: string;
  ref: string;
  environment: "sandbox" | "production";
  service: UtilityService;
  countryCode: string;
  operatorName: string;
  recipient: string;
  recipientLabel: string | null;
  productDescription: string | null;
  amountLocal: number | null;
  localCurrency: string | null;
  frequency: ScheduleFrequency;
  totalRuns: number;
  runsDone: number;
  startAt: string;
  nextRunAt: string | null;
  perRunUsd: number;
  quote: QuoteBreakdown;
  payToAddress: string | null;
  payerAddress: string | null;
  memo: string | null;
  status: ScheduleStatus;
  statusReason: string | null;
  refundDue: boolean;
  paymentTxHash: string | null;
  runs: ScheduleRunDTO[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Usernames & transfers (wallet to wallet; AuraPay never holds the funds)
// ---------------------------------------------------------------------------

export interface UsernameProfile {
  username: string;
  /** Where NIM sent to this username arrives (their Nimiq Pay address). */
  nimAddress: string;
  /** Where USDT (Polygon) sent to this username arrives; null if they haven't verified one. */
  polygonAddress: string | null;
  /** Profile picture, or null for the generated initials avatar. */
  avatarUrl: string | null;
}

export type TransferStatus = "created" | "pending" | "confirmed" | "failed" | "expired";

export interface TransferDTO {
  id: string;
  ref: string;
  direction: "sent" | "received";
  currency: PayCurrency;
  amount: number;
  amountAtomic: string;
  amountUsd: number | null;
  counterparty: string; // @username of the other side
  toAddress: string;
  fromAddress: string | null;
  note: string | null;
  memo: string | null;
  status: TransferStatus;
  failureReason: string | null;
  txHash: string | null;
  network: string;
  createdAt: string;
  confirmedAt: string | null;
}
