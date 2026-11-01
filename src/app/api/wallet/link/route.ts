import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { isValidNimAddressFormat, normaliseNimAddress } from "@/lib/server/payments/nimiq";
import { isEvmAddress } from "@/lib/server/payments/polygon";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  chain: z.enum(["nimiq", "polygon"]),
  network: z.string().max(20),
  addresses: z.array(z.string().max(64)).min(1).max(10),
});

/**
 * Records which wallet addresses the host shared with this session.
 * listAccounts()/eth_requestAccounts share addresses but don't prove ownership;
 * ownership is proven per payment during on-chain verification.
 */
export const POST = handler(async (req) => {
  enforceRateLimit(req, "wallet:link", 20, 60);
  const user = await requireUser();
  const { chain, network, addresses } = await parseBody(req, Body);
  const normalised = addresses.map((a) => (chain === "nimiq" ? normaliseNimAddress(a) : a.toLowerCase()));
  for (const a of normalised) {
    if (chain === "nimiq" ? !isValidNimAddressFormat(a) : !isEvmAddress(a)) throw new AppError("INVALID_ADDRESS", "Invalid wallet address.", 422);
  }
  const db = await getDb();
  for (const a of normalised) {
    await db.query(
      `insert into wallet_connections (user_id, chain, network, address, source) values ($1,$2,$3,$4,$5)
       on conflict (user_id, chain, address) do update set last_seen_at = now(), network = excluded.network`,
      [user.id, chain, network, a, chain === "nimiq" ? "nimiq_pay" : "evm_provider"],
    );
  }
  return json({ ok: true });
});
