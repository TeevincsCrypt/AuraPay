import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { verifyMessage } from "viem";
import { getDb } from "../db";
import { AppError } from "../http";
import { log } from "../log";
import { createSession, upsertUserByAddress, type SessionUser } from "../session";
import { verifyNimiqSignature } from "./nimiq-signature";

/**
 * Sign-in with Nimiq Pay.
 *
 *  local  — inside Nimiq Pay: request challenge → nimiq.sign(message) → verify → session.
 *  remote — any other browser: request challenge → show QR / code → the user opens
 *           https://nimpay.app/miniapps/open/<host>/auth/approve?code=… inside Nimiq Pay,
 *           signs there → the waiting browser polls with its secret poll token and
 *           receives its own session once the challenge is approved (single use).
 *
 * Messages are ASCII, bind the domain, a random nonce and an expiry, and say
 * explicitly that the signature authorises no payment.
 */

const TTL_MS = 5 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function newCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normaliseCode(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : "";
}

function signInMessage(domain: string, ref: string, nonce: string, issued: Date, expires: Date): string {
  return [
    "Sign in to AuraPay",
    "",
    `Domain: ${domain}`,
    `Request: ${ref}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issued.toISOString()}`,
    `Expires at: ${expires.toISOString()}`,
    "",
    "This signature proves you control this Nimiq account.",
    "It does not authorize any payment or transaction.",
  ].join("\n");
}

export async function createSignInChallenge(kind: "local" | "remote", domain: string, userAgent: string | null) {
  const db = await getDb();
  const issued = new Date();
  const expires = new Date(issued.getTime() + TTL_MS);
  const nonce = randomBytes(16).toString("hex");
  const code = kind === "remote" ? newCode() : null;
  const pollToken = kind === "remote" ? randomBytes(24).toString("base64url") : null;
  const message = signInMessage(domain, code ?? `local-${nonce.slice(0, 8)}`, nonce, issued, expires);
  const rows = await db.query<{ id: string }>(
    `insert into auth_challenges (kind, message, code, poll_token_hash, status, requester_ua, expires_at)
     values ($1,$2,$3,$4,'pending',$5,$6) returning id`,
    [kind, message, code, pollToken ? sha(pollToken) : null, userAgent?.slice(0, 300) ?? null, expires],
  );
  return { id: rows[0].id, message, code, pollToken, expiresAt: expires.toISOString() };
}

type ChallengeRow = {
  id: string;
  kind: string;
  message: string;
  code: string | null;
  poll_token_hash: string | null;
  status: string;
  user_id: string | null;
  address: string | null;
  requester_ua: string | null;
  created_at: Date;
  expires_at: Date;
};

const expired = (r: ChallengeRow) => new Date(r.expires_at).getTime() < Date.now();

/** In-app sign-in: verifies the signature and signs this browser in. */
export async function completeLocalSignIn(challengeId: string, publicKey: string, signature: string, userAgent: string | null): Promise<SessionUser> {
  const db = await getDb();
  const rows = await db.query<ChallengeRow>("select * from auth_challenges where id = $1 and kind = 'local'", [challengeId]);
  const ch = rows[0];
  if (!ch || ch.status !== "pending" || expired(ch)) throw new AppError("CHALLENGE_INVALID", "This sign-in request expired. Please try again.", 400);
  const verified = verifyNimiqSignature(ch.message, publicKey, signature);
  if (!verified) throw new AppError("SIGNATURE_INVALID", "The wallet signature could not be verified.", 401);

  return db.transaction(async (tx) => {
    const claimed = await tx.query(
      "update auth_challenges set status = 'consumed', address = $2, approved_at = now(), consumed_at = now() where id = $1 and status = 'pending' returning id",
      [ch.id, verified.address],
    );
    if (!claimed[0]) throw new AppError("CHALLENGE_INVALID", "This sign-in request was already used.", 400);
    const userId = await upsertUserByAddress(tx, verified.address, verified.publicKey);
    await tx.query("update auth_challenges set user_id = $2 where id = $1", [ch.id, userId]);
    await createSession(tx, userId, userAgent);
    log.info("auth.signed_in", { kind: "local" });
    return { id: userId, nimiqAddress: verified.address };
  });
}

/** What the approving Nimiq Pay user sees before signing a remote request. */
export async function lookupRemoteChallenge(codeRaw: string) {
  const code = normaliseCode(codeRaw);
  if (!code) throw new AppError("CODE_INVALID", "Enter the 8-character code shown on the other screen.", 422);
  const db = await getDb();
  const rows = await db.query<ChallengeRow>("select * from auth_challenges where code = $1 and kind = 'remote'", [code]);
  const ch = rows[0];
  if (!ch || ch.status !== "pending" || expired(ch)) throw new AppError("CODE_INVALID", "This code is invalid or has expired.", 404);
  return { code, message: ch.message, requesterUserAgent: ch.requester_ua, createdAt: new Date(ch.created_at).toISOString(), expiresAt: new Date(ch.expires_at).toISOString() };
}

