import "server-only";
import type { IntegrationStatus } from "@/lib/shared/types";
import { config } from "./config";
import { getDbState } from "./db";
import { brokerageStatus } from "./investing";
import { lendingStatus } from "./lending";
import { errorMessage } from "./log";
import { marketDataMode } from "./market";
import { paymentRails } from "./rails";
import { getRatesSafe } from "./rates";

export async function integrationStatus(): Promise<IntegrationStatus> {
  let database: IntegrationStatus["database"];
  try {
    const s = await getDbState();
    database = { kind: s.kind, persistent: s.kind !== "pglite-memory", ok: true };
  } catch (err) {
    database = { kind: config.databaseUrl ? "postgres" : "pglite", persistent: false, ok: false, error: errorMessage(err) };
  }

  const { rates, error: ratesError } = await getRatesSafe();
  const mkt = marketDataMode();

  return {
    appMode: config.appMode,
    simulatorsAllowed: config.simulatorsAllowed,
    database,
    reloadly: config.reloadly.configured
      ? { state: config.reloadly.mode }
      : { state: "disconnected", reason: "RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET not set." },
    nimiq: {
      network: config.nimiq.network,
      merchantConfigured: Boolean(config.nimiq.merchantAddress),
      rpcConfigured: Boolean(config.nimiq.rpcUrl),
    },
    polygon: {
      merchantConfigured: Boolean(config.polygon.merchantAddress),
      rpcUrlHost: new URL(config.polygon.rpcUrl).host,
    },
    rails: paymentRails(),
    rates: rates
      ? { state: "live", source: rates.source, nimUsd: rates.nimUsd, usdtUsd: rates.usdtUsd }
      : { state: "unavailable", source: "coingecko", reason: ratesError },
    marketData: {
      state: mkt,
      provider: mkt === "live" ? "finnhub" : mkt === "demo" ? "demo-snapshot" : "none",
      reason: mkt === "demo" ? "FINNHUB_API_KEY not set — showing illustrative demo prices." : mkt === "unavailable" ? "FINNHUB_API_KEY not set." : undefined,
    },
    brokerage: brokerageStatus(),
    lending: lendingStatus(),
    merchant: {
      nimAddress: config.nimiq.merchantAddress,
      polygonAddress: config.polygon.merchantAddress,
    },
  };
}
