import "server-only";
import { config } from "../config";
import { AppError } from "../http";
import { billerById, countryServices, detectOperator, electricityBillers, isAirtimeOperator, isDataOperator, operatorById, operatorsForCountry } from "../reloadly/catalog";
import { friendlyReloadlyMessage, reloadlyRequest, ReloadlyError } from "../reloadly/client";
import { normalisePhone, ProviderError, roundUpCents, type PriceInput, type Priced, type ProviderOrder, type ProviderOutcome, type UtilityProvider } from "./provider";

/** Reloadly (Airtime + Utility Payments APIs) behind the utility-provider interface. */

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof ReloadlyError) {
      throw new ProviderError(err.errorCode ?? "PROVIDER_ERROR", friendlyReloadlyMessage(err), err.status === 404 ? 404 : 502, err.outcomeUnknown);
    }
    throw err;
  });
}

interface TopupResponse {
  transactionId: number;
  status?: string;
  operatorTransactionId?: string | null;
  deliveredAmount?: number;
  deliveredAmountCurrencyCode?: string;
  pinDetail?: Record<string, unknown> | null;
  transactionDate?: string;
}

interface PayBillResponse {
  id: number;
  status: string;
  message?: string;
}

interface UtilityTransactionResponse {
  transaction?: { id: number; status: string; billDetails?: Record<string, unknown> };
}

function topupDelivery(r: TopupResponse): Record<string, unknown> {
  return {
    deliveredAmount: r.deliveredAmount ?? null,
    deliveredCurrency: r.deliveredAmountCurrencyCode ?? null,
    operatorTransactionId: r.operatorTransactionId ?? null,
    pin: r.pinDetail ?? null,
    providerDate: r.transactionDate ?? null,
  };
}

function extractToken(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const pin = (details.pinDetails ?? details.pinDetail) as Record<string, unknown> | undefined;
  const token = pin?.token ?? pin?.code ?? details.token;
  return typeof token === "string" || typeof token === "number" ? String(token) : null;
}

async function getUtilityTransaction(id: string): Promise<UtilityTransactionResponse | null> {
  // Reloadly's spec lists /transactions/{id}; older docs used /transaction/{id}.
  for (const path of [`/transactions/${encodeURIComponent(id)}`, `/transaction/${encodeURIComponent(id)}`]) {
    try {
      const r = await reloadlyRequest<UtilityTransactionResponse | UtilityTransactionResponse[]>("utilities", "GET", path);
      return Array.isArray(r) ? r[0] ?? null : r;
    } catch (err) {
      if (err instanceof ReloadlyError && err.status === 404) continue;
      throw err;
    }
  }
  return null;
}

