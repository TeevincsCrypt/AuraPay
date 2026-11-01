import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { erc20Balances } from "@/lib/server/evm";
import { isEvmAddress } from "@/lib/server/payments/polygon";
import { USDC_BY_CHAIN } from "@/lib/shared/stock-tokens";

export const dynamic = "force-dynamic";

const Query = z.object({ address: z.string(), chainId: z.coerce.number().int() });

/** USDC balance on a stock token's chain (Base/Arbitrum), read via our RPC. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "wallet:balance", 30, 60);
  const { address, chainId } = parseQuery(req.url, Query);
  if (!isEvmAddress(address)) throw new AppError("INVALID_ADDRESS", "Invalid address.", 422);
  const token = USDC_BY_CHAIN[chainId];
  if (!token) throw new AppError("UNSUPPORTED_CHAIN", "Unsupported network.", 422);
  const [raw] = await erc20Balances(chainId, [{ token, owner: address }]);
  if (raw === null || raw === undefined) throw new AppError("BALANCE_UNAVAILABLE", "Couldn't read your USDC balance right now.", 503);
  return json({ address: address.toLowerCase(), chainId, balance: Number(raw) / 1e6 });
});
