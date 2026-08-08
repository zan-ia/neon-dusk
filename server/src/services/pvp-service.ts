import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  PvpAttackableResponse,
  PvpCombatResult,
  PvpHistoryResponse,
  PvpTarget,
} from "@neon-dusk/shared";
import { db, type Tx } from "../db";
import {
  characterWallets,
  characters,
  chromeDefinitions,
  installedChrome,
  pvpCombats,
  transactionLog,
} from "../db/schema";
import { AppError } from "../middleware/error-handler";
import {
  calculateChromePower,
  calculateLoot,
  calculateLoserSC,
  calculateWinnerSC,
  hasNoobShield,
  isGriefLimited,
  isImmune,
  resolveCombat,
} from "../game/pvp";
import { transferEddies, type WalletState } from "../game/economy";
import { ensureWallet } from "./economy-service";
import { instrument } from "../telemetry/instrument";
import { invalidateLeaderboardCache } from "../lib/leaderboard-cache";

// Neon Dusk — PvP service (ND-014)
// ============================================================================
// Orchestrates the attack flow over the pure game logic in game/pvp.ts. The
// whole fight (validation, SC/NIL changes, loot transfer, combat record) runs
// in ONE atomic transaction; the attacker and defender character rows are
// locked FOR UPDATE so concurrent attacks on the same characters serialize.
// The Redis cooldown is only set AFTER the transaction commits — a rollback
// must never burn the attacker's cooldown.

/** NIL cost per attack. */
const PVP_NIL_COST = 20;
/** Max allowed |attacker power − defender power| (matching game/pvp ±10). */
const POWER_RANGE = 10;
/** Redis cooldown key prefix (per attacking character). */
const PVP_COOLDOWN_KEY = "pvp:cooldown:";
/** Attack cooldown, in seconds. */
const PVP_COOLDOWN_S = 3600;
/** Account immunity window (must match game/pvp IMMUNITY_DAYS). */
const IMMUNITY_MS = 7 * 24 * 60 * 60 * 1000;

/** Queryable client union — helpers run against `db` or a transaction client. */
type Queryable = Tx | typeof db;

/** Monday 00:00 UTC of the current week — start of the grief window. */
function startOfWeekUTC(now: Date = new Date()): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

/** 00:00 UTC of the current day — start of the defeat-cap window. */
function startOfDayUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Sum of the character's installed-chrome combat bonuses (body + reflexes). */
async function loadChromePower(q: Queryable, characterId: string): Promise<number> {
  const rows = await q
    .select({ bonuses: chromeDefinitions.bonuses })
    .from(installedChrome)
    .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
    .where(eq(installedChrome.characterId, characterId));
  return calculateChromePower(rows);
}

/** Number of times `attackerId` hit `defenderId` since the start of the week. */
async function countWeeklyAttacks(q: Queryable, attackerId: string, defenderId: string): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(pvpCombats)
    .where(
      and(
        eq(pvpCombats.attackerId, attackerId),
        eq(pvpCombats.defenderId, defenderId),
        gte(pvpCombats.createdAt, startOfWeekUTC()),
      ),
    );
  return row?.n ?? 0;
}

/**
 * GET /api/pvp/attackable — candidates within ±10 effective power of the
 * caller, newest accounts excluded (7-day immunity). Rough base-power filter
 * in SQL, chrome-aware filter in JS. Returns an empty list while the caller
 * is on cooldown so the client can show "no targets" instead of an error.
 */
export async function getAttackableTargets(
  redis: Redis,
  userId: string,
  limit: number,
  cursor?: string,
): Promise<PvpAttackableResponse> {
  // `cursor` is reserved for future pagination — the response type has no
  // cursor field, so the list is always a single page.
  void cursor;

  const [attacker] = await db.select().from(characters).where(eq(characters.userId, userId)).limit(1);
  if (!attacker) throw new AppError(404, "NO_CHARACTER", "Crie um personagem primeiro");

  if (await redis.get(`${PVP_COOLDOWN_KEY}${attacker.id}`)) {
    return { targets: [] };
  }

  const attackerChrome = await loadChromePower(db, attacker.id);
  const minPower = attacker.body + attacker.reflexes + attackerChrome - POWER_RANGE;
  const maxPower = attacker.body + attacker.reflexes + attackerChrome + POWER_RANGE;
  const immunityCutoff = new Date(Date.now() - IMMUNITY_MS);

  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      streetCred: characters.streetCred,
      body: characters.body,
      reflexes: characters.reflexes,
    })
    .from(characters)
    .where(
      and(
        ne(characters.id, attacker.id),
        lt(characters.createdAt, immunityCutoff),
        sql`(${characters.body} + ${characters.reflexes}) between ${minPower} and ${maxPower}`,
      ),
    )
    .orderBy(desc(characters.streetCred))
    .limit(limit);

  // Re-filter with chrome power (the SQL filter is base-power only) and
  // annotate each candidate with the attacker's weekly hit count on them.
  const targets: PvpTarget[] = [];
  for (const row of rows) {
    const chromePower = await loadChromePower(db, row.id);
    const power = row.body + row.reflexes + chromePower;
    if (power < minPower || power > maxPower) continue;

    targets.push({
      characterId: row.id,
      name: row.name,
      streetCred: row.streetCred,
      power,
      noobShield: hasNoobShield(row.streetCred),
      weeklyAttacksReceived: await countWeeklyAttacks(db, attacker.id, row.id),
    });
  }

  return { targets };
}

