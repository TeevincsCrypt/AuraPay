import "server-only";
import type { IntegrationStatus } from "@/lib/shared/types";
import { config } from "./config";
import { getDbState } from "./db";
import { investingStatus } from "./investing";
import { errorMessage } from "./log";
import { marketDataSource } from "./market";
import { paymentRails } from "./rails";
import { getRatesSafe } from "./rates";

export async function integrationStatus(): Promise<IntegrationStatus> {
  let database: IntegrationStatus["database"];
  try {
    const s = await getDbState();
    database = { kind: s.kind, persistent: s.kind !== "pglite-memory", ok: true };
  } catch (err) {
    database = { kind: config.databaseUrl ? "postgres" : "none", persistent: false, ok: false, error: errorMessage(err) };
  }
  const { rates, error: ratesError } = await getRatesSafe();
  const src = marketDataSource();

  return {
    database,
    auth: { sessionSecretConfigured: config.sessionSecretConfigured },
    reloadly: config.reloadly.configured
      ? { state: config.reloadly.mode }
      : { state: "disconnected", reason: "RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET not set." },
    nimiq: { network: config.nimiq.network, merchantConfigured: Boolean(config.nimiq.merchantAddress), rpcConfigured: Boolean(config.nimiq.rpcUrl) },
    polygon: { merchantConfigured: Boolean(config.polygon.merchantAddress), rpcUrlHost: new URL(config.polygon.rpcUrl).host },
    rails: paymentRails(),
    rates: rates
      ? { state: "live", source: rates.source, nimUsd: rates.nimUsd, usdtUsd: rates.usdtUsd }
      : { state: "unavailable", source: "coingecko", reason: ratesError },
    marketData: {
      state: rates || config.market.finnhubKey ? "live" : "unavailable",
      provider: src === "finnhub" ? "Finnhub (listed price)" : "CoinGecko (tokenised-stock price)",
      reason: src === "finnhub" ? undefined : "FINNHUB_API_KEY not set — prices shown are the live tokenised-stock market prices.",
    },
    investing: investingStatus(),
    lending: { state: "live", provider: "Aave V4 (MAG7 spoke, Base)", reason: "Borrow USDC against Coinbase tokenised stocks, directly from your wallet." },
    merchant: { nimAddress: config.nimiq.merchantAddress, polygonAddress: config.polygon.merchantAddress },
  };
}
