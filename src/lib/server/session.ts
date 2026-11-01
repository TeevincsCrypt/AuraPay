import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { config } from "./config";
import { getDb } from "./db";

/**
 * Anonymous device session.
 *
 * A random id lives in an HttpOnly, signed cookie; only its SHA-256 is stored.
 * Orders, beneficiaries and positions are scoped to this session's user row.
 * Wallet addresses are *linked* to the session but are not proof of ownership —
 * payment ownership is proven on-chain during verification instead.
 */

const COOKIE = "ap_session";
const MAX_AGE = 60 * 60 * 24 * 180;

function sign(id: string): string {
  return createHmac("sha256", config.sessionSecret()).update(id).digest("base64url");
}

function verify(token: string | undefined): string | null {
  if (!token) return null;
  const [id, mac] = token.split(".");
  if (!id || !mac) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return id;
}

const hash = (id: string) => createHash("sha256").update(id).digest("hex");

export interface SessionUser {
  id: string;
}

/** Returns the current user, creating a session (and cookie) if needed. */
export async function requireUser(): Promise<SessionUser> {
  const jar = await cookies();
  let sid = verify(jar.get(COOKIE)?.value);
  const isNew = !sid;
  if (!sid) sid = randomBytes(24).toString("base64url");

  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `insert into users (session_hash) values ($1)
     on conflict (session_hash) do update set last_seen_at = now()
     returning id`,
    [hash(sid)],
  );

  if (isNew) {
    jar.set(COOKIE, `${sid}.${sign(sid)}`, {
      httpOnly: true,
      // Nimiq Pay loads mini apps in a WebView; Lax works for same-site requests.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: MAX_AGE,
    });
  }
  return { id: rows[0].id };
}

/** Returns the current user only if a valid session already exists. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const sid = verify(jar.get(COOKIE)?.value);
  if (!sid) return null;
  const db = await getDb();
  const rows = await db.query<{ id: string }>("select id from users where session_hash = $1", [hash(sid)]);
  return rows[0] ? { id: rows[0].id } : null;
}
