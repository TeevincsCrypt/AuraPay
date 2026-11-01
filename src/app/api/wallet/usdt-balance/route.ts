import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { isEvmAddress, usdtBalanceOf } from "@/lib/server/payments/polygon";

export const dynamic = "force-dynamic";

/** Reads a USDT (Polygon) balance via our RPC so the wallet needn't switch chains just to display it. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "wallet:balance", 30, 60);
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isEvmAddress(address)) throw new AppError("INVALID_ADDRESS", "Invalid address.", 422);
  try {
    return json({ address: address.toLowerCase(), balance: await usdtBalanceOf(address), network: "polygon" });
  } catch {
    throw new AppError("BALANCE_UNAVAILABLE", "Couldn't read your USDT balance right now.", 503);
  }
});