/**
 * POST /api/pvp/attack — run one combat. The attacker and defender character
 * rows are locked FOR UPDATE for the whole fight, so concurrent attacks on
 * the same characters serialize instead of double-spending NIL or loot. All
 * validations run inside the transaction; nothing persists if any fails.
 */
export async function executeAttack(
  redis: Redis,
  userId: string,
  targetId: string,
): Promise<PvpCombatResult> {
  // Cheap, non-transactional guards first — fail fast before locking rows.
  const [attackerRow] = await db.select().from(characters).where(eq(characters.userId, userId)).limit(1);
  if (!attackerRow) throw new AppError(404, "NO_CHARACTER", "Crie um personagem primeiro");
  const attackerId = attackerRow.id;

  if (targetId === attackerId) {
    throw new AppError(400, "CANNOT_ATTACK_SELF", "Você não pode atacar a si mesmo");
  }

  if (await redis.get(`${PVP_COOLDOWN_KEY}${attackerId}`)) {
    throw new AppError(429, "PVP_COOLDOWN", "Você ainda está em cooldown de ataque");
  }

  const result = await db.transaction(async (tx) => {
    const [attacker] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, attackerId))
      .for("update")
      .limit(1);
    if (!attacker) throw new AppError(404, "NO_CHARACTER", "Crie um personagem primeiro");

    const [defender] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, targetId))
      .for("update")
      .limit(1);
    if (!defender) throw new AppError(404, "TARGET_NOT_FOUND", "Personagem alvo não encontrado");

    if (isImmune(defender.createdAt)) {
      throw new AppError(400, "TARGET_IMMUNE", "Este jogador está imune a ataques");
    }

    if (attacker.nil < PVP_NIL_COST) {
      throw new AppError(400, "INSUFFICIENT_NIL", `Precisa de ${PVP_NIL_COST} NIL para atacar`);
    }

    // Power bracket: effective (non-random) power must be within ±10.
    const attackerChrome = await loadChromePower(tx, attackerId);
    const defenderChrome = await loadChromePower(tx, targetId);
    const attackerBase = attacker.body + attacker.reflexes + attackerChrome;
    const defenderBase = defender.body + defender.reflexes + defenderChrome;
    if (Math.abs(attackerBase - defenderBase) > POWER_RANGE) {
      throw new AppError(400, "POWER_RANGE_EXCEEDED", "Diferença de poder muito grande para atacar");
    }

    // Anti-grief limits (design: weekly attacks on the target).
    const weeklyAttacks = await countWeeklyAttacks(tx, attackerId, targetId);
    const grieferPenalty = isGriefLimited(weeklyAttacks);

    // Resolve the fight (game logic incl. solo role multiplier + crit).
    const { winner, attackerPower, defenderPower } = resolveCombat({
      attacker: { body: attacker.body, reflexes: attacker.reflexes, chromePower: attackerChrome, role: attacker.role },
      defender: { body: defender.body, reflexes: defender.reflexes, chromePower: defenderChrome, role: defender.role },
    });
    const attackerWon = winner === "attacker";
    const winnerId = attackerWon ? attackerId : targetId;
    const loserId = attackerWon ? targetId : attackerId;

    // Street cred deltas. The defeat cap (≥3 losses today) protects the
    // actual loser — regardless of whether they were attacker or defender.
    const [loserDefeats] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pvpCombats)
      .where(
        and(
          or(
            eq(pvpCombats.attackerId, loserId),
            eq(pvpCombats.defenderId, loserId),
          ),
          ne(pvpCombats.winnerId, loserId),
          gte(pvpCombats.createdAt, startOfDayUTC()),
        ),
      );
    const loserDefeatsToday = loserDefeats?.n ?? 0;
    const winnerSC = calculateWinnerSC(attackerWon ? attacker.streetCred : defender.streetCred);
    const loserSC = calculateLoserSC(
      attackerWon ? defender.streetCred : attacker.streetCred,
      loserDefeatsToday,
    );

    // Lock both wallets; loot is 10% of the loser's spendable balance (escrow
    // excluded — a fully escrowed wallet can't pay out). No wallet → no loot.
    const [loserWalletRow] = await tx
      .select()
      .from(characterWallets)
      .where(eq(characterWallets.characterId, loserId))
      .for("update")
      .limit(1);
    const [winnerWalletRow] = await tx
      .select()
      .from(characterWallets)
      .where(eq(characterWallets.characterId, winnerId))
      .for("update")
      .limit(1);

    const lootAmount = loserWalletRow
      ? calculateLoot(Math.max(0, loserWalletRow.balance - loserWalletRow.escrow), grieferPenalty)
      : 0;

    // ── Persist the fight (single atomic unit) ──
    const combatId = randomUUID();

    // Attacker always pays the NIL cost.
    await tx
      .update(characters)
      .set({ nil: attacker.nil - PVP_NIL_COST, updatedAt: new Date() })
      .where(eq(characters.id, attackerId));

    // Winner: +SC (capped at 100, lifetime max tracked). No-op when already capped.
    if (winnerSC.change > 0) {
      await tx
        .update(characters)
        .set({
          streetCred: winnerSC.newSC,
          maxStreetCredAchieved: sql`GREATEST(max_street_cred_achieved, ${winnerSC.newSC})`,
          updatedAt: new Date(),
        })
        .where(eq(characters.id, winnerId));
    }

    // Loser: −SC unless the defeat cap protects them (change is 0 then).
    if (loserSC.change !== 0) {
      await tx
        .update(characters)
        .set({ streetCred: loserSC.newSC, updatedAt: new Date() })
        .where(eq(characters.id, loserId));
    }

    // Loot: debit loser, credit winner — both with version CAS, audited.
    let newBalance = 0;
    if (lootAmount > 0) {
      const loserWallet: WalletState = {
        balance: loserWalletRow!.balance,
        escrow: loserWalletRow!.escrow,
        lifetimeEarned: loserWalletRow!.lifetimeEarned,
        lifetimeSpent: loserWalletRow!.lifetimeSpent,
        version: loserWalletRow!.version,
      };
      const debit = transferEddies(loserWallet, -lootAmount, {
        type: "PVP_LOSS",
        source: "Loot stolen in PvP",
        referenceType: "pvp",
        referenceId: combatId,
      });
      const [updatedLoser] = await tx
        .update(characterWallets)
        .set({
          balance: debit.wallet.balance,
          escrow: debit.wallet.escrow,
          lifetimeSpent: debit.wallet.lifetimeSpent,
          version: loserWallet.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(characterWallets.id, loserWalletRow!.id), eq(characterWallets.version, loserWallet.version)))
        .returning();
      if (!updatedLoser) {
        throw new AppError(409, "CONCURRENCY_CONFLICT", "Carteira alterada concorrentemente. Tente novamente.");
      }
      await tx.insert(transactionLog).values({
        characterId: loserId,
        type: "PVP_LOSS",
        amount: -lootAmount,
        balanceBefore: debit.transaction.balanceBefore,
        balanceAfter: debit.transaction.balanceAfter,
        source: debit.transaction.source,
        referenceType: "pvp",
        referenceId: combatId,
      });

      // Credit the winner; a first-ever win without a wallet seeds it (the
      // standard ensureWallet faucet) so the reward is never lost.
      const winnerWallet: WalletState = winnerWalletRow
        ? {
            balance: winnerWalletRow.balance,
            escrow: winnerWalletRow.escrow,
            lifetimeEarned: winnerWalletRow.lifetimeEarned,
            lifetimeSpent: winnerWalletRow.lifetimeSpent,
            version: winnerWalletRow.version,
          }
        : await ensureWallet(winnerId, tx);
      const credit = transferEddies(winnerWallet, lootAmount, {
        type: "PVP_REWARD",
        source: "Loot won in PvP",
        referenceType: "pvp",
        referenceId: combatId,
      });
      const [updatedWinner] = await tx
        .update(characterWallets)
        .set({
          balance: credit.wallet.balance,
          lifetimeEarned: credit.wallet.lifetimeEarned,
          version: winnerWallet.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(characterWallets.characterId, winnerId), eq(characterWallets.version, winnerWallet.version)))
        .returning();
      if (!updatedWinner) {
        throw new AppError(409, "CONCURRENCY_CONFLICT", "Carteira alterada concorrentemente. Tente novamente.");
      }
      await tx.insert(transactionLog).values({
        characterId: winnerId,
        type: "PVP_REWARD",
        amount: lootAmount,
        balanceBefore: credit.transaction.balanceBefore,
        balanceAfter: credit.transaction.balanceAfter,
        source: credit.transaction.source,
        referenceType: "pvp",
        referenceId: combatId,
      });

      newBalance = attackerWon ? updatedWinner.balance : updatedLoser.balance;
    } else {
      // No loot — report the attacker's current balance (0 with no wallet).
      const [attackerWallet] = await tx
        .select({ balance: characterWallets.balance })
        .from(characterWallets)
        .where(eq(characterWallets.characterId, attackerId))
        .limit(1);
      newBalance = attackerWallet?.balance ?? 0;
    }

    // Append-only combat record (id doubles as the loot audit reference).
    const [combat] = await tx
      .insert(pvpCombats)
      .values({
        id: combatId,
        attackerId,
        defenderId: targetId,
        attackerPower,
        defenderPower,
        winnerId,
        lootAmount,
        grieferPenalty,
      })
      .returning();

    return {
      combatId: combat.id,
      won: attackerWon,
      attackerPower,
      defenderPower,
      lootAmount,
      streetCredChange: attackerWon ? winnerSC.change : loserSC.change,
      newStreetCred: attackerWon ? winnerSC.newSC : loserSC.newSC,
      newBalance,
    };
  });

  // Post-commit side effects: cooldown + telemetry + leaderboard invalidation.
  // Never set the cooldown when the transaction rolled back — the attacker
  // must be able to retry. Leaderboard cache is dropped unconditionally
  // because any fight can move SC for both winner and loser (#74).
  await redis.set(`${PVP_COOLDOWN_KEY}${attackerId}`, "1", "EX", PVP_COOLDOWN_S);
  await invalidateLeaderboardCache(redis);
  instrument({
    eventType: "PVP_ATTACK",
    actorId: attackerId,
    payload: { targetId, won: result.won, lootAmount: result.lootAmount },
  });

  return result;
}

