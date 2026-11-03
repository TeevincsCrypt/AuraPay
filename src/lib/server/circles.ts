import "server-only";
import { verifiedEvmAddresses } from "./auth/challenges";
import { getDb, iso, num, type Db } from "./db";
import { AppError } from "./http";
import { newRef } from "./ledger";
import { log } from "./log";
import { addInterval } from "./recurring";

/**
 * Thrift: rotating group savings (members contribute each round; one member takes the pot).
 *
 * N members each contribute the same amount every period; each round one member (in payout
 * order) receives everyone else's contributions. Contributions go **directly from each
 * member's wallet to that round's recipient** as verified @username transfers tagged with the
 * circle and round; AuraPay never holds the pot. Round k is due at start + (k-1) periods.
 *
 *   forming (organizer invites; members accept/decline) ─(organizer starts)─▶ active ─(all rounds paid)─▶ completed
 *   forming ─(organizer cancels)─▶ cancelled
 */

const MAX_MEMBERS = 20;
const normaliseUsername = (raw: string) => raw.trim().replace(/^@+/, "").toLowerCase();

export interface CircleMemberDTO {
  username: string;
  position: number;
  status: "invited" | "joined" | "declined";
  isOrganizer: boolean;
  isMe: boolean;
}

export interface CircleRoundDTO {
  round: number;
  recipient: string;
  dueAt: string;
  paid: number; // confirmed contributions
  expected: number; // members − 1
  complete: boolean;
  contributions: { username: string; status: "confirmed" | "pending" | "missing"; transferId: string | null }[];
}

export interface CircleDTO {
  id: string;
  ref: string;
  name: string;
  currency: "NIM" | "USDT";
  contribution: number;
  contributionAtomic: string;
  frequency: "weekly" | "monthly";
  startAt: string;
  status: "forming" | "active" | "completed" | "cancelled";
  organizer: string;
  isOrganizer: boolean;
  myStatus: "invited" | "joined" | "declined";
  members: CircleMemberDTO[];
  rounds: CircleRoundDTO[];
  currentRound: number | null;
  pot: number; // what each recipient receives
  myAction: { type: "accept" | "pay" | "receive" | "start" | "wait" | "none"; round?: number; to?: string; dueAt?: string } | null;
}

type CircleRow = { id: string; ref: string; name: string; organizer_id: string; currency: "NIM" | "USDT"; contribution: string; contribution_atomic: string; frequency: "weekly" | "monthly"; start_at: string; status: CircleDTO["status"] };
type MemberRow = { user_id: string; username: string | null; position: number; status: CircleMemberDTO["status"] };

async function members(db: Db, circleId: string): Promise<MemberRow[]> {
  return db.query<MemberRow>(
    "select m.user_id, u.username, m.position, m.status from circle_members m join users u on u.id = m.user_id where m.circle_id = $1 order by m.position",
    [circleId],
  );
}

