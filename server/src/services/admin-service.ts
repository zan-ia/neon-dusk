import { eq, desc, and, sql, type SQLWrapper } from "drizzle-orm";
import type Redis from "ioredis";
import type {
  AdminEconomy,
  AdminPlayer,
  AdminPlayersResponse,
  AdminTransaction,
  AdminTransactionsResponse,
  AdminAuditEntry,
  AdminAuditResponse,
} from "@neon-dusk/shared";
import { db } from "../db";
import {
  characters,
  characterWallets,
  crews,
  crewMembers,
  gameEvents,
  transactionLog,
  gameParams,
  auditLog,
} from "../db/schema";
import { AppError } from "../middleware/error-handler";

// Neon Dusk — Admin service (ND-052)
// ============================================================================
// Read-only and write operations for the admin panel. All write operations
// log to the audit_log table. Economy queries aggregate across wallets,
// transaction_log, and game_events.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape SQL LIKE wildcards so user search input cannot match all records. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Derive a PlayerStatus from ban flag + batched circuit-break state. */
function resolveStatus(
  isBanned: boolean,
  cbResult: string | null,
): AdminPlayer["status"] {
  if (isBanned) return "banned";
  if (cbResult !== null) return "circuit_broken";
  return "active";
}

/** Derive a character level from their street cred (every 10 SC = 1 level, min 1). */
function levelFromSC(sc: number): number {
  return Math.max(1, Math.floor(sc / 10) + 1);
}

/**
 * Get paginated player list with search, sort, and derived fields.
 * Joins characters → wallets → crews → game_events for a comprehensive view.
 */
