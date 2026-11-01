import "server-only";
import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { log } from "../log";
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
  type Runner = { unsafe: (text: string, params?: never[]) => PromiseLike<unknown> & { simple(): PromiseLike<unknown> } };
  const wrap = (s: Runner, root: boolean): Db => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await s.unsafe(text, params as never[])) as T[];
    },
    async exec(script: string) {
      await s.unsafe(script).simple();
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (!root) return fn(wrap(s, false));
      return (await sql.begin((tx) => fn(wrap(tx as unknown as Runner, false)))) as R;
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
      const run = queue.then(() => pg.transaction((tx) => fn(wrap(tx as unknown as Runner, false))));
      queue = run.catch(() => undefined);
      return run as Promise<R>;
    },
  });
  return { db: wrap(pg as unknown as Runner, true), kind: dir ? "pglite-persistent" : "pglite-memory" };
}

async function migrate({ db, kind }: DbState): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const script = await readFile(path.join(dir, file), "utf8");
    log.info("db.migrate", { file, kind });
    await db.transaction(async (tx) => {
      await tx.exec(script);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
    });
  }
}

async function init(): Promise<DbState> {
  let state: DbState;
  if (config.databaseUrl) {
    state = await createPostgres(config.databaseUrl);
    if (process.env.DB_AUTO_MIGRATE === "true") await migrate(state);
  } else {
    if (!config.allowEmbeddedDb) {
      throw new ConfigError("the database (DATABASE_URL) is not configured.");
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
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}
