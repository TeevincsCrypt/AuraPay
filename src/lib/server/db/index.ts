import "server-only";
import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { errorMessage, log } from "../log";
import { ConfigError } from "../http";

/**
 * Minimal database abstraction shared by two drivers:
 *   - `postgres` (Supabase / any Postgres via DATABASE_URL) — production path
 *   - `@electric-sql/pglite` (embedded Postgres) — zero-config dev/demo fallback
 *
 * Both run the exact same SQL migrations from supabase/migrations.
 */

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run a multi-statement SQL script (migrations only). */
  exec(script: string): Promise<void>;
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

export type DbKind = "postgres" | "pglite-persistent" | "pglite-memory";

interface DbState {
  db: Db;
  kind: DbKind;
}

const globalForDb = globalThis as unknown as { __aurapayDb?: Promise<DbState> };

async function createPostgres(url: string): Promise<DbState> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    prepare: !/:6543\b/.test(url),
    onnotice: () => {},
  });

  // `unsafe(text, params)` is used only with static SQL text + bound parameters.
  type Runner = {
    unsafe: (
      text: string,
      params?: never[],
    ) => PromiseLike<unknown> & { simple(): PromiseLike<unknown> };
  };
  const wrap = (s: Runner, root: boolean): Db => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await s.unsafe(text, params as never[])) as T[];
    },
    async exec(script: string) {
      await s.unsafe(script).simple();
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (!root) return fn(wrap(s, false));
      return (await sql.begin((tx) =>
        fn(wrap(tx as unknown as Runner, false)),
      )) as R;
    },
  });
  return { db: wrap(sql as unknown as Runner, true), kind: "postgres" };
}

async function createPglite(dir: string | undefined): Promise<DbState> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir) await mkdir(dir, { recursive: true });
  const pg = dir ? new PGlite(dir) : new PGlite();
  await pg.waitReady;

  type Runner = {
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(script: string): Promise<unknown>;
  };
  // PGlite is a single connection: serialise top-level transactions so they never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const wrap = (s: Runner, root: boolean): Db => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await s.query<T>(text, params)).rows;
    },
    async exec(script: string) {
      await s.exec(script);
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (!root) return fn(wrap(s, false));
      const run = queue.then(() =>
        pg.transaction((tx) => fn(wrap(tx as unknown as Runner, false))),
      );
      queue = run.catch(() => undefined);
      return run as Promise<R>;
    },
  });
  return {
    db: wrap(pg as unknown as Runner, true),
    kind: dir ? "pglite-persistent" : "pglite-memory",
  };
}

async function migrate({ db, kind }: DbState): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (
      await db.query<{ name: string }>("select name from schema_migrations")
    ).map((r) => r.name),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const script = await readFile(path.join(dir, file), "utf8");
    log.info("db.migrate", { file, kind });
    try {
      await migrateOne(db, kind, file, script);
    } catch (err) {
      log.error("db.migration_failed", { file, error: errorMessage(err) });
      throw new ConfigError(
        `setting up the database failed at ${file}: ${errorMessage(err).slice(0, 200)}.`,
      );
    }
  }
}

async function migrateOne(
  db: Db,
  kind: DbKind,
  file: string,
  script: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialise concurrent cold starts; the loser sees the migration as applied and skips it.
    if (kind === "postgres")
      await tx.query("select pg_advisory_xact_lock(727274)");
    if (
      (
        await tx.query("select 1 from schema_migrations where name = $1", [
          file,
        ])
      ).length
    )
      return;
    await tx.exec(script);
    await tx.query("insert into schema_migrations (name) values ($1)", [file]);
  });
}

/**
 * Turns a database connection/setup failure into an actionable message. Never includes
 * the connection string or password — only the error class and Postgres' own message.
 */