export async function getPlayers(
  redis: Redis,
  opts: {
    page?: number;
    pageSize?: number;
    search?: string;
    sort?: "sc" | "name" | "level" | "last_activity";
  } = {},
): Promise<AdminPlayersResponse> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  // Base query: characters joined with wallets and crew name.
  const walletJoin = db
    .select({
      characterId: characterWallets.characterId,
      balance: characterWallets.balance,
    })
    .from(characterWallets)
    .as("w");

  const crewJoin = db
    .select({
      characterId: crewMembers.characterId,
      crewName: crews.name,
    })
    .from(crewMembers)
    .innerJoin(crews, eq(crewMembers.crewId, crews.id))
    .as("c");

  // Last login: latest game_event per character.
  const lastEventJoin = db
    .select({
      characterId: gameEvents.actorId,
      lastEvent: sql<string>`max(${gameEvents.createdAt})`.as("last_event"),
    })
    .from(gameEvents)
    .where(sql`${gameEvents.actorId} IS NOT NULL`)
    .groupBy(gameEvents.actorId)
    .as("le");

  const conditions: SQLWrapper[] = [];

  if (opts.search) {
    const safe = escapeLike(opts.search.toLowerCase());
    conditions.push(sql`lower(${characters.name}) LIKE ${`%${safe}%`}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Count total (without joins for performance).
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(characters)
    .where(where);
  const total = countRows[0]?.count ?? 0;

  // Build sort order.
  let orderBy: ReturnType<typeof desc>;
  switch (opts.sort) {
    case "name":
      orderBy = desc(characters.name);
      break;
    case "level":
      orderBy = desc(characters.streetCred);
      break;
    case "last_activity":
      // Sorted in-memory after fetch.
      orderBy = desc(characters.createdAt);
      break;
    default:
      orderBy = desc(characters.streetCred);
  }

  const rows = await db
    .select({
      id: characters.id,
      userId: characters.userId,
      name: characters.name,
      streetCred: characters.streetCred,
      isBanned: characters.isBanned,
      balance: walletJoin.balance,
      crewName: crewJoin.crewName,
      lastEvent: lastEventJoin.lastEvent,
    })
    .from(characters)
    .leftJoin(walletJoin, eq(characters.id, walletJoin.characterId))
    .leftJoin(crewJoin, eq(characters.id, crewJoin.characterId))
    .leftJoin(lastEventJoin, eq(characters.id, lastEventJoin.characterId))
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  // Batch circuit-break checks: one mget instead of N sequential gets.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const cbKeys = userIds.map((uid) => `circuit_break:${uid}`);
  const cbResults = userIds.length > 0 ? await redis.mget(...cbKeys) : [];
  const cbMap = new Map(userIds.map((uid, i) => [uid, cbResults[i] ?? null]));

  const players: AdminPlayer[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      level: levelFromSC(row.streetCred),
      sc: row.streetCred,
      eddies: row.balance ?? 0,
      crew: row.crewName ?? null,
      lastLogin: row.lastEvent ?? null,
      status: resolveStatus(row.isBanned, cbMap.get(row.userId) ?? null),
    }));

  // Re-sort by last_activity if requested (lastEvent is string, sort by that).
  if (opts.sort === "last_activity") {
    players.sort((a, b) => {
      if (!a.lastLogin) return 1;
      if (!b.lastLogin) return -1;
      return b.lastLogin.localeCompare(a.lastLogin);
    });
  }

  return { players, total, page, pageSize };
}

/**
 * Ban a character by ID. Sets is_banned = true, logs to audit.
 */
export async function banPlayer(
  characterId: string,
  adminUserId: string,
  reason: string,
): Promise<void> {
  const [updated] = await db
    .update(characters)
    .set({ isBanned: true })
    .where(eq(characters.id, characterId))
    .returning({ id: characters.id });

  if (!updated) {
    throw new AppError(404, "NOT_FOUND", "Personagem não encontrado");
  }

  // Fire-and-forget audit log.
  void db
    .insert(auditLog)
    .values({
      characterId,
      action: "admin.ban",
      ip: "admin",
      userAgent: "admin-panel",
      payload: { reason, adminUserId },
      result: "allowed",
    })
    .execute()
    .catch((err) => console.error("[admin] audit-log write failed:", err));
}

/**
 * Unban a character by ID. Sets is_banned = false, logs to audit.
 */
export async function unbanPlayer(
  characterId: string,
  adminUserId: string,
): Promise<void> {
  const [updated] = await db
    .update(characters)
    .set({ isBanned: false })
    .where(eq(characters.id, characterId))
    .returning({ id: characters.id });

  if (!updated) {
    throw new AppError(404, "NOT_FOUND", "Personagem não encontrado");
  }

  void db
    .insert(auditLog)
    .values({
      characterId,
      action: "admin.unban",
      ip: "admin",
      userAgent: "admin-panel",
      payload: { adminUserId },
      result: "allowed",
    })
    .execute()
    .catch((err) => console.error("[admin] audit-log write failed:", err));
}

// ---------------------------------------------------------------------------
// Economy dashboard
// ---------------------------------------------------------------------------

/**
 * Economy overview: aggregate balances, top faucets/sinks, DAU, hourly activity.
 */
export async function getEconomy(): Promise<AdminEconomy> {
  // Eddies in circulation: SUM of all wallet balances.
  const [balanceRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${characterWallets.balance}), 0)::int`,
    })
    .from(characterWallets);
  const eddiesInCirculation = balanceRow?.total ?? 0;

  // Top faucets 24h (positive transactions, grouped by source).
  const faucets = await db
    .select({
      source: transactionLog.source,
      amount: sql<number>`sum(${transactionLog.amount})::int`,
    })
    .from(transactionLog)
    .where(
      sql`${transactionLog.createdAt} > now() - interval '24 hours'
          AND ${transactionLog.amount} > 0`,
    )
    .groupBy(transactionLog.source)
    .orderBy(sql`sum(${transactionLog.amount}) DESC`)
    .limit(5);

  // Top sinks 24h (negative transactions, grouped by source).
  const sinks = await db
    .select({
      source: transactionLog.source,
      amount: sql<number>`abs(sum(${transactionLog.amount}))::int`,
    })
    .from(transactionLog)
    .where(
      sql`${transactionLog.createdAt} > now() - interval '24 hours'
          AND ${transactionLog.amount} < 0`,
    )
    .groupBy(transactionLog.source)
    .orderBy(sql`abs(sum(${transactionLog.amount})) DESC`)
    .limit(5);

  // Daily Active Characters: distinct actors with game events in last 24h.
  const [dauRow] = await db
    .select({
      count: sql<number>`count(distinct ${gameEvents.actorId})::int`,
    })
    .from(gameEvents)
    .where(
      sql`${gameEvents.createdAt} > now() - interval '24 hours'
          AND ${gameEvents.actorId} IS NOT NULL`,
    );

  // Transactions in last 24h.
  const [txRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionLog)
    .where(sql`${transactionLog.createdAt} > now() - interval '24 hours'`);

  // Hourly breakdown: game events per hour for the last 24h.
  const hourly = await db
    .select({
      hour: sql<string>`date_trunc('hour', ${gameEvents.createdAt})::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(gameEvents)
    .where(sql`${gameEvents.createdAt} > now() - interval '24 hours'`)
    .groupBy(sql`date_trunc('hour', ${gameEvents.createdAt})`)
    .orderBy(sql`date_trunc('hour', ${gameEvents.createdAt})`);

  return {
    eddiesInCirculation,
    topFaucets24h: faucets.map((f) => ({ source: f.source, amount: f.amount })),
    topSinks24h: sinks.map((s) => ({ source: s.source, amount: s.amount })),
    dailyActiveCharacters: dauRow?.count ?? 0,
    transactions24h: txRow?.count ?? 0,
    hourlyBreakdown24h: hourly.map((h) => ({ hour: h.hour, count: h.count })),
  };
}

// ---------------------------------------------------------------------------
// Transaction viewer
// ---------------------------------------------------------------------------

/**
 * Get paginated transaction log with character name join.
 */
export async function getTransactions(
  opts: {
    type?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AdminTransactionsResponse> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions: SQLWrapper[] = [];
  if (opts.type) {
    conditions.push(eq(transactionLog.type, opts.type as never));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionLog)
    .where(where);
  const total = countRow?.count ?? 0;

  const rows = await db
    .select({
      id: transactionLog.id,
      characterName: characters.name,
      type: transactionLog.type,
      amount: transactionLog.amount,
      balanceBefore: transactionLog.balanceBefore,
      balanceAfter: transactionLog.balanceAfter,
      source: transactionLog.source,
      createdAt: transactionLog.createdAt,
    })
    .from(transactionLog)
    .leftJoin(characters, eq(transactionLog.characterId, characters.id))
    .where(where)
    .orderBy(desc(transactionLog.createdAt))
    .limit(limit)
    .offset(offset);

  const transactions: AdminTransaction[] = rows.map((r) => ({
    id: r.id,
    characterName: r.characterName ?? "unknown",
    type: r.type,
    amount: r.amount,
    balanceBefore: r.balanceBefore,
    balanceAfter: r.balanceAfter,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));

  return { transactions, total };
}

// ---------------------------------------------------------------------------
// Game params
// ---------------------------------------------------------------------------

/** Get all game params as a flat record. */
export async function getParams(): Promise<Record<string, string>> {
  const rows = await db.select().from(gameParams);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Update game params. Only existing keys can be updated. Logs old→new diffs. */
export async function updateParams(
  params: Record<string, string>,
  adminUserId: string,
): Promise<Record<string, string>> {
  const existingKeys = new Set(
    (await db.select({ key: gameParams.key }).from(gameParams)).map((r) => r.key),
  );

  const unknownKeys = Object.keys(params).filter((k) => !existingKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new AppError(
      400,
      "UNKNOWN_PARAMS",
      `Unknown game param keys: ${unknownKeys.join(", ")}`,
    );
  }

  // Read current values for diffing.
  const current = await getParams();
  const diffs: Record<string, { old: string; new: string }> = {};

  for (const [key, value] of Object.entries(params)) {
    if (current[key] !== value) {
      diffs[key] = { old: current[key], new: value };
    }
  }

  if (Object.keys(diffs).length === 0) {
    return current;
  }

  // Update each param.
  for (const [key, value] of Object.entries(params)) {
    await db
      .update(gameParams)
      .set({ value, updatedBy: adminUserId, updatedAt: new Date() })
      .where(eq(gameParams.key, key));
  }

  // Audit log the change (no characterId — system action).
  void db
    .insert(auditLog)
    .values({
      characterId: null,
      action: "admin.update_params",
      ip: "admin",
      userAgent: "admin-panel",
      payload: { diffs, adminUserId },
      result: "allowed",
    })
    .execute()
    .catch((err) => console.error("[admin] audit-log write failed:", err));

  return getParams();
}

// ---------------------------------------------------------------------------
// Audit log viewer
// ---------------------------------------------------------------------------

/** Mask the last two octets of an IP address for privacy. Non-IP strings are fully masked. */
function maskIP(ip: string): string {
  if (!ip.includes(".")) return "***.***.***";
  return ip.replace(/\.\d{1,3}\.\d{1,3}$/, ".***");
}

/**
 * Get cursor-paginated audit log entries with character name.
 */
export async function getAuditLog(
  opts: {
    action?: string;
    result?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<AdminAuditResponse> {
  const limit = opts.limit ?? 50;

  const conditions: SQLWrapper[] = [];
  if (opts.action) {
    conditions.push(eq(auditLog.action, opts.action));
  }
  if (opts.result) {
    conditions.push(eq(auditLog.result, opts.result as never));
  }
  if (opts.cursor) {
    conditions.push(sql`${auditLog.id} < ${opts.cursor}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: auditLog.id,
      timestamp: auditLog.createdAt,
      characterName: characters.name,
      action: auditLog.action,
      result: auditLog.result,
      payload: auditLog.payload,
      ip: auditLog.ip,
    })
    .from(auditLog)
    .leftJoin(characters, eq(auditLog.characterId, characters.id))
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1); // fetch one extra to determine hasMore

  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit);

  return {
    entries: entries.map((r) => ({
      id: r.id,
      timestamp: r.timestamp.toISOString(),
      characterName: r.characterName ?? null,
      action: r.action,
      result: r.result,
      payload: (r.payload as Record<string, unknown>) ?? {},
      ip: maskIP(r.ip),
    })),
    nextCursor: hasMore ? entries[entries.length - 1].id : null,
  };
}
