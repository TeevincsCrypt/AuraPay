import "server-only";

/**
 * Fixed-window rate limiter keyed by client + bucket.
 *
 * In-memory: effective per server instance. On multi-instance deployments put a
 * shared limiter (e.g. Upstash / Vercel Firewall rules) in front for global limits.
 */

interface Window {
  count: number;
  resetAt: number;
}

const store = (globalThis as unknown as { __apRate?: Map<string, Window> }).__apRate ?? new Map<string, Window>();
(globalThis as unknown as { __apRate?: Map<string, Window> }).__apRate = store;

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  const w = store.get(key);
  if (!w || w.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    if (store.size > 10_000) {
      for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
    }
    return { ok: true, retryAfterSeconds: 0 };
  }
  w.count += 1;
  if (w.count > limit) return { ok: false, retryAfterSeconds: Math.ceil((w.resetAt - now) / 1000) };
  return { ok: true, retryAfterSeconds: 0 };
}