/** Approves a remote request from inside Nimiq Pay (also signs the approving device in). */
export async function approveRemoteSignIn(codeRaw: string, publicKey: string, signature: string, userAgent: string | null): Promise<SessionUser> {
  const code = normaliseCode(codeRaw);
  const db = await getDb();
  const rows = await db.query<ChallengeRow>("select * from auth_challenges where code = $1 and kind = 'remote'", [code]);
  const ch = rows[0];
  if (!ch || ch.status !== "pending" || expired(ch)) throw new AppError("CODE_INVALID", "This code is invalid or has expired.", 404);
  const verified = verifyNimiqSignature(ch.message, publicKey, signature);
  if (!verified) throw new AppError("SIGNATURE_INVALID", "The wallet signature could not be verified.", 401);
  return db.transaction(async (tx) => {
    const userId = await upsertUserByAddress(tx, verified.address, verified.publicKey);
    const updated = await tx.query(
      "update auth_challenges set status = 'approved', user_id = $2, address = $3, approved_at = now() where id = $1 and status = 'pending' returning id",
      [ch.id, userId, verified.address],
    );
    if (!updated[0]) throw new AppError("CODE_INVALID", "This code was already used.", 409);
    await createSession(tx, userId, userAgent);
    log.info("auth.remote_approved", {});
    return { id: userId, nimiqAddress: verified.address };
  });
}

/** Polled by the requesting browser. On approval, issues that browser's session exactly once. */
export async function pollRemoteSignIn(challengeId: string, pollToken: string, userAgent: string | null) {
  const db = await getDb();
  const rows = await db.query<ChallengeRow>("select * from auth_challenges where id = $1 and kind = 'remote'", [challengeId]);
  const ch = rows[0];
  if (!ch || !ch.poll_token_hash || ch.poll_token_hash !== sha(pollToken)) throw new AppError("NOT_FOUND", "Sign-in request not found.", 404);
  if (ch.status === "pending") return { status: expired(ch) ? "expired" : "pending" } as const;
  if (ch.status !== "approved") return { status: ch.status === "consumed" ? "consumed" : "expired" } as const;
  return db.transaction(async (tx) => {
    const claimed = await tx.query("update auth_challenges set status = 'consumed', consumed_at = now() where id = $1 and status = 'approved' returning id", [ch.id]);
    if (!claimed[0]) return { status: "consumed" } as const;
    await createSession(tx, ch.user_id!, userAgent);
    return { status: "approved", address: ch.address } as const;
  });
}

// ---------------------------------------------------------------------------
// EVM wallet linking (USDT on Polygon, tokenised stocks, Aave) — proven by personal_sign
// ---------------------------------------------------------------------------

export async function createEvmLinkChallenge(user: SessionUser, address: string, domain: string) {
  const db = await getDb();
  const expires = new Date(Date.now() + TTL_MS);
  const message = [
    "Link this wallet to AuraPay",
    "",
    `Domain: ${domain}`,
    `Nimiq account: ${user.nimiqAddress}`,
    `EVM address: ${address.toLowerCase()}`,
    `Nonce: ${randomBytes(16).toString("hex")}`,
    `Expires at: ${expires.toISOString()}`,
    "",
    "This signature does not authorize any payment or transaction.",
  ].join("\n");
  const rows = await db.query<{ id: string }>(
    "insert into auth_challenges (kind, message, status, user_id, address, expires_at) values ('evm_link',$1,'pending',$2,$3,$4) returning id",
    [message, user.id, address.toLowerCase(), expires],
  );
  return { id: rows[0].id, message };
}

export async function completeEvmLink(user: SessionUser, challengeId: string, signature: string) {
  const db = await getDb();
  const rows = await db.query<ChallengeRow>("select * from auth_challenges where id = $1 and kind = 'evm_link' and user_id = $2", [challengeId, user.id]);
  const ch = rows[0];
  if (!ch || ch.status !== "pending" || expired(ch) || !ch.address) throw new AppError("CHALLENGE_INVALID", "This request expired. Please try again.", 400);
  let ok = false;
  try {
    ok = await verifyMessage({ address: ch.address as `0x${string}`, message: ch.message, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new AppError("SIGNATURE_INVALID", "The wallet signature could not be verified.", 401);
  await db.transaction(async (tx) => {
    await tx.query("update auth_challenges set status = 'consumed', approved_at = now(), consumed_at = now() where id = $1 and status = 'pending'", [ch.id]);
    await tx.query(
      `insert into wallet_connections (user_id, chain, network, address, source, verified_at) values ($1,'polygon','evm',$2,'evm_provider', now())
       on conflict (user_id, chain, address) do update set verified_at = now(), last_seen_at = now()`,
      [user.id, ch.address],
    );
  });
  return { address: ch.address };
}

export async function verifiedEvmAddresses(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ address: string }>(
    "select address from wallet_connections where user_id = $1 and chain = 'polygon' and verified_at is not null order by last_seen_at desc",
    [userId],
  );
  return rows.map((r) => r.address);
}
