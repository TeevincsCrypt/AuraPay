import "server-only";
import { getDb, type Db } from "./db";
import { AppError } from "./http";

/** Largest accepted image after the browser has resized it (a 320px WebP is ~15–40 KB). */
export const MAX_AVATAR_BYTES = 256 * 1024;

/** Identifies the image type from its first bytes; anything else (incl. SVG) is refused. */
export function sniffImage(buf: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => buf[i] === b)) return "image/png";
  if (buf.length >= 12 && String.fromCharCode(...buf.slice(0, 4)) === "RIFF" && String.fromCharCode(...buf.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export const avatarUrl = (userId: string, version: number | null | undefined) => (version ? `/api/avatars/${userId}?v=${version}` : null);

export async function avatarVersion(db: Db, userId: string): Promise<number | null> {
  return (await db.query<{ version: number }>("select version from user_avatars where user_id = $1", [userId]))[0]?.version ?? null;
}

export async function setAvatar(userId: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new AppError("INVALID_IMAGE", "Upload a JPEG, PNG or WebP picture.", 422);
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_AVATAR_BYTES) throw new AppError("IMAGE_TOO_LARGE", "That picture is too large. Try another one.", 413);
  const mime = sniffImage(buf);
  if (!mime) throw new AppError("INVALID_IMAGE", "Upload a JPEG, PNG or WebP picture.", 422);
  const db = await getDb();
  const rows = await db.query<{ version: number }>(
    `insert into user_avatars (user_id, mime, image_b64) values ($1, $2, $3)
     on conflict (user_id) do update set mime = excluded.mime, image_b64 = excluded.image_b64, version = user_avatars.version + 1, updated_at = now()
     returning version`,
    [userId, mime, buf.toString("base64")],
  );
  return avatarUrl(userId, rows[0].version)!;
}

export async function removeAvatar(userId: string): Promise<void> {
  const db = await getDb();
  await db.query("delete from user_avatars where user_id = $1", [userId]);
}

export async function readAvatar(userId: string): Promise<{ mime: string; body: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const db = await getDb();
  const r = (await db.query<{ mime: string; image_b64: string }>("select mime, image_b64 from user_avatars where user_id = $1", [userId]))[0];
  return r ? { mime: r.mime, body: Buffer.from(r.image_b64, "base64") } : null;
}
