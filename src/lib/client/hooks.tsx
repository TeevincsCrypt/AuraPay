"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { IntegrationStatus } from "@/lib/shared/types";
import { api, ApiError } from "./api";

export interface Query<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

interface Snapshot<T> {
  path: string | null;
  data: T | undefined;
  error: ApiError | null;
}

const toApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e), 0));

/**
 * Minimal fetch hook: fetches on mount / path change, supports refetch and polling,
 * and keeps the previous data visible while a new path loads (stale-while-refresh).
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): Query<T> {
  const [snap, setSnap] = useState<Snapshot<T>>({ path: null, data: undefined, error: null });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const load = () =>
      api<T>(path).then(
        (data) => !cancelled && setSnap({ path, data, error: null }),
        (e) => !cancelled && setSnap((s) => ({ path, data: s.data, error: toApiError(e) })),
      );
    void load();
    const timer = opts.pollMs ? setInterval(load, opts.pollMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, opts.pollMs]);

  const refetch = useCallback(async () => {
    if (!path) return;
    setRefreshing(true);
    try {
      const data = await api<T>(path);
      setSnap({ path, data, error: null });
    } catch (e) {
      setSnap((s) => ({ path, data: s.data, error: toApiError(e) }));
    } finally {
      setRefreshing(false);
    }
  }, [path]);

  return {
    data: snap.data,
    error: snap.path === path ? snap.error : null,
    loading: Boolean(path) && (snap.path !== path || refreshing),
    refetch,
  };
}

const StatusContext = createContext<Query<IntegrationStatus> | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const q = useApi<IntegrationStatus>("/api/status");
  return <StatusContext.Provider value={q}>{children}</StatusContext.Provider>;
}

export function useStatus(): Query<IntegrationStatus> {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useStatus must be used inside <StatusProvider>");
  return ctx;
}