async function buildDTO(db: Db, c: CircleRow, viewerId: string): Promise<CircleDTO> {
  const ms = await members(db, c.id);
  const active = ms.filter((m) => m.status === "joined");
  const me = ms.find((m) => m.user_id === viewerId);
  const organizer = ms.find((m) => m.user_id === c.organizer_id);
  const amount = num(c.contribution);

  let rounds: CircleRoundDTO[] = [];
  if (c.status === "active" || c.status === "completed") {
    const tx = await db.query<{ id: string; from_user_id: string; circle_round: number; status: string }>(
      "select id, from_user_id, circle_round, status from transfers where circle_id = $1 and status in ('pending', 'confirmed')",
      [c.id],
    );
    rounds = active.map((recipient, idx) => {
      const round = idx + 1;
      const contributions = active
        .filter((m) => m.user_id !== recipient.user_id)
        .map((m) => {
          const t = tx.find((x) => x.circle_round === round && x.from_user_id === m.user_id && x.status === "confirmed") ?? tx.find((x) => x.circle_round === round && x.from_user_id === m.user_id);
          return { username: m.username ?? "?", status: (t ? t.status : "missing") as "confirmed" | "pending" | "missing", transferId: t?.id ?? null };
        });
      const paid = contributions.filter((x) => x.status === "confirmed").length;
      return {
        round,
        recipient: recipient.username ?? "?",
        dueAt: addInterval(new Date(c.start_at), c.frequency, idx).toISOString(),
        paid,
        expected: contributions.length,
        complete: paid === contributions.length,
        contributions,
      };
    });
  }
  const current = rounds.find((r) => !r.complete) ?? null;

  let myAction: CircleDTO["myAction"] = null;
  if (me?.status === "invited" && c.status === "forming") myAction = { type: "accept" };
  else if (c.status === "forming") myAction = c.organizer_id === viewerId ? { type: "start" } : { type: "wait" };
  else if (c.status === "active" && me) {
    // The earliest round the viewer still owes, else whether they're receiving now.
    const owed = rounds.find((r) => r.recipient !== me.username && r.contributions.find((x) => x.username === me.username)?.status === "missing" && new Date(r.dueAt).getTime() <= Date.now() + 3 * 86_400_000);
    if (owed) myAction = { type: "pay", round: owed.round, to: owed.recipient, dueAt: owed.dueAt };
    else if (current && current.recipient === me.username) myAction = { type: "receive", round: current.round, dueAt: current.dueAt };
    else myAction = { type: "none" };
  }

  return {
    id: c.id,
    ref: c.ref,
    name: c.name,
    currency: c.currency,
    contribution: amount,
    contributionAtomic: c.contribution_atomic,
    frequency: c.frequency,
    startAt: iso(c.start_at)!,
    status: c.status,
    organizer: organizer?.username ?? "?",
    isOrganizer: c.organizer_id === viewerId,
    myStatus: me?.status ?? "declined",
    members: ms.map((m) => ({ username: m.username ?? "?", position: m.position, status: m.status, isOrganizer: m.user_id === c.organizer_id, isMe: m.user_id === viewerId })),
    rounds,
    currentRound: current?.round ?? null,
    // While forming, the payout assumes everyone invited joins.
    pot: amount * Math.max(0, (c.status === "forming" ? ms.filter((m) => m.status !== "declined").length : active.length) - 1),
    myAction,
  };
}

async function maybeComplete(db: Db, c: CircleRow, dto: CircleDTO): Promise<CircleDTO> {
  if (c.status === "active" && dto.rounds.length && dto.rounds.every((r) => r.complete)) {
    await db.query("update savings_circles set status = 'completed', updated_at = now() where id = $1 and status = 'active'", [c.id]);
    log.info("circle.completed", { ref: c.ref });
    return { ...dto, status: "completed", myAction: { type: "none" } };
  }
  return dto;
}

async function loadForMember(db: Db, userId: string, id: string): Promise<CircleRow> {
  const c = (
    await db.query<CircleRow>(
      "select c.* from savings_circles c join circle_members m on m.circle_id = c.id where c.id = $1 and m.user_id = $2",
      [id, userId],
    )
  )[0];
  if (!c) throw new AppError("CIRCLE_NOT_FOUND", "Thrift not found.", 404);
  return c;
}

// ---------------------------------------------------------------------------

