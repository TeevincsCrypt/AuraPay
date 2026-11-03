import "server-only";
import { avatarUrl, avatarVersion } from "./avatars";
import type { PayCurrency, TransferDTO, TransferStatus, UsernameProfile } from "@/lib/shared/types";
import { verifiedEvmAddresses } from "./auth/challenges";
import { checkContribution } from "./circles";
import { config } from "./config";
import { getDb, iso, num, numOrNull, type Db } from "./db";
import { AppError } from "./http";
import { insertLedger, newRef, updateLedgerBySource } from "./ledger";
import { errorMessage, log } from "./log";
import { getRatesSafe } from "./rates";
import { normaliseNimAddress, verifyNimiqTransfer } from "./payments/nimiq";
import { isEvmAddress, verifyPolygonUsdtTransfer } from "./payments/polygon";

/**
 * Usernames and wallet-to-wallet transfers.
 *
 * A @username points at its owner's receiving addresses: the Nimiq address they signed in
 * with (NIM) and a signature-verified EVM address (USDT on Polygon). Sending is direct from
 * the sender's wallet to those addresses: AuraPay never holds or routes the funds. It records
 * the transfer and verifies it on-chain so both sides see it in Activity.
 *
 *   created (intent: recipient, address, amount, memo fixed)
 *     ─(tx hash)─▶ pending ─(verified on-chain)─▶ confirmed
 *                          └─(mismatch / not found in time)─▶ failed
 *   created ─(unused for 30 min)─▶ expired
 */

export const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;
const RESERVED = new Set([
  "admin", "administrator", "aurapay", "support", "help", "nimiq", "nimiqpay", "root", "system", "api", "pay", "send",
  "receive", "status", "settings", "official", "team", "staff", "security", "wallet", "flutterwave", "me", "you", "null", "undefined",
]);
const INTENT_TTL_MS = 30 * 60_000;
const CONFIRM_GRACE_MS = 60 * 60_000;
const MAX_NOTE = 40;

export function normaliseUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Profile & usernames
// ---------------------------------------------------------------------------

export interface MyProfile {
  username: string | null;
  avatarUrl: string | null;
  receiveEvmAddress: string | null;
  displayCurrency: string;
}

async function defaultReceiveEvm(db: Db, userId: string, chosen: string | null): Promise<string | null> {
  const verified = await verifiedEvmAddresses(userId);
  if (chosen && verified.includes(chosen)) return chosen;
  return verified[0] ?? null;
}

export async function getMyProfile(userId: string): Promise<MyProfile> {
  const db = await getDb();
  const r = (await db.query<{ username: string | null; receive_evm_address: string | null; display_currency: string | null }>(
    "select username, receive_evm_address, display_currency from users where id = $1",
    [userId],
  ))[0];
  return {
    username: r?.username ?? null,
    avatarUrl: avatarUrl(userId, await avatarVersion(db, userId)),
    receiveEvmAddress: await defaultReceiveEvm(db, userId, r?.receive_evm_address ?? null),
    displayCurrency: r?.display_currency ?? "USD",
  };
}

export async function setUsername(userId: string, raw: string): Promise<MyProfile> {
  const username = normaliseUsername(raw);
  if (!USERNAME_RE.test(username)) {
    throw new AppError("INVALID_USERNAME", "Use 3–20 letters, numbers or underscores, starting with a letter.", 422);
  }
  if (RESERVED.has(username)) throw new AppError("USERNAME_RESERVED", "That username is reserved. Try another.", 409);
  const db = await getDb();
  try {
    await db.query("update users set username = $2, username_set_at = now() where id = $1", [userId, username]);
  } catch (err) {
    if (/unique|duplicate/i.test(errorMessage(err))) throw new AppError("USERNAME_TAKEN", `@${username} is taken. Try another.`, 409);
    throw err;
  }
  log.info("username.set", { username });
  return getMyProfile(userId);
}

export async function setReceiveEvmAddress(userId: string, address: string): Promise<MyProfile> {
  const a = address.toLowerCase();
  if (!(await verifiedEvmAddresses(userId)).includes(a)) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet before receiving USDT on it.", 422);
  const db = await getDb();
  await db.query("update users set receive_evm_address = $2 where id = $1", [userId, a]);
  return getMyProfile(userId);
}