/**
 * GET /api/pvp/history — the character's recent fights (as attacker or
 * defender), newest first, cursor-paginated by `createdAt` (ISO 8601).
 * One extra row is read to detect the next page.
 */
export async function getCombatHistory(
  userId: string,
  limit: number = 20,
  cursor?: string,
): Promise<PvpHistoryResponse> {
  const [character] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.userId, userId))
    .limit(1);
  if (!character) throw new AppError(404, "NO_CHARACTER", "Crie um personagem primeiro");

  const attackerChar = alias(characters, "attacker");
  const defenderChar = alias(characters, "defender");

  const conditions: SQL[] = [
    or(eq(pvpCombats.attackerId, character.id), eq(pvpCombats.defenderId, character.id))!,
  ];
  if (cursor) conditions.push(lt(pvpCombats.createdAt, new Date(cursor)));

  const rows = await db
    .select({
      id: pvpCombats.id,
      attackerName: attackerChar.name,
      defenderName: defenderChar.name,
      attackerPower: pvpCombats.attackerPower,
      defenderPower: pvpCombats.defenderPower,
      winnerId: pvpCombats.winnerId,
      lootAmount: pvpCombats.lootAmount,
      grieferPenalty: pvpCombats.grieferPenalty,
      createdAt: pvpCombats.createdAt,
    })
    .from(pvpCombats)
    .innerJoin(attackerChar, eq(pvpCombats.attackerId, attackerChar.id))
    .innerJoin(defenderChar, eq(pvpCombats.defenderId, defenderChar.id))
    .where(and(...conditions))
    .orderBy(desc(pvpCombats.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    combats: page.map((row) => ({
      id: row.id,
      attackerName: row.attackerName,
      defenderName: row.defenderName,
      attackerPower: row.attackerPower,
      defenderPower: row.defenderPower,
      winnerId: row.winnerId,
      won: row.winnerId === character.id,
      lootAmount: row.lootAmount,
      grieferPenalty: row.grieferPenalty,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  };
}
