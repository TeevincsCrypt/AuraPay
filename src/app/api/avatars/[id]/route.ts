import { readAvatar } from "@/lib/server/avatars";
import { enforceRateLimit, handler } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Serves a profile picture. URLs carry ?v=<version>, so a new upload gets a new URL. */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "avatars:get", 600, 60);
  const { id } = await ctx.params;
  const img = await readAvatar(id);
  if (!img) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(img.body), {
    headers: {
      "Content-Type": img.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