export async function createCircle(
  userId: string,
  input: { name: string; currency: "NIM" | "USDT"; amount: number; frequency: "weekly" | "monthly"; startAt: string; members: string[] },
): Promise<CircleDTO> {
  const db = await getDb();
  const me = (await db.query<{ username: string | null }>("select username from users where id = $1", [userId]))[0];
  if (!me?.username) throw new AppError("USERNAME_REQUIRED", "Choose your @username first.", 422);
  const name = input.name.trim().slice(0, 40);
  if (name.length < 2) throw new AppError("INVALID_NAME", "Give the thrift a name.", 422);
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() - 86_400_000) throw new AppError("INVALID_START", "Choose today or a future start date.", 422);
  const atomic = input.currency === "NIM" ? BigInt(Math.round(input.amount * 1e5)) : BigInt(Math.round(input.amount * 1e6));
  if (atomic < 1n) throw new AppError("INVALID_AMOUNT", "Enter a contribution amount.", 422);

  // Payout order = the order given; the organizer is first unless they placed themselves.
  const names = input.members.map(normaliseUsername).filter(Boolean);
  if (!names.includes(me.username)) names.unshift(me.username);
  if (new Set(names).size !== names.length) throw new AppError("DUPLICATE_MEMBER", "Each member can appear only once.", 422);
  if (names.length < 2) throw new AppError("TOO_FEW_MEMBERS", "Add at least one other member.", 422);
  if (names.length > MAX_MEMBERS) throw new AppError("TOO_MANY_MEMBERS", `A thrift can have up to ${MAX_MEMBERS} members.`, 422);
  const users = await db.query<{ id: string; username: string }>("select id, username from users where username = any($1::text[])", [names]);
  const missing = names.filter((n) => !users.some((u) => u.username === n));
  if (missing.length) throw new AppError("USER_NOT_FOUND", `No AuraPay user called ${missing.map((m) => `@${m}`).join(", ")}.`, 404);
  if (input.currency === "USDT" && !(await verifiedEvmAddresses(userId)).length) {
    throw new AppError("PAYER_NOT_VERIFIED", "Verify your USDT wallet before starting a USDT thrift.", 422);
  }

  const ref = newRef("SV");
  const circle = await db.transaction(async (tx) => {
    const rows = await tx.query<CircleRow>(
      `insert into savings_circles (ref, name, organizer_id, currency, contribution, contribution_atomic, frequency, start_at, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'forming') returning *`,
      [ref, name, userId, input.currency, Number(atomic) / (input.currency === "NIM" ? 1e5 : 1e6), atomic.toString(), input.frequency, start],
    );
    for (const [i, n] of names.entries()) {
      const u = users.find((x) => x.username === n)!;
      const isMe = u.id === userId;
      await tx.query("insert into circle_members (circle_id, user_id, position, status, joined_at) values ($1,$2,$3,$4,$5)", [rows[0].id, u.id, i + 1, isMe ? "joined" : "invited", isMe ? new Date() : null]);
    }
    return rows[0];
  });
  log.info("circle.created", { ref, members: names.length, currency: input.currency });
  return buildDTO(db, circle, userId);
}

export async function listCircles(userId: string): Promise<CircleDTO[]> {
  const db = await getDb();
  const rows = await db.query<CircleRow>(
    `select c.* from savings_circles c join circle_members m on m.circle_id = c.id
     where m.user_id = $1 and m.status <> 'declined' and c.status <> 'cancelled' order by c.created_at desc limit 50`,
    [userId],
  );
  const out: CircleDTO[] = [];
  for (const c of rows) out.push(await maybeComplete(db, c, await buildDTO(db, c, userId)));
  return out;
}

export async function getCircle(userId: string, id: string): Promise<CircleDTO> {
  const db = await getDb();
  const c = await loadForMember(db, userId, id);
  return maybeComplete(db, c, await buildDTO(db, c, userId));
}

export async function respondToInvite(userId: string, id: string, accept: boolean): Promise<CircleDTO> {
  const db = await getDb();
  const c = await loadForMember(db, userId, id);
  if (c.status !== "forming") throw new AppError("CIRCLE_STARTED", "This circle has already started.", 409);
  if (accept && c.currency === "USDT" && !(await verifiedEvmAddresses(userId)).length) {
    throw new AppError("PAYER_NOT_VERIFIED", "Verify your USDT wallet first: you'll pay and receive USDT in this thrift.", 422);
  }
  const rows = await db.query(
    "update circle_members set status = $3, joined_at = case when $3 = 'joined' then now() else null end where circle_id = $1 and user_id = $2 and status = 'invited' returning user_id",
    [id, userId, accept ? "joined" : "declined"],
  );
  if (!rows.length) throw new AppError("NOT_INVITED", "There's no pending invitation for you.", 409);
  return buildDTO(db, c, userId);
}