export async function checkUsernameAvailable(raw: string): Promise<{ username: string; available: boolean; reason?: string }> {
  const username = normaliseUsername(raw);
  if (!USERNAME_RE.test(username)) return { username, available: false, reason: "Use 3–20 letters, numbers or underscores, starting with a letter." };
  if (RESERVED.has(username)) return { username, available: false, reason: "Reserved." };
  const db = await getDb();
  const taken = await db.query("select 1 from users where username = $1", [username]);
  return { username, available: taken.length === 0, ...(taken.length ? { reason: "Taken." } : {}) };
}

async function profileRow(db: Db, username: string) {
  return (
    await db.query<{ id: string; username: string; nimiq_address: string | null; receive_evm_address: string | null }>(
      "select id, username, nimiq_address, receive_evm_address from users where username = $1",
      [username],
    )
  )[0];
}

/** Public receiving details for a @username (signed-in users only; rate limited by the route). */
export async function resolveUsername(raw: string): Promise<UsernameProfile> {
  const username = normaliseUsername(raw);
  if (!USERNAME_RE.test(username)) throw new AppError("USER_NOT_FOUND", "No AuraPay user with that username.", 404);
  const db = await getDb();
  const u = await profileRow(db, username);
  if (!u || !u.nimiq_address) throw new AppError("USER_NOT_FOUND", `No AuraPay user called @${username}.`, 404);
  return {
    username: u.username,
    nimAddress: normaliseNimAddress(u.nimiq_address),
    polygonAddress: await defaultReceiveEvm(db, u.id, u.receive_evm_address),
    avatarUrl: avatarUrl(u.id, await avatarVersion(db, u.id)),
  };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; status: TransferStatus; from_user_id: string; to_user_id: string };

async function usernameOf(db: Db, userId: string): Promise<string> {
  return (await db.query<{ username: string | null }>("select username from users where id = $1", [userId]))[0]?.username ?? "unknown";
}

async function toDTO(db: Db, r: Row, viewerId: string): Promise<TransferDTO> {
  const sent = r.from_user_id === viewerId;
  return {
    id: r.id,
    ref: String(r.ref),
    direction: sent ? "sent" : "received",
    currency: r.currency as PayCurrency,
    amount: num(r.amount),
    amountAtomic: String(r.amount_atomic),
    amountUsd: numOrNull(r.amount_usd),
    counterparty: await usernameOf(db, sent ? r.to_user_id : r.from_user_id),
    toAddress: String(r.to_address),
    fromAddress: (r.from_address as string) ?? null,
    note: (r.note as string) ?? null,
    memo: (r.memo as string) ?? null,
    status: r.status,
    failureReason: (r.failure_reason as string) ?? null,
    txHash: (r.tx_hash as string) ?? null,
    network: String(r.network),
    createdAt: iso(r.created_at)!,
    confirmedAt: iso(r.confirmed_at),
  };
}

export interface CreateTransferInput {
  toUsername: string;
  currency: PayCurrency;
  amount: number;
  note?: string;
  /** USDT: the verified wallet the transfer will be sent from. */
  fromAddress?: string;
  /** A savings-circle contribution: which circle and round it pays. */
  circleId?: string;
  round?: number;
}

