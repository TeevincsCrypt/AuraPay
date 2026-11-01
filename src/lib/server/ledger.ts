import "server-only";
import { randomBytes } from "node:crypto";
import type { ActivityCategory, ActivityItem, ActivityStatus } from "@/lib/shared/types";
import { iso, num, numOrNull, type Db } from "./db";

/** Unified activity ledger (`transactions` table). */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Human-friendly unique reference, e.g. "AP-7K2M9QX4TB". */
export function newRef(prefix = "AP"): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${s}`;
}

export interface LedgerEntry {
  ref: string;
  userId: string;
  category: ActivityCategory;
  title: string;
  subtitle?: string | null;
  amount: number;
  currency: string;
  amountUsd?: number | null;
  status: ActivityStatus;
  isSimulated: boolean;
  environment: "production" | "sandbox" | "simulated";
  provider?: string | null;
  providerRef?: string | null;
  chainTxHash?: string | null;
  sourceTable: string;
  sourceId: string;
  details?: Record<string, unknown>;
}

export async function insertLedger(db: Db, e: LedgerEntry): Promise<void> {
  await db.query(
    `insert into transactions (ref, user_id, category, title, subtitle, amount, currency, amount_usd, status,
       is_simulated, environment, provider, provider_ref, chain_tx_hash, source_table, source_id, details)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      e.ref, e.userId, e.category, e.title, e.subtitle ?? null, e.amount, e.currency, e.amountUsd ?? null, e.status,
      e.isSimulated, e.environment, e.provider ?? null, e.providerRef ?? null, e.chainTxHash ?? null,
      e.sourceTable, e.sourceId, JSON.stringify(e.details ?? {}),
    ],
  );
}

export async function updateLedgerBySource(
  db: Db,
  sourceTable: string,
  sourceId: string,
  category: ActivityCategory,
  patch: { status?: ActivityStatus; providerRef?: string | null; chainTxHash?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `update transactions set
       status = coalesce($4, status),
       provider_ref = coalesce($5, provider_ref),
       chain_tx_hash = coalesce($6, chain_tx_hash),
       details = case when $7::jsonb is null then details else details || $7::jsonb end,
       updated_at = now()
     where source_table = $1 and source_id = $2 and category = $3`,
    [
      sourceTable, sourceId, category, patch.status ?? null, patch.providerRef ?? null, patch.chainTxHash ?? null,
      patch.details ? JSON.stringify(patch.details) : null,
    ],
  );
}

export function mapLedgerRow(r: Record<string, unknown>): ActivityItem {
  return {
    id: String(r.id),
    ref: String(r.ref),
    category: r.category as ActivityCategory,
    title: String(r.title),
    subtitle: (r.subtitle as string) ?? null,
    amount: num(r.amount),
    currency: String(r.currency),
    amountUsd: numOrNull(r.amount_usd),
    status: r.status as ActivityStatus,
    isSimulated: Boolean(r.is_simulated),
    environment: String(r.environment),
    provider: (r.provider as string) ?? null,
    providerRef: (r.provider_ref as string) ?? null,
    chainTxHash: (r.chain_tx_hash as string) ?? null,
    sourceTable: String(r.source_table),
    sourceId: String(r.source_id),
    details: (typeof r.details === "string" ? JSON.parse(r.details) : r.details ?? {}) as Record<string, unknown>,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export async function listActivity(db: Db, userId: string, limit = 50): Promise<ActivityItem[]> {
  const rows = await db.query(
    "select * from transactions where user_id = $1 order by created_at desc limit $2",
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapLedgerRow);
}
