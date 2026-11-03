import { z } from "zod";
import { removeAvatar, setAvatar } from "@/lib/server/avatars";
import { enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({ image: z.string().max(400_000) });

/** Sets your profile picture (a data: URL the app has already cropped and resized). */
export const PUT = handler(async (req) => {
  enforceRateLimit(req, "me:avatar", 20, 60 * 60);
  const user = await requireUser();
  const { image } = await parseBody(req, Body);
  return json({ avatarUrl: await setAvatar(user.id, image) });
});

export const DELETE = handler(async (req) => {
  enforceRateLimit(req, "me:avatar", 20, 60 * 60);
  const user = await requireUser();
  await removeAvatar(user.id);
  return json({ avatarUrl: null });
});
