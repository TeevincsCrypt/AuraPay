import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { isEvmAddress, polBalanceOf, usdtBalanceOf } from "@/lib/server/payments/polygon";

export const dynamic = "force-dynamic";

/** Reads a USDT (Polygon) balance, plus POL for gas, via our RPC so the wallet needn't switch chains just to display it. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "wallet:balance", 30, 60);
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isEvmAddress(address)) throw new AppError("INVALID_ADDRESS", "Invalid address.", 422);
  try {
    const [balance, pol] = await Promise.all([usdtBalanceOf(address), polBalanceOf(address).catch(() => null)]);
    // `pol` pays the Polygon network fee: a USDT payment from a wallet with no POL can't be sent.
    return json({ address: address.toLowerCase(), balance, pol, network: "polygon" });
  } catch {
    throw new AppError("BALANCE_UNAVAILABLE", "Couldn't read your USDT balance right now.", 503);
  }
});