async function priceTopup(input: PriceInput): Promise<Priced> {
  const operatorId = Number(input.operatorCode);
  if (!Number.isInteger(operatorId) || operatorId <= 0) throw new AppError("OPERATOR_NOT_FOUND", "Operator not found.", 404);
  const { dto: op, raw } = await operatorById(operatorId);
  if ((raw.country?.isoName ?? "").toUpperCase() !== input.countryCode) {
    throw new AppError("OPERATOR_COUNTRY_MISMATCH", "This operator does not serve the selected country.", 422);
  }
  if (input.service === "data" && !isDataOperator(op)) throw new AppError("NOT_DATA_OPERATOR", "This operator does not sell data bundles.", 422);
  if (input.service === "airtime" && !isAirtimeOperator(op)) throw new AppError("NOT_AIRTIME_OPERATOR", "Select an airtime operator.", 422);
  if (op.senderCurrency !== "USD") {
    throw new AppError("UNSUPPORTED_ACCOUNT_CURRENCY", `Provider account currency ${op.senderCurrency} is not supported (USD required).`, 503);
  }
  const recipient = normalisePhone(input.recipient, input.countryCode);
  const base = { operatorName: op.name, operatorCode: op.code, itemCode: null, senderCurrency: op.senderCurrency, recipient };

  if (op.denominationType === "FIXED") {
    const product = input.productCode
      ? op.products.find((p) => p.code === input.productCode)
      : op.products.find((p) => Math.abs(p.senderAmount - input.amount) < 0.005);
    if (!product) throw new AppError("INVALID_PRODUCT", "Select one of the operator's available amounts.", 422);
    return {
      ...base,
      productDescription: product.description,
      amountLocal: product.localAmount,
      localCurrency: op.localCurrency || null,
      amountSender: product.senderAmount,
      useLocalAmount: false,
      providerCostUsd: product.senderAmount,
    };
  }

  if (input.amountCurrency === "local") {
    if (!op.supportsLocalAmounts || !op.fxRate) throw new AppError("LOCAL_AMOUNT_UNSUPPORTED", "Enter the amount in USD for this operator.", 422);
    if (op.localMinAmount !== null && input.amount < op.localMinAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${op.localMinAmount} ${op.localCurrency}.`, 422);
    if (op.localMaxAmount !== null && input.amount > op.localMaxAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${op.localMaxAmount} ${op.localCurrency}.`, 422);
    const cost = roundUpCents(input.amount / op.fxRate);
    return { ...base, productDescription: null, amountLocal: input.amount, localCurrency: op.localCurrency, amountSender: cost, useLocalAmount: true, providerCostUsd: cost };
  }
  if (op.minAmount !== null && input.amount < op.minAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is $${op.minAmount}.`, 422);
  if (op.maxAmount !== null && input.amount > op.maxAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is $${op.maxAmount}.`, 422);
  return {
    ...base,
    productDescription: null,
    amountLocal: op.fxRate ? Math.round(input.amount * op.fxRate * 100) / 100 : null,
    localCurrency: op.localCurrency || null,
    amountSender: roundUpCents(input.amount),
    useLocalAmount: false,
    providerCostUsd: roundUpCents(input.amount),
  };
}

async function priceElectricity(input: PriceInput): Promise<Priced> {
  const id = Number(input.operatorCode);
  const biller = Number.isInteger(id) && id > 0 ? await billerById(id) : null;
  if (!biller || biller.type !== "ELECTRICITY_BILL_PAYMENT") throw new AppError("BILLER_NOT_FOUND", "Electricity provider not found.", 404);
  if (biller.countryCode !== input.countryCode) throw new AppError("BILLER_COUNTRY_MISMATCH", "This provider does not serve the selected country.", 422);
  if (biller.senderCurrency && biller.senderCurrency !== "USD") {
    throw new AppError("UNSUPPORTED_ACCOUNT_CURRENCY", `Provider account currency ${biller.senderCurrency} is not supported (USD required).`, 503);
  }
  if (!biller.localAmountSupported || !biller.fxRate) throw new AppError("BILLER_PRICING_UNAVAILABLE", "This provider doesn't support local-currency amounts.", 422);
  const meter = input.recipient.replace(/[\s-]/g, "");
  if (!/^[0-9A-Za-z]{6,24}$/.test(meter)) throw new AppError("INVALID_METER", "Enter a valid meter or account number.", 422);
  if (input.amountCurrency !== "local") throw new AppError("INVALID_AMOUNT_CURRENCY", "Enter the amount in local currency.", 422);
  if (biller.minLocalAmount !== null && input.amount < biller.minLocalAmount) throw new AppError("AMOUNT_TOO_LOW", `Minimum is ${biller.minLocalAmount} ${biller.localCurrency}.`, 422);
  if (biller.maxLocalAmount !== null && input.amount > biller.maxLocalAmount) throw new AppError("AMOUNT_TOO_HIGH", `Maximum is ${biller.maxLocalAmount} ${biller.localCurrency}.`, 422);
  const fee = biller.localFee ?? 0;
  const cost = roundUpCents((input.amount + fee) / biller.fxRate);
  return {
    operatorName: biller.name,
    operatorCode: biller.code,
    itemCode: null,
    productDescription: `${biller.serviceType === "POSTPAID" ? "Postpaid" : "Prepaid"} electricity${fee ? ` · incl. provider fee ${fee} ${biller.localCurrency}` : ""}`,
    amountLocal: input.amount,
    localCurrency: biller.localCurrency,
    amountSender: cost,
    senderCurrency: "USD",
    useLocalAmount: true,
    providerCostUsd: cost,
    recipient: meter,
  };
}

