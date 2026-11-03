import { config } from "@/lib/server/config";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { nimBalanceOf } from "@/lib/server/payments/nimiq";

export const dynamic = "force-dynamic";

const NIM_ADDRESS = /^NQ[0-9]{2}( ?[0-9A-HJ-NP-VXY]{4}){8}$/i;

/** NIM balance from AuraPay's Nimiq node: a fallback for when the wallet host can't report it. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "wallet:nim-balance", 30, 60);
  const address = (new URL(req.url).searchParams.get("address") ?? "").trim().toUpperCase();
  if (!NIM_ADDRESS.test(address)) throw new AppError("INVALID_ADDRESS", "Invalid Nimiq address.", 422);
  try {
    return json({ address, luna: await nimBalanceOf(address), network: config.nimiq.network });
  } catch {
    throw new AppError("BALANCE_UNAVAILABLE", "Couldn't read your NIM balance right now.", 503);
  }
});
