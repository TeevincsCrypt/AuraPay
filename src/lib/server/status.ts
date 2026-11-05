import "server-only";
import type { IntegrationStatus } from "@/lib/shared/types";
import { config } from "./config";
import { getDbState } from "./db";
import { errorMessage } from "./log";
import { paymentRails } from "./rails";
import { getRatesSafe } from "./rates";
import { utilityEnvironment } from "./utilities/provider";

export async function integrationStatus(): Promise<IntegrationStatus> {
  let database: IntegrationStatus["database"];
  try {
    const s = await getDbState();
    database = { kind: s.kind, persistent: s.kind !== "pglite-memory", ok: true };
  } catch (err) {
    database = { kind: config.databaseUrl ? "postgres" : "none", persistent: false, ok: false, error: errorMessage(err) };
  }
  const { rates, error: ratesError } = await getRatesSafe();

  return {
    database,
    utilities: config.utilityProvider
      ? {
          provider: config.utilityProvider,
          state: utilityEnvironment(),
          // Live Flutterwave Bills needs whitelisted IPs: is a static-IP proxy configured? (host only)
          ...(config.utilityProvider === "flutterwave"
            ? { staticIpProxy: config.flutterwave.proxyUrl ? new URL(config.flutterwave.proxyUrl).host : null }
            : {}),
        }
      : { provider: null, state: "disconnected", reason: "FLUTTERWAVE_SECRET_KEY not set." },
    nimiq: { network: config.nimiq.network, merchantConfigured: Boolean(config.nimiq.merchantAddress), rpcConfigured: Boolean(config.nimiq.rpcUrl) },
    polygon: { merchantConfigured: Boolean(config.polygon.merchantAddress), rpcUrlHost: new URL(config.polygon.rpcUrl).host },
    rails: paymentRails(),
    rates: rates
      ? { state: "live", source: rates.source, nimUsd: rates.nimUsd, usdtUsd: rates.usdtUsd, polUsd: rates.polUsd }
      : { state: "unavailable", source: "coingecko", reason: ratesError },
    merchant: { nimAddress: config.nimiq.merchantAddress, polygonAddress: config.polygon.merchantAddress },
  };
}