export function describeDbError(err: unknown, url?: string): string | null {
  const e = err as { code?: string; message?: string; errno?: string } | null;
  const code = String(e?.code ?? e?.errno ?? "");
  const msg = String(e?.message ?? err ?? "");
  let host = "";
  try {
    host = url ? new URL(url).host.replace(/^.*@/, "") : "";
  } catch {
    return "DATABASE_URL isn't a valid connection string. If the password has special characters (@ # / ? %), URL-encode them or reset the password to letters and digits.";
  }
  const isDirect = /^db\.[a-z0-9]+\.supabase\.co(:\d+)?$/i.test(host);
  if (code === "28P01" || /password authentication failed/i.test(msg)) {
    return "the database rejected the password in DATABASE_URL. Make sure [YOUR-PASSWORD] was replaced with your Supabase database password (Supabase → Project Settings → Database → Reset password if unsure), then redeploy.";
  }
  if (/tenant or user not found/i.test(msg)) {
    return "Supabase's pooler didn't recognise the user. Copy the URI again from Supabase → Connect → Transaction pooler — the user must look like postgres.<project-ref> — then redeploy.";
  }
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "CONNECT_TIMEOUT",
      "ECONNRESET",
    ].includes(code) ||
    /connect|timeout|getaddrinfo/i.test(msg)
  ) {
    return isDirect
      ? "Vercel can't reach Supabase's direct connection (db.<ref>.supabase.co is IPv6-only). Use the Transaction pooler URI from Supabase → Connect (host …pooler.supabase.com, port 6543) as DATABASE_URL, then redeploy."
      : `couldn't reach the database at ${host || "the configured host"} (${code || "connection error"}). Check the host in DATABASE_URL — use Supabase's Transaction pooler URI (port 6543) — and that the Supabase project isn't paused.`;
  }
  if (code === "3D000" || /database .* does not exist/i.test(msg))
    return "the database named in DATABASE_URL doesn't exist. Supabase's is called postgres (…:6543/postgres).";
  if (/ssl|certificate/i.test(msg))
    return "the database connection failed during SSL setup. Use the URI exactly as Supabase shows it (Transaction pooler).";
  return null;
}

async function init(): Promise<DbState> {
  let state: DbState;
  if (config.databaseUrl) {
    try {
      state = await createPostgres(config.databaseUrl);
      await state.db.query("select 1");
    } catch (err) {
      log.error("db.connect_failed", {
        code: (err as { code?: string }).code ?? null,
        error: errorMessage(err),
      });
      throw new ConfigError(
        describeDbError(err, config.databaseUrl) ??
          `couldn't connect to the database (${errorMessage(err).slice(0, 160)}).`,
      );
    }
    // On by default (tracked in schema_migrations, so each file runs once); DB_AUTO_MIGRATE=false opts out.
    if (process.env.DB_AUTO_MIGRATE !== "false") await migrate(state);
  } else {
    if (!config.allowEmbeddedDb) {
      // Names only, never values: helps tell a missing variable from one scoped to another environment.
      const target = process.env.VERCEL_ENV
        ? `this ${process.env.VERCEL_ENV} deployment`
        : "this server";
      log.error("db.not_configured", {
        vercelEnv: process.env.VERCEL_ENV ?? null,
        deployment: process.env.VERCEL_URL ?? null,
      });
      throw new ConfigError(
        `the database (DATABASE_URL) is not set for ${target}. In Vercel, add it under Settings → Environment Variables with "${process.env.VERCEL_ENV === "preview" ? "Preview" : "Production"}" ticked, then redeploy.`,
      );
    }
    state = await createPglite(config.pgliteDir);
    await migrate(state);
  }
  log.info("db.ready", { kind: state.kind });
  return state;
}

export async function getDbState(): Promise<DbState> {
  globalForDb.__aurapayDb ??= init().catch((err) => {
    globalForDb.__aurapayDb = undefined;
    throw err;
  });
  return globalForDb.__aurapayDb;
}

export async function getDb(): Promise<Db> {
  return (await getDbState()).db;
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function iso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date
    ? v.toISOString()
    : new Date(String(v)).toISOString();
}