/** Step 1: fixes recipient address, exact amount and memo. The wallet then sends exactly this. */
export async function createTransfer(userId: string, input: CreateTransferInput): Promise<TransferDTO> {
  const db = await getDb();
  const me = (await db.query<{ username: string | null; nimiq_address: string | null }>("select username, nimiq_address from users where id = $1", [userId]))[0];
  if (!me?.username) throw new AppError("USERNAME_REQUIRED", "Choose your @username before sending.", 422);
  const to = await resolveUsername(input.toUsername);
  const recipient = await profileRow(db, to.username);
  if (recipient.id === userId) throw new AppError("SELF_TRANSFER", "You can't send to yourself.", 422);

  const note = input.note?.trim().slice(0, MAX_NOTE) || null;
  let atomic: bigint;
  let toAddress: string;
  let fromAddress: string;
  let memo: string | null = null;
  const ref = newRef("TX");
  if (input.currency === "NIM") {
    if (!config.nimiq.rpcUrl) throw new AppError("PAYMENT_RAIL_UNAVAILABLE", "NIM transfers aren't available right now.", 503);
    atomic = BigInt(Math.round(input.amount * 1e5));
    if (atomic < 1n) throw new AppError("INVALID_AMOUNT", "Enter an amount.", 422);
    toAddress = to.nimAddress;
    fromAddress = normaliseNimAddress(me.nimiq_address!);
    // The memo binds the on-chain transaction to this transfer (Nimiq data field, max 64 bytes).
    memo = `AuraPay ${ref}${note ? ` ${note}` : ""}`.slice(0, 64);
    while (new TextEncoder().encode(memo).length > 64) memo = memo.slice(0, -1);
  } else {
    if (!to.polygonAddress) throw new AppError("NO_USDT_ADDRESS", `@${to.username} hasn't set up a USDT wallet yet. Send NIM instead.`, 422);
    const from = input.fromAddress?.toLowerCase();
    if (!from || !isEvmAddress(from) || !(await verifiedEvmAddresses(userId)).includes(from)) {
      throw new AppError("PAYER_NOT_VERIFIED", "Verify your USDT wallet before sending USDT.", 422);
    }
    atomic = BigInt(Math.round(input.amount * 1e6));
    if (atomic < 1n) throw new AppError("INVALID_AMOUNT", "Enter an amount.", 422);
    toAddress = to.polygonAddress;
    fromAddress = from;
  }
  if (input.circleId) {
    if (!input.round) throw new AppError("INVALID_ROUND", "Missing thrift round.", 422);
    await checkContribution(db, userId, { circleId: input.circleId, round: input.round, toUserId: recipient.id, currency: input.currency, amountAtomic: atomic });
  }
  const amount = input.currency === "NIM" ? Number(atomic) / 1e5 : Number(atomic) / 1e6;
  const { rates } = await getRatesSafe();
  const usd = rates ? amount * (input.currency === "NIM" ? rates.nimUsd : rates.usdtUsd) : null;

  const rows = await db.query<Row>(
    `insert into transfers (ref, from_user_id, to_user_id, currency, chain, network, amount, amount_atomic, from_address, to_address, note, memo, status, amount_usd, circle_id, circle_round)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'created',$13,$14,$15) returning *`,
    [
      ref, userId, recipient.id, input.currency, input.currency === "NIM" ? "nimiq" : "polygon",
      input.currency === "NIM" ? config.nimiq.network : "polygon", amount, atomic.toString(), fromAddress, toAddress, note, memo, usd,
      input.circleId ?? null, input.circleId ? input.round : null,
    ],
  );
  log.info("transfer.created", { ref, currency: input.currency });
  return toDTO(db, rows[0], userId);
}

async function loadMine(db: Db, userId: string, id: string): Promise<Row> {
  const r = (await db.query<Row>("select * from transfers where id = $1 and (from_user_id = $2 or to_user_id = $2)", [id, userId]))[0];
  if (!r) throw new AppError("TRANSFER_NOT_FOUND", "Transfer not found.", 404);
  return r;
}

