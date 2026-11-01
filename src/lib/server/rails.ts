import "server-only";
import type { PayCurrency, RailStatus } from "@/lib/shared/types";
import { config } from "./config";
import { isValidNimAddressFormat } from "./payments/nimiq";
import { isEvmAddress } from "./payments/polygon";

/**
 * Which payment rails may fund a utility order right now, and why not.
 *
 * Safety rule: sandbox (test) top-ups must never be paid with real money.
 * NIM can be tested for free on Nimiq testnet; Polygon USDT has no test network
 * in Nimiq Pay, so USDT is only offered against production fulfilment unless
 * ALLOW_REAL_PAYMENTS_FOR_SANDBOX is explicitly set.
 */
export function paymentRails(): Record<PayCurrency, RailStatus> {
  const sandbox = config.reloadly.mode === "sandbox";

  const nim: RailStatus = (() => {
    if (!config.nimiq.merchantAddress || !isValidNimAddressFormat(config.nimiq.merchantAddress)) {
      return { available: false, reason: "NIM payments are not configured (merchant address missing)." };
    }
    if (!config.nimiq.rpcUrl) return { available: false, reason: "NIM payment verification node is not configured." };
    if (sandbox && config.nimiq.network === "mainnet" && !config.allowRealPaymentsForSandbox) {
      return { available: false, reason: "Test top-ups can only be paid with testnet NIM." };
    }
    if (!sandbox && config.nimiq.network === "testnet") {
      return { available: false, reason: "Live top-ups require mainnet NIM." };
    }
    return { available: true };
  })();

  const usdt: RailStatus = (() => {
    if (!config.polygon.merchantAddress || !isEvmAddress(config.polygon.merchantAddress)) {
      return { available: false, reason: "USDT payments are not configured (merchant address missing)." };
    }
    if (sandbox && !config.allowRealPaymentsForSandbox) {
      return { available: false, reason: "USDT runs on Polygon mainnet, so it's disabled for test top-ups." };
    }
    return { available: true };
  })();

  return { NIM: nim, USDT: usdt };
}
