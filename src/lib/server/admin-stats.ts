import "server-only";
import { getDb, iso, num } from "./db";

/**
 * Operator dashboard numbers. "Users" are accounts that signed in with a Nimiq wallet signature
 * (users.nimiq_address set). Bills count every delivered order (sandbox ones only exist with test keys).
 */

export interface AdminStats {
  generatedAt: string;
  users: {
    total: number;
    withUsername: number;
    withPolygonWallet: number;
    withPhoto: number;
    active24h: number;
    active7d: number;
    active30d: number;
    new7d: number;
  };
  signupsByDay: { day: string; count: number }[];
  activity: {
    bills: { count: number; usd: number; byService: { service: string; count: number }[] };
    billsByCurrency: { currency: string; count: number; usd: number }[];
    transfers: { currency: string; count: number; amount: number }[];
    thrifts: { status: string; count: number }[];
    savings: { active: number; lockedUsdt: number; released: number };
    earnDeposits: number;
    swaps: number;
    schedules: number;
  };
  recentUsers: {
    username: string | null;
    nimAddress: string;
    polygonVerified: boolean;
    hasPhoto: boolean;
    joinedAt: string;
    lastActiveAt: string | null;
    bills: number;
    transfers: number;
  }[];
}

const short = (a: string) => {
  const s = a.replace(/\s+/g, "");
  return `${s.slice(0, 4)} ${s.slice(4, 8)} … ${s.slice(-4)}`;
};

/** Each count is independent: a table that doesn't exist yet (older database) just reads as zero. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function adminStats(): Promise<AdminStats> {
  const db = await getDb();
  const one = async (sql: string, params: unknown[] = []) => num((await db.query<{ n: unknown }>(sql, params))[0]?.n ?? 0);

  // Last activity per user: the most recent of the user row and any of their sessions.
  const ACTIVE = `
    with act as (
      select u.id, greatest(u.last_seen_at, coalesce(max(s.last_seen_at), u.last_seen_at)) as last_active
      from users u left join sessions s on s.user_id = u.id
      where u.nimiq_address is not null group by u.id, u.last_seen_at
    )`;

  const [total, withUsername, withPolygonWallet, withPhoto, active24h, active7d, active30d, new7d] = await Promise.all([
    one("select count(*) as n from users where nimiq_address is not null"),
    one("select count(*) as n from users where nimiq_address is not null and username is not null"),
    one("select count(distinct user_id) as n from wallet_connections where chain = 'polygon' and verified_at is not null"),
    safe(() => one("select count(*) as n from user_avatars"), 0),
    one(`${ACTIVE} select count(*) as n from act where last_active > now() - interval '1 day'`),
    one(`${ACTIVE} select count(*) as n from act where last_active > now() - interval '7 days'`),
    one(`${ACTIVE} select count(*) as n from act where last_active > now() - interval '30 days'`),
    one("select count(*) as n from users where nimiq_address is not null and created_at > now() - interval '7 days'"),
  ]);

  const signups = await db.query<{ day: unknown; n: unknown }>(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*) as n from users
     where nimiq_address is not null and created_at > now() - interval '30 days' group by 1 order by 1`,
  );

  const bills = (await db.query<{ n: unknown; usd: unknown }>(
    "select count(*) as n, coalesce(sum(total_usd), 0) as usd from utility_orders where status = 'successful'",
  ))[0];
  const byService = await db.query<{ service: string; n: unknown }>(
    "select service, count(*) as n from utility_orders where status = 'successful' group by service order by 2 desc",
  );
  const billsByCurrency = await db.query<{ currency: string; n: unknown; usd: unknown }>(
    "select pay_currency as currency, count(*) as n, coalesce(sum(total_usd), 0) as usd from utility_orders where status = 'successful' group by 1 order by 2 desc",
  );
  const transfers = await safe(
    () => db.query<{ currency: string; n: unknown; amount: unknown }>("select currency, count(*) as n, coalesce(sum(amount), 0) as amount from transfers where status = 'confirmed' group by 1 order by 2 desc"),
    [],
  );
  const thrifts = await safe(() => db.query<{ status: string; n: unknown }>("select status, count(*) as n from savings_circles group by 1 order by 2 desc"), []);
  const savings = await safe(
    async () =>
      (await db.query<{ active: unknown; locked: unknown; released: unknown }>(
        `select count(*) filter (where status = 'locked') as active, coalesce(sum(amount) filter (where status = 'locked'), 0) as locked,
                count(*) filter (where status = 'released') as released from savings_locks`,
      ))[0],
    { active: 0, locked: 0, released: 0 },
  );
  const earnDeposits = await safe(() => one("select count(*) as n from defi_actions where kind = 'earn_supply' and status = 'confirmed'"), 0);
  const swaps = await safe(() => one("select count(*) as n from defi_actions where kind = 'swap' and status = 'confirmed'"), 0);
  const schedules = await safe(() => one("select count(*) as n from bill_schedules where status in ('active', 'completed')"), 0);

  const recent = await db.query<Record<string, unknown>>(
    `${ACTIVE}
     select u.username, u.nimiq_address, u.created_at, a.last_active,
       exists(select 1 from wallet_connections w where w.user_id = u.id and w.chain = 'polygon' and w.verified_at is not null) as polygon,
       (select count(*) from utility_orders o where o.user_id = u.id and o.status = 'successful') as bills,
       (select count(*) from transfers t where t.from_user_id = u.id and t.status = 'confirmed') as transfers
     from users u join act a on a.id = u.id
     order by u.created_at desc limit 100`,
  );
  const photos = new Set(await safe(async () => (await db.query<{ user_id: string }>("select user_id from user_avatars")).map((r) => r.user_id), [] as string[]));
  const ids = await db.query<{ id: string; nimiq_address: string }>("select id, nimiq_address from users where nimiq_address is not null");
  const idByAddr = new Map(ids.map((r) => [r.nimiq_address, r.id]));

  return {
    generatedAt: new Date().toISOString(),
    users: { total, withUsername, withPolygonWallet, withPhoto, active24h, active7d, active30d, new7d },
    signupsByDay: signups.map((r) => ({ day: String(r.day), count: num(r.n) })),
    activity: {
      bills: { count: num(bills?.n ?? 0), usd: num(bills?.usd ?? 0), byService: byService.map((r) => ({ service: r.service, count: num(r.n) })) },
      billsByCurrency: billsByCurrency.map((r) => ({ currency: r.currency, count: num(r.n), usd: num(r.usd) })),
      transfers: transfers.map((r) => ({ currency: r.currency, count: num(r.n), amount: num(r.amount) })),
      thrifts: thrifts.map((r) => ({ status: r.status, count: num(r.n) })),
      savings: { active: num(savings.active), lockedUsdt: num(savings.locked), released: num(savings.released) },
      earnDeposits,
      swaps,
      schedules,
    },
    recentUsers: recent.map((r) => ({
      username: (r.username as string) ?? null,
      nimAddress: short(String(r.nimiq_address)),
      polygonVerified: Boolean(r.polygon),
      hasPhoto: photos.has(idByAddr.get(String(r.nimiq_address)) ?? ""),
      joinedAt: iso(r.created_at)!,
      lastActiveAt: iso(r.last_active),
      bills: num(r.bills),
      transfers: num(r.transfers),
    })),
  };
}
