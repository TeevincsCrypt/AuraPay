import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { errorMessage, log } from "./log";
import { rateLimit } from "./ratelimit";

/** Error with a stable machine code and a user-safe message. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "local";
}

const LIMIT_MULTIPLIER = Math.max(0.1, Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1) || 1);

export function enforceRateLimit(req: Request, bucket: string, limit: number, windowSeconds: number) {
  const r = rateLimit(`${bucket}:${clientKey(req)}`, Math.ceil(limit * LIMIT_MULTIPLIER), windowSeconds);
  if (!r.ok) {
    throw new AppError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", 429, {
      retryAfterSeconds: r.retryAfterSeconds,
    });
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(
      "VALIDATION_ERROR",
      first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request.",
      422,
    );
  }
  return parsed.data;
}

export function parseQuery<T>(url: string, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError("VALIDATION_ERROR", first ? `${first.path.join(".")}: ${first.message}` : "Invalid query.", 422);
  }
  return parsed.data;
}

/** Wraps a route handler with uniform error handling. Never leaks internals. */
export function handler<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof AppError) {
        const headers: Record<string, string> = {};
        if (err.code === "RATE_LIMITED" && err.details?.retryAfterSeconds) {
          headers["Retry-After"] = String(err.details.retryAfterSeconds);
        }
        return NextResponse.json(
          { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
          { status: err.status, headers },
        );
      }
      log.error("api.unhandled", { path: new URL(req.url).pathname, error: errorMessage(err) });
      return NextResponse.json(
        { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Please try again." } },
        { status: 500 },
      );
    }
  };
}

export function requireAdmin(req: Request, token: string | undefined) {
  if (!token) throw new AppError("ADMIN_DISABLED", "Admin API is disabled (ADMIN_API_TOKEN not set).", 403);
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Constant-time-ish comparison.
  if (given.length !== token.length) throw new AppError("UNAUTHORIZED", "Unauthorized.", 401);
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) throw new AppError("UNAUTHORIZED", "Unauthorized.", 401);
}