export async function startCircle(userId: string, id: string): Promise<CircleDTO> {
  const db = await getDb();
  const c = await loadForMember(db, userId, id);
  if (c.organizer_id !== userId) throw new AppError("NOT_ORGANIZER", "Only the organizer can start the thrift.", 403);
  if (c.status !== "forming") throw new AppError("CIRCLE_STARTED", "This circle has already started.", 409);
  const ms = await members(db, id);
  if (ms.some((m) => m.status === "invited")) throw new AppError("WAITING_FOR_MEMBERS", "Wait until everyone has accepted or declined.", 409);
  const joined = ms.filter((m) => m.status === "joined");
  if (joined.length < 2) throw new AppError("TOO_FEW_MEMBERS", "At least two members must join.", 409);
  const start = new Date(Math.max(new Date(c.start_at).getTime(), Date.now()));
  await db.transaction(async (tx) => {
    // Close gaps left by declined members so payout positions run 1..n.
    await tx.query("delete from circle_members where circle_id = $1 and status = 'declined'", [id]);
    for (const [i, m] of joined.entries()) await tx.query("update circle_members set position = $3 where circle_id = $1 and user_id = $2", [id, m.user_id, 1000 + i]);
    for (const [i, m] of joined.entries()) await tx.query("update circle_members set position = $3 where circle_id = $1 and user_id = $2", [id, m.user_id, i + 1]);
    await tx.query("update savings_circles set status = 'active', start_at = $2, updated_at = now() where id = $1", [id, start]);
  });
  log.info("circle.started", { ref: c.ref, members: joined.length });
  return getCircle(userId, id);
}

export async function cancelCircle(userId: string, id: string): Promise<CircleDTO> {
  const db = await getDb();
  const c = await loadForMember(db, userId, id);
  if (c.organizer_id !== userId) throw new AppError("NOT_ORGANIZER", "Only the organizer can cancel the thrift.", 403);
  if (c.status !== "forming") throw new AppError("CIRCLE_STARTED", "A thrift can only be cancelled before it starts.", 409);
  await db.query("update savings_circles set status = 'cancelled', updated_at = now() where id = $1", [id]);
  return buildDTO(db, { ...c, status: "cancelled" }, userId);
}

/**
 * Validates a contribution before its transfer intent is created: the payer is a member,
 * the recipient is that round's recipient, and the amount/currency match. Returns the tags.
 */
export async function checkContribution(
  db: Db,
  userId: string,
  input: { circleId: string; round: number; toUserId: string; currency: string; amountAtomic: bigint },
): Promise<void> {
  const c = await loadForMember(db, userId, input.circleId);
  if (c.status !== "active") throw new AppError("CIRCLE_NOT_ACTIVE", "This circle isn't active.", 409);
  const joined = (await members(db, c.id)).filter((m) => m.status === "joined");
  const recipient = joined[input.round - 1];
  if (!recipient) throw new AppError("INVALID_ROUND", "That round doesn't exist.", 422);
  if (recipient.user_id !== input.toUserId) throw new AppError("WRONG_RECIPIENT", `Round ${input.round} goes to @${recipient.username}.`, 422);
  if (recipient.user_id === userId) throw new AppError("SELF_TRANSFER", "You receive this round; you don't pay into it.", 422);
  if (!joined.some((m) => m.user_id === userId)) throw new AppError("NOT_MEMBER", "You're not a member of this thrift.", 403);
  if (input.currency !== c.currency || input.amountAtomic !== BigInt(c.contribution_atomic)) {
    throw new AppError("WRONG_AMOUNT", `The contribution is ${num(c.contribution)} ${c.currency}.`, 422);
  }
  const existing = await db.query(
    "select 1 from transfers where circle_id = $1 and circle_round = $2 and from_user_id = $3 and status in ('pending', 'confirmed')",
    [c.id, input.round, userId],
  );
  if (existing.length) throw new AppError("ALREADY_CONTRIBUTED", "You've already paid this round.", 409);
}
