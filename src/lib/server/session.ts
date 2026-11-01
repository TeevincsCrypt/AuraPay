import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { config } from "./config";
import { getDb, type Db } from "./db";
import { AppError } from "./http";

/**
 * Authenticated sessions. A session is created only after a Nimiq Pay wallet
 * signature has been verified (see auth/challenges.ts). The cookie carries an
 * opaque random token; the database stores only its SHA-256.
 */

export const SESSION_COOKIE = "ap_session";
const SESSION_DAYS = 30;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionUser {
  id: string;
  nimiqAddress: string;
}

export async function createSession(db: Db, userId: string, userAgent: string | null): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.query("insert into sessions (token_hash, user_id, user_agent, expires_at) values ($1,$2,$3,$4)", [
    hash(token),
    userId,
    userAgent?.slice(0, 300) ?? null,
    expires,
  ]);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProdRuntime && !config.testMode,
    path: "/",
    expires,
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const db = await getDb();
  const rows = await db.query<{ id: string; nimiq_address: string; session_id: string; last_seen_at: Date }>(
    `select u.id, u.nimiq_address, s.id as session_id, s.last_seen_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.nimiq_address is not null`,
    [hash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60_000) {
    await db.query("update sessions set last_seen_at = now() where id = $1", [row.session_id]);
  }
  return { id: row.id, nimiqAddress: row.nimiq_address };
}

/** Throws 401 unless the request carries a valid wallet-authenticated session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Sign in with Nimiq Pay to continue.", 401);
  return user;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.query("update sessions set revoked_at = now() where token_hash = $1", [hash(token)]);
  }
  jar.delete(SESSION_COOKIE);
}

export async function upsertUserByAddress(db: Db, address: string, publicKey: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into users (nimiq_address, nimiq_public_key) values ($1, $2)
     on conflict (nimiq_address) do update set nimiq_public_key = excluded.nimiq_public_key, last_seen_at = now()
     returning id`,
    [address, publicKey],
  );
  return rows[0].id;
}
