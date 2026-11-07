import "server-only";
import { createPublicClient, createWalletClient, decodeEventLog, getAddress, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ERC20_ABI, TOKENS } from "@/lib/shared/polygon-defi";
import { SAVINGS_VAULT_ABI, type SavingsInfo, type SavingsLockDTO } from "@/lib/shared/savings";
import { verifiedEvmAddresses } from "./auth/challenges";
import { config } from "./config";
import { getDb, iso, num, type Db } from "./db";
import { AppError } from "./http";
import { insertLedger, newRef, updateLedgerBySource } from "./ledger";
import { errorMessage, log } from "./log";
import { polygonRpc } from "./payments/polygon";

/**
 * Savings: USDT locked in the AuraPay Savings Vault on Polygon until a time the user chose.
 * The user's wallet sends the lock; the contract holds the funds and only ever pays them back to
 * their owner, and not before the unlock time. AuraPay never custodies anything. Every state
 * change here comes from a verified receipt or an on-chain read.
 */

const USDT = TOKENS.USDT.address.toLowerCase();
const isAddr = (a: string | undefined | null): a is string => Boolean(a && /^0x[0-9a-fA-F]{40}$/.test(a));
const client = () => createPublicClient({ chain: polygon, transport: http(config.polygon.rpcUrl, { timeout: 12_000 }), batch: { multicall: false } });

/** The vault address from SAVINGS_VAULT_ADDRESS: a bare 0x address, or one inside a pasted Polygonscan link. */
function configuredVault(): { address: string | null; raw: string | undefined } {
  const raw = config.savings.vaultAddress;
  const m = raw?.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g);
  return { address: m && m.length === 1 ? m[0] : null, raw };
}

export function savingsInfo(): SavingsInfo {
  const { address: vault, raw } = configuredVault();
  if (!isAddr(vault)) {
    return {
      enabled: false,
      reason: raw
        ? "Savings isn't switched on yet: SAVINGS_VAULT_ADDRESS is set but isn't a valid 0x… contract address."
        : "Savings isn't switched on yet: the Savings Vault contract hasn't been deployed for this app.",
      vaultAddress: null,
      autoRelease: false,
    };
  }
  return { enabled: true, reason: null, vaultAddress: vault.toLowerCase(), autoRelease: Boolean(relayerAccount()) };
}

function vaultOrThrow(): Address {
  const info = savingsInfo();
  if (!info.enabled || !info.vaultAddress) throw new AppError("SAVINGS_UNAVAILABLE", info.reason ?? "Savings is unavailable.", 409);
  return getAddress(info.vaultAddress);
}

function relayerAccount() {
  const key = config.savings.relayerKey;
  if (!key) return null;
  try {
    return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  } catch {
    log.error("savings.relayer_key_invalid", {});
    return null;
  }
}

type Row = Record<string, unknown> & { id: string; user_id: string; status: SavingsLockDTO["status"] };

function toDTO(r: Row): SavingsLockDTO {
  const unlockAt = iso(r.unlock_at);
  return {
    id: r.id,
    ref: String(r.ref),
    label: (r.label as string) ?? null,
    amount: r.amount === null || r.amount === undefined ? null : num(r.amount),
    unlockAt,
    status: r.status,
    unlocked: Boolean(unlockAt && new Date(unlockAt).getTime() <= Date.now()),
    lockId: r.lock_id === null || r.lock_id === undefined ? null : String(r.lock_id),
    ownerAddress: String(r.owner_address),
    lockTxHash: String(r.lock_tx_hash),
    releaseTxHash: (r.release_tx_hash as string) ?? null,
    releasedBy: (r.released_by as SavingsLockDTO["releasedBy"]) ?? null,
    failureReason: (r.failure_reason as string) ?? null,
    createdAt: iso(r.created_at)!,
    releasedAt: iso(r.released_at),
  };
}

interface Receipt {
  status: string;
  from?: string;
  to?: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

function vaultEvents(rc: Receipt, vault: string) {
  return rc.logs
    .filter((l) => l.address.toLowerCase() === vault.toLowerCase())
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: SAVINGS_VAULT_ABI, data: l.data as `0x${string}`, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] })];
      } catch {
        return [];
      }
    });
}

async function receipt(hash: string): Promise<Receipt | null | "unavailable"> {
  try {
    return await polygonRpc<Receipt>("eth_getTransactionReceipt", [hash]);
  } catch (err) {
    log.warn("savings.rpc_failed", { error: errorMessage(err) });
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// State transitions (each guarded by the current status, so they happen once)
// ---------------------------------------------------------------------------

async function markReleased(db: Db, r: Row, p: { txHash: string | null; by: "owner" | "auto" | "other" }): Promise<Row> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<Row>(
      `update savings_locks set status = 'released', release_tx_hash = coalesce($2, release_tx_hash), released_by = $3, released_at = now(), updated_at = now()
       where id = $1 and status = 'locked' returning *`,
      [r.id, p.txHash, p.by],
    );
    const u = rows[0];
    if (!u) return (await tx.query<Row>("select * from savings_locks where id = $1", [r.id]))[0];
    const amount = num(u.amount);
    await insertLedger(tx, {
      ref: newRef("SV"),
      userId: u.user_id,
      category: "savings_release",
      title: "Savings unlocked",
      subtitle: u.label ? String(u.label) : "Savings Vault · Polygon",
      amount,
      currency: "USDT",
      amountUsd: amount,
      status: "successful",
      isSimulated: false,
      environment: "production",
      provider: "aurapay-vault",
      chainTxHash: p.txHash,
      sourceTable: "savings_locks",
      sourceId: u.id,
      details: { releasedBy: p.by },
    });
    log.info("savings.released", { ref: u.ref, by: p.by });
    return u;
  });
}

