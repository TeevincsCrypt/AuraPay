import "server-only";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha256";

/**
 * Nimiq signed-message verification, matching exactly what Nimiq Pay's mini-app
 * host does for `nimiq.sign(message)` (nimiq/nimiq-pay-app, useMiniAppHost.ts):
 *
 *   payload = utf8("\x16Nimiq Signed Message:\n" + byteLength(message)) ‖ utf8(message)
 *   signature = Ed25519.sign(sha256(payload))
 *
 * The same scheme is used by the Nimiq Keyguard / Hub `signMessage`.
 * Addresses are the first 20 bytes of Blake2b-256(publicKey), rendered in Nimiq's
 * IBAN-style user-friendly format ("NQ" + 2 check digits + 32 base32 chars).
 */

const PREFIX = "\x16Nimiq Signed Message:\n";
const BASE32 = "0123456789ABCDEFGHJKLMNPQRSTUVXY";

export function signedMessageHash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`${PREFIX}${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  return sha256(payload);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** IBAN mod-97 over the rearranged string, with letters expanded A=10 … Z=35. */
function ibanCheck(s: string): string {
  const expanded = s
    .toUpperCase()
    .split("")
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join("");
  let rem = 0;
  for (let i = 0; i < expanded.length; i += 6) rem = Number(`${rem}${expanded.slice(i, i + 6)}`) % 97;
  return String(98 - rem).padStart(2, "0");
}

/** Nimiq user-friendly address (with spaces every 4 chars) for 20 raw address bytes. */
export function toUserFriendlyAddress(addressBytes: Uint8Array): string {
  if (addressBytes.length !== 20) throw new Error("address must be 20 bytes");
  const b32 = base32(addressBytes);
  const check = ibanCheck(`${b32}NQ00`);
  return `NQ${check}${b32}`.replace(/(.{4})/g, "$1 ").trim();
}

export function addressFromPublicKey(publicKeyHex: string): string {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 32) throw new Error("public key must be 32 bytes");
  return toUserFriendlyAddress(blake2b(pub, { dkLen: 32 }).subarray(0, 20));
}

/** True when the address' check digits are valid (format + checksum). */
export function isValidNimiqAddress(address: string): boolean {
  const a = address.replace(/\s+/g, "").toUpperCase();
  if (!/^NQ[0-9]{2}[0-9A-HJ-NP-VXY]{32}$/.test(a)) return false;
  return ibanCheck(`${a.slice(4)}NQ00`) === a.slice(2, 4);
}

export interface VerifiedSignature {
  address: string; // user-friendly, spaced
  publicKey: string; // lowercase hex
}

/**
 * Verifies a Nimiq Pay signature over `message` and returns the signer's address.
 * Returns null for any malformed input or invalid signature.
 */
export function verifyNimiqSignature(message: string, publicKeyHex: string, signatureHex: string): VerifiedSignature | null {
  try {
    const pub = hexToBytes(publicKeyHex);
    const sig = hexToBytes(signatureHex);
    if (pub.length !== 32 || sig.length !== 64) return null;
    if (!ed25519.verify(sig, signedMessageHash(message), pub)) return null;
    return { address: addressFromPublicKey(publicKeyHex), publicKey: publicKeyHex.toLowerCase().replace(/^0x/, "") };
  } catch {
    return null;
  }
}
