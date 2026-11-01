"use client";

import { useEffect, useState } from "react";
import { AtSign, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import { Button, Input, Notice } from "../ui";

const RE = /^[a-z][a-z0-9_]{2,19}$/;

/** Claim or change the signed-in user's @username, with a live availability check. */
export function UsernameEditor({ onSaved, compact }: { onSaved?: () => void; compact?: boolean }) {
  const session = useSession();
  const current = session.user?.username ?? null;
  const [value, setValue] = useState(current ?? "");
  const [check, setCheck] = useState<{ username: string; available: boolean; reason?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = value.trim().replace(/^@+/, "").toLowerCase();
  const changed = name !== (current ?? "");

  useEffect(() => {
    if (!changed || !RE.test(name)) return;
    let alive = true;
    const t = setTimeout(() => {
      api<{ username: string; available: boolean; reason?: string }>(`/api/users/check?username=${encodeURIComponent(name)}`)
        .then((r) => alive && setCheck(r))
        .catch(() => {});
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [name, changed]);

  const fresh = check?.username === name ? check : null;
  const formatError = name && !RE.test(name) ? "3–20 letters, numbers or _, starting with a letter." : null;
  const canSave = changed && !formatError && fresh?.available === true;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api("/api/me/username", { method: "POST", json: { username: name } });
      await session.refresh();
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="Username"
          lead={<AtSign className="size-4" />}
          placeholder="yourname"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={21}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\s/g, ""))}
        />
        <Button className={compact ? "shrink-0" : "shrink-0 px-5"} disabled={!canSave} loading={saving} onClick={save}>
          {current ? "Save" : "Claim"}
        </Button>
      </div>
      <p className="min-h-4 text-xs">
        {!changed ? (
          current ? (
            <span className="inline-flex items-center gap-1 text-up">
              <CheckCircle2 className="size-3.5" /> @{current} is yours
            </span>
          ) : (
            <span className="text-fg-3">Friends can send you NIM and USDT with it.</span>
          )
        ) : formatError ? (
          <span className="text-fg-3">{formatError}</span>
        ) : fresh ? (
          fresh.available ? <span className="text-up">@{name} is available</span> : <span className="text-down">@{name}: {fresh.reason ?? "unavailable"}</span>
        ) : (
          <span className="text-fg-3">Checking…</span>
        )}
      </p>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </div>
  );
}
