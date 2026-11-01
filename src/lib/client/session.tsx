"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { useWallet } from "./wallet";

/**
 * Wallet-signature session.
 *  - Inside Nimiq Pay: signInHere() asks Nimiq Pay to sign a server challenge.
 *  - Anywhere else: startRemote() returns a code + deep link/QR; the user approves
 *    inside Nimiq Pay and this browser receives its own session when it polls.
 */

export interface SessionInfo {
  address: string;
  evmAddresses: string[];
  username: string | null;
  receiveEvmAddress: string | null;
}

export interface RemoteRequest {
  id: string;
  code: string;
  pollToken: string;
  deepLink: string;
  approveUrl: string;
  expiresAt: string;
}

interface SessionApi {
  user: SessionInfo | null;
  loading: boolean;
  refresh(): Promise<void>;
  signInHere(): Promise<void>;
  startRemote(): Promise<RemoteRequest>;
  pollRemote(r: RemoteRequest): Promise<"pending" | "approved" | "expired" | "consumed">;
  signOut(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [user, setUser] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: SessionInfo | null }>("/api/auth/session");
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ user: SessionInfo | null }>("/api/auth/session")
      .then((r) => !cancelled && setUser(r.user))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Inside Nimiq Pay, a signed-in user's wallet is (re)connected automatically so
  // balances show on every visit, not only right after signing in.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!user || wallet.host !== "nimiq-pay" || wallet.nimiq.status !== "idle" || autoConnected.current) return;
    autoConnected.current = true;
    void wallet.connectNimiq().catch(() => {});
  }, [user, wallet]);

  const signInHere = useCallback(async () => {
    const ch = await api<{ id: string; message: string }>("/api/auth/challenge", { method: "POST", json: { mode: "local" } });
    const signed = await wallet.signNimiq(ch.message);
    await api("/api/auth/verify", { method: "POST", json: { challengeId: ch.id, ...signed } });
    await refresh();
  }, [wallet, refresh]);

  const startRemote = useCallback(
    () => api<RemoteRequest>("/api/auth/challenge", { method: "POST", json: { mode: "remote" } }),
    [],
  );

  const pollRemote = useCallback(
    async (r: RemoteRequest) => {
      const res = await api<{ status: "pending" | "approved" | "expired" | "consumed" }>("/api/auth/remote/poll", {
        method: "POST",
        json: { id: r.id, pollToken: r.pollToken },
      });
      if (res.status === "approved") await refresh();
      return res.status;
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api("/api/auth/session", { method: "DELETE" }).catch(() => {});
    wallet.disconnect();
    setUser(null);
  }, [wallet]);

  const value = useMemo(
    () => ({ user, loading, refresh, signInHere, startRemote, pollRemote, signOut }),
    [user, loading, refresh, signInHere, startRemote, pollRemote, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used inside <SessionProvider>");
  return c;
}