/** Moves a lock forward from what the chain says: pending → locked/failed, locked → released. */
async function advance(db: Db, r: Row): Promise<Row> {
  const vault = String(r.vault_address);
  if (r.status === "pending") {
    const rc = await receipt(String(r.lock_tx_hash));
    let fail: string | null = null;
    if (rc === "unavailable") return r;
    if (!rc) {
      if (Date.now() - new Date(r.created_at as string).getTime() < 30 * 60_000) return r;
      fail = "The lock transaction wasn't confirmed in time.";
    } else if (rc.status !== "0x1") fail = "The lock transaction reverted on Polygon. Nothing was locked.";
    else if (rc.from && rc.from.toLowerCase() !== String(r.owner_address)) fail = "The transaction came from a different wallet.";
    else if (rc.to && rc.to.toLowerCase() !== vault) fail = "The transaction wasn't sent to the Savings Vault.";
    if (!fail && rc) {
      const ev = vaultEvents(rc, vault).find((e) => e.eventName === "Locked");
      const a = ev?.args as { id: bigint; owner: string; token: string; amount: bigint; unlockAt: bigint } | undefined;
      if (!a || a.owner.toLowerCase() !== String(r.owner_address) || a.token.toLowerCase() !== USDT) fail = "This transaction didn't lock USDT from your wallet.";
      else {
        const amount = Number(a.amount) / 1e6;
        const rows = await db.query<Row>(
          `update savings_locks set status = 'locked', lock_id = $2, amount = $3, unlock_at = to_timestamp($4), locked_at = now(), updated_at = now()
           where id = $1 and status = 'pending' returning *`,
          [r.id, a.id.toString(), amount, Number(a.unlockAt)],
        );
        const u = rows[0] ?? (await db.query<Row>("select * from savings_locks where id = $1", [r.id]))[0];
        await db.query("update transactions set amount = $2, amount_usd = $2 where source_table = 'savings_locks' and source_id = $1 and category = 'savings_lock'", [r.id, amount]);
        await updateLedgerBySource(db, "savings_locks", r.id, "savings_lock", { status: "successful" });
        log.info("savings.locked", { ref: u.ref, lockId: a.id.toString() });
        return u;
      }
    }
    const rows = await db.query<Row>(
      "update savings_locks set status = 'failed', failure_reason = $2, updated_at = now() where id = $1 and status = 'pending' returning *",
      [r.id, fail],
    );
    await updateLedgerBySource(db, "savings_locks", r.id, "savings_lock", { status: "failed", details: { statusReason: fail } });
    return rows[0] ?? r;
  }
  if (r.status === "locked" && r.unlock_at && new Date(r.unlock_at as string).getTime() <= Date.now() && r.lock_id !== null) {
    // Matured: if anyone released it on-chain (the owner from another app, the relayer, anyone), reflect that.
    try {
      const l = await client().readContract({ address: getAddress(vault), abi: SAVINGS_VAULT_ABI, functionName: "getLock", args: [BigInt(String(r.lock_id))] });
      if (l.released) return markReleased(db, r, { txHash: null, by: "other" });
    } catch (err) {
      log.warn("savings.read_failed", { ref: r.ref, error: errorMessage(err) });
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function recordLock(userId: string, input: { txHash: string; from: string; label?: string | null }): Promise<SavingsLockDTO> {
  const vault = vaultOrThrow().toLowerCase();
  const from = input.from.toLowerCase();
  if (!(await verifiedEvmAddresses(userId)).includes(from)) throw new AppError("PAYER_NOT_VERIFIED", "Verify this wallet first.", 422);
  const hash = input.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);
  const label = input.label?.trim().slice(0, 40) || null;
  const db = await getDb();
  const ref = newRef("SV");
  let row: Row;
  try {
    row = await db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        `insert into savings_locks (ref, user_id, label, vault_address, owner_address, token, lock_tx_hash, status)
         values ($1,$2,$3,$4,$5,$6,$7,'pending') returning *`,
        [ref, userId, label, vault, from, USDT, hash],
      );
      await insertLedger(tx, {
        ref,
        userId,
        category: "savings_lock",
        title: "Locked in Savings",
        subtitle: label ?? "Savings Vault · Polygon",
        amount: 0,
        currency: "USDT",
        amountUsd: null,
        status: "pending",
        isSimulated: false,
        environment: "production",
        provider: "aurapay-vault",
        chainTxHash: hash,
        sourceTable: "savings_locks",
        sourceId: rows[0].id,
        details: {},
      });
      return rows[0];
    });
  } catch (err) {
    if (/unique|duplicate/i.test(errorMessage(err))) {
      const existing = (await db.query<Row>("select * from savings_locks where chain = 'polygon' and lock_tx_hash = $1", [hash]))[0];
      if (existing && existing.user_id === userId) return toDTO(await advance(db, existing));
      throw new AppError("TX_ALREADY_USED", "This transaction has already been recorded.", 409);
    }
    throw err;
  }
  return toDTO(await advance(db, row));
}