export function reloadlyProvider(): UtilityProvider {
  return {
    id: "reloadly",
    label: "Reloadly",
    environment: config.reloadly.mode,
    countryServices: (cc) => wrap(() => countryServices(cc)),
    operators: (cc, service) => wrap(async () => (await operatorsForCountry(cc)).filter(service === "data" ? isDataOperator : isAirtimeOperator)),
    detectOperator: (e164, cc) => detectOperator(e164, cc),
    fxPerUsd: async () => null,
    billers: (cc, service) => (service === "electricity" ? wrap(() => electricityBillers(cc)) : Promise.resolve([])),
    price: (input) => {
      if (input.service === "cable" || input.service === "internet") {
        return Promise.reject(new ProviderError("SERVICE_UNAVAILABLE", "This service isn't available with the current utility provider.", 422));
      }
      return wrap(() => (input.service === "electricity" ? priceElectricity(input) : priceTopup(input)));
    },

    async submit(order: ProviderOrder): Promise<ProviderOutcome> {
      return wrap(async () => {
        if (order.service === "electricity") {
          const res = await reloadlyRequest<PayBillResponse>("utilities", "POST", "/pay", {
            subscriberAccountNumber: order.recipient,
            amount: order.amountLocal,
            billerId: Number(order.operatorCode),
            useLocalAmount: true,
            referenceId: order.ref,
          });
          const status = (res.status ?? "").toUpperCase();
          return {
            next: status === "SUCCESSFUL" ? "successful" : status === "FAILED" ? "requires_review" : "provider_pending",
            providerTransactionId: String(res.id),
            providerStatus: status,
            providerResponse: res,
            reason: status === "FAILED" ? `Provider failed: ${res.message ?? status}` : res.message ?? null,
          };
        }
        const res = await reloadlyRequest<TopupResponse>("airtime", "POST", "/topups", {
          operatorId: Number(order.operatorCode),
          amount: order.useLocalAmount ? order.amountLocal : order.amountSender,
          useLocalAmount: order.useLocalAmount,
          customIdentifier: order.ref,
          recipientPhone: { countryCode: order.countryCode, number: order.recipient },
        });
        const status = (res.status ?? "SUCCESSFUL").toUpperCase();
        const next = status === "SUCCESSFUL" ? "successful" : status === "PENDING" || status === "PROCESSING" ? "provider_pending" : "requires_review";
        return {
          next,
          providerTransactionId: String(res.transactionId),
          providerStatus: status,
          providerResponse: res,
          deliveryDetails: topupDelivery(res),
          reason: next === "requires_review" ? `Provider returned ${status}. Refund required.` : null,
        };
      });
    },

    async poll(order: ProviderOrder): Promise<ProviderOutcome> {
      const id = order.providerTransactionId;
      if (!id) return { next: "unchanged" };
      return wrap(async () => {
        if (order.service === "electricity") {
          const raw = await getUtilityTransaction(id);
          const t = raw?.transaction;
          const status = (t?.status ?? "").toUpperCase();
          if (status === "SUCCESSFUL") {
            return { next: "successful", providerStatus: status, providerResponse: raw, deliveryDetails: { billDetails: t?.billDetails ?? null, token: extractToken(t?.billDetails) } };
          }
          if (status === "FAILED" || status === "REFUNDED") return { next: "requires_review", providerStatus: status, providerResponse: raw, reason: `Provider reported ${status}. Refund required.` };
          return { next: "unchanged", providerStatus: status || "PROCESSING" };
        }
        const res = await reloadlyRequest<TopupResponse>("airtime", "GET", `/topups/${encodeURIComponent(id)}/status`);
        const status = (res.status ?? "").toUpperCase();
        if (status === "SUCCESSFUL") return { next: "successful", providerStatus: status, providerResponse: res, deliveryDetails: topupDelivery(res) };
        if (status === "FAILED" || status === "REFUNDED") return { next: "requires_review", providerStatus: status, providerResponse: res, reason: `Provider reported ${status}. Refund required.` };
        return { next: "unchanged", providerStatus: status || "PENDING" };
      });
    },
  };
}

