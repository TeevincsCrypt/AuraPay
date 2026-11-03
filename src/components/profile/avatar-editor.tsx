"use client";

import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import { Avatar, Button, Notice } from "../ui";

const SIZE = 320;

/** Center-crops to a square and resizes in the browser, so only a small image is uploaded. */
async function toAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a photo.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This photo format isn't supported here. Try a JPEG or PNG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process the photo.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  // WebP where the browser can encode it (smaller), JPEG otherwise.
  const webp = canvas.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}

export function AvatarEditor({ size = 52 }: { size?: number }) {
  const session = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const user = session.user;
  if (!user) return null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      await api("/api/me/avatar", { method: "PUT", json: { image: await toAvatarDataUrl(file) } });
      await session.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => input.current?.click()} className="relative shrink-0 rounded-full" aria-label="Change profile picture" disabled={busy}>
          <Avatar seed={user.address} size={size} src={user.avatarUrl} />
          <span className="absolute -right-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full bg-fg text-white ring-2 ring-surface">
            <Camera className="size-3.5" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-fg">{user.username ? `@${user.username}` : "Nimiq account"}</p>
          <p className="truncate font-mono text-xs text-fg-3">{user.address}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>
          <Camera className="size-4" /> {user.avatarUrl ? "Change photo" : "Add profile photo"}
        </Button>
        {user.avatarUrl ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/me/avatar", { method: "DELETE" });
                await session.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 className="size-4" /> Remove
          </Button>
        ) : null}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/*" className="hidden" aria-label="Profile photo file" onChange={(e) => void upload(e.target.files?.[0])} />
      {err ? <Notice tone="error">{err}</Notice> : null}
    </div>
  );
}