export async function listLocks(userId: string): Promise<SavingsLockDTO[]> {
  const db = await getDb();
  const rows = await db.query<Row>("select * from savings_locks where user_id = $1 order by created_at desc limit 100", [userId]);
  const out: SavingsLockDTO[] = [];
  for (const r of rows) {
    const due = r.status === "locked" && r.unlock_at && new Date(r.unlock_at as string).getTime() <= Date.now();
    out.push(toDTO(r.status === "pending" || due ? await advance(db, r) : r));
  }
  return out;
}

export async function getLock(userId: string, id: string): Promise<SavingsLockDTO> {
  const db = await getDb();
  const r = (await db.query<Row>("select * from savings_locks where id = $1 and user_id = $2", [id, userId]))[0];
  if (!r) throw new AppError("NOT_FOUND", "Savings lock not found.", 404);
  return toDTO(await advance(db, r));
}

/** Records a release the owner sent from their wallet; confirmed only from its receipt. */
export async function recordRelease(userId: string, id: string, txHash: string): Promise<SavingsLockDTO> {
  const db = await getDb();
  const r = (await db.query<Row>("select * from savings_locks where id = $1 and user_id = $2", [id, userId]))[0];
  if (!r) throw new AppError("NOT_FOUND", "Savings lock not found.", 404);
  if (r.status === "released") return toDTO(r);
  if (r.status !== "locked" || r.lock_id === null) throw new AppError("NOT_LOCKED", "This savings lock isn't active.", 409);
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new AppError("INVALID_TX_HASH", "That doesn't look like a valid transaction hash.", 422);
  for (let i = 0; i < 4; i++) {
    const rc = await receipt(hash);
    if (rc && rc !== "unavailable") {
      if (rc.status !== "0x1") throw new AppError("RELEASE_FAILED", "The release transaction reverted on Polygon.", 422);
      const ev = vaultEvents(rc, String(r.vault_address)).find((e) => e.eventName === "Released" && (e.args as { id: bigint }).id.toString() === String(r.lock_id));
      if (!ev) throw new AppError("RELEASE_FAILED", "That transaction didn't release this savings lock.", 422);
      const by = rc.from?.toLowerCase() === String(r.owner_address) ? "owner" : "other";
      return toDTO(await markReleased(db, r, { txHash: hash, by }));
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return toDTO(await advance(db, r));
}

/**
 * Releases matured locks on time (cron). Needs SAVINGS_RELAYER_PRIVATE_KEY: a key that only pays
 * gas. release() always pays the lock's owner, so the relayer can't redirect funds.
 */
export async function autoReleaseDue(limit = 20): Promise<{ released: number; skipped?: string }> {
  const info = savingsInfo();
  const account = relayerAccount();
  if (!info.enabled || !info.vaultAddress) return { released: 0, skipped: "savings disabled" };
  const db = await getDb();
  const due = await db.query<Row>(
    `select * from savings_locks where status = 'locked' and unlock_at <= now() and lock_id is not null
       and (release_attempted_at is null or release_attempted_at < now() - interval '10 minutes')
     order by unlock_at limit $1`,
    [limit],
  );
  let released = 0;
  const vault = getAddress(info.vaultAddress);
  for (const r0 of due) {
    const r = await advance(db, r0); // already released on-chain?
    if (r.status !== "locked") {
      if (r.status === "released") released++;
      continue;
    }
    if (!account) continue;
    await db.query("update savings_locks set release_attempted_at = now() where id = $1", [r.id]);
    try {
      const wallet = createWalletClient({ account, chain: polygon, transport: http(config.polygon.rpcUrl, { timeout: 20_000 }) });
      const hash = await wallet.writeContract({ address: vault, abi: SAVINGS_VAULT_ABI, functionName: "release", args: [BigInt(String(r.lock_id))] });
      const rc = await client().waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 2_000 });
      if (rc.status === "success") {
        await markReleased(db, r, { txHash: hash.toLowerCase(), by: "auto" });
        released++;
      } else log.warn("savings.auto_release_reverted", { ref: r.ref, hash });
    } catch (err) {
      log.warn("savings.auto_release_failed", { ref: r.ref, error: errorMessage(err) });
    }
  }
  return account ? { released } : { released, skipped: "no relayer key (owners release manually)" };
}

/** USDT the wallet has approved to the Savings Vault (so the app only asks for approval when needed). */
export async function vaultAllowance(address: string): Promise<number> {
  const vault = vaultOrThrow();
  const units = await client().readContract({ address: getAddress(USDT), abi: ERC20_ABI, functionName: "allowance", args: [getAddress(address), vault] });
  return Number(units) / 1e6;
}