/** Step 2: the sender reports the transaction hash; it's verified now or on later reads. */
export async function submitTransfer(userId: string, id: string, txHashRaw: string): Promise<TransferDTO> {
  const db = await getDb();
  const t = await loadMine(db, userId, id);
  if (t.from_user_id !== userId) throw new AppError("TRANSFER_NOT_FOUND", "Transfer not found.", 404);
  if (t.status !== "created") return advanceTransfer(userId, id);
  if (Date.now() - new Date(t.created_at as string).getTime() > INTENT_TTL_MS) {
    await db.query("update transfers set status = 'expired', updated_at = now() where id = $1 and status = 'created'", [id]);
    throw new AppError("TRANSFER_EXPIRED", "This transfer expired. Please start again.", 409);
  }
  const txHash = txHashRaw.trim().toLowerCase();
  const ok = t.chain === "nimiq" ? /^[0-9a-f]{64}$/.test(txHash) : /^0x[0-9a-f]{64}$/.test(txHash);
  if (!ok) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);
  const [fromName, toName] = await Promise.all([usernameOf(db, t.from_user_id), usernameOf(db, t.to_user_id)]);
  try {
    await db.transaction(async (tx) => {
      const moved = await tx.query<Row>(
        "update transfers set status = 'pending', tx_hash = $2, updated_at = now() where id = $1 and status = 'created' returning *",
        [id, txHash],
      );
      if (!moved[0]) throw new AppError("ORDER_STATE_CHANGED", "This transfer changed state. Refresh and try again.", 409);
      await insertLedger(tx, {
        ref: String(t.ref),
        userId: t.from_user_id,
        category: "transfer_sent",
        title: `Sent to @${toName}`,
        subtitle: (t.note as string) ?? null,
        amount: num(t.amount),
        currency: String(t.currency),
        amountUsd: numOrNull(t.amount_usd),
        status: "pending",
        isSimulated: false,
        environment: config.nimiq.network === "testnet" && t.chain === "nimiq" ? "sandbox" : "production",
        provider: String(t.chain),
        chainTxHash: txHash,
        sourceTable: "transfers",
        sourceId: t.id,
        details: { to: toName, from: fromName, note: t.note ?? null },
      });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (/unique|duplicate/i.test(errorMessage(err))) throw new AppError("TX_ALREADY_USED", "This transaction has already been recorded.", 409);
    throw err;
  }
  return advanceTransfer(userId, id);
}

async function verify(t: Row) {
  const notBefore = new Date(new Date(t.created_at as string).getTime() - 2 * 60_000);
  if (t.chain === "nimiq") {
    return verifyNimiqTransfer({ txHash: String(t.tx_hash), expectedTo: String(t.to_address), minLuna: BigInt(String(t.amount_atomic)), expectedMemo: String(t.memo), notBefore });
  }
  return verifyPolygonUsdtTransfer({ txHash: String(t.tx_hash), expectedTo: String(t.to_address), expectedFrom: String(t.from_address), exactUnits: BigInt(String(t.amount_atomic)), notBefore });
}

async function advance(db: Db, t: Row): Promise<Row> {
  if (t.status === "created" && Date.now() - new Date(t.created_at as string).getTime() > INTENT_TTL_MS) {
    return (await db.query<Row>("update transfers set status = 'expired', updated_at = now() where id = $1 and status = 'created' returning *", [t.id]))[0] ?? t;
  }
  if (t.status !== "pending") return t;
  const result = await verify(t);
  if (result.state === "confirmed") {
    return db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        "update transfers set status = 'confirmed', confirmed_at = now(), from_address = coalesce($2, from_address), updated_at = now() where id = $1 and status = 'pending' returning *",
        [t.id, result.from ?? null],
      );
      const c = rows[0];
      if (!c) return (await tx.query<Row>("select * from transfers where id = $1", [t.id]))[0];
      await updateLedgerBySource(tx, "transfers", c.id, "transfer_sent", { status: "successful" });
      const fromName = await usernameOf(tx, c.from_user_id);
      await insertLedger(tx, {
        ref: `${c.ref}-IN`,
        userId: c.to_user_id,
        category: "transfer_received",
        title: `Received from @${fromName}`,
        subtitle: (c.note as string) ?? null,
        amount: num(c.amount),
        currency: String(c.currency),
        amountUsd: numOrNull(c.amount_usd),
        status: "successful",
        isSimulated: false,
        environment: config.nimiq.network === "testnet" && c.chain === "nimiq" ? "sandbox" : "production",
        provider: String(c.chain),
        chainTxHash: String(c.tx_hash),
        sourceTable: "transfers",
        sourceId: c.id,
        details: { from: fromName, note: c.note ?? null },
      });
      log.info("transfer.confirmed", { ref: c.ref, currency: c.currency });
      return c;
    });
  }
  const failNow = result.state === "rejected" || Date.now() - new Date(t.updated_at as string).getTime() > CONFIRM_GRACE_MS;
  if (failNow) {
    const reason = result.state === "rejected" ? result.reason : `Not confirmed in time: ${result.reason}`;
    const rows = await db.query<Row>("update transfers set status = 'failed', failure_reason = $2, updated_at = now() where id = $1 and status = 'pending' returning *", [t.id, reason]);
    await updateLedgerBySource(db, "transfers", t.id, "transfer_sent", { status: "failed", details: { statusReason: reason } });
    return rows[0] ?? t;
  }
  return { ...t, failure_reason: result.reason } as Row;
}

export async function advanceTransfer(userId: string, id: string): Promise<TransferDTO> {
  const db = await getDb();
  const t = await advance(db, await loadMine(db, userId, id));
  return toDTO(db, t, userId);
}

export async function listTransfers(userId: string, limit = 50): Promise<TransferDTO[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `select * from transfers where (from_user_id = $1 and status <> 'created' and status <> 'expired') or (to_user_id = $1 and status = 'confirmed')
     order by created_at desc limit $2`,
    [userId, limit],
  );
  // Keep pending ones moving.
  const out: TransferDTO[] = [];
  for (const r of rows) out.push(await toDTO(db, r.status === "pending" ? await advance(db, r) : r, userId));
  return out;
}

/** Recent people this user sent to (for quick re-send). */
export async function recentRecipients(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ username: string }>(
    `select u.username from transfers t join users u on u.id = t.to_user_id
     where t.from_user_id = $1 and t.status in ('pending', 'confirmed') and u.username is not null
     group by u.username order by max(t.created_at) desc limit 8`,
    [userId],
  );
  return rows.map((r) => r.username);
}
