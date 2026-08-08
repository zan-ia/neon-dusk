import type Redis from "ioredis";
import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import type { NilConsumeResponse, NilStatus, NilStimResponse } from "@neon-dusk/shared";
import {
  NIL_REGEN_INTERVAL_MS,
  NIL_REGEN_RATE,
  NIL_SYN_CAFE_AMOUNT,
  NIL_SYN_CAFE_COOLDOWN_S,
} from "@neon-dusk/shared";
import { db } from "../db";
import { characters } from "../db/schema";
import { AppError } from "../middleware/error-handler";

// Neon Dusk — NIL (energy) service
// ============================================================================
// Lazy-write design: GET reads apply regen in memory only; only consume and
// syn-café persist (updating `nil` + `nil_updated_at` together). Rate is
// +1 NIL per 5 minutes, capped at `max_nil` (03-mecanicas-core.md §1).

export interface RegenResult {
  newNil: number;
  /** Seconds until the next regen tick (0 when capped at max). */
  nextTickSeconds: number;
}

/** Apply passive regen to a stored NIL snapshot. Pure; never writes. */
export function calculateRegen(currentNil: number, maxNil: number, lastUpdated: Date): RegenResult {
  // Clamp negative elapsed (clock skew) to zero; a snapshot can't regen backwards.
  const elapsed = Math.max(0, Date.now() - lastUpdated.getTime());
  const ticks = Math.floor(elapsed / NIL_REGEN_INTERVAL_MS);
  const newNil = Math.min(maxNil, currentNil + ticks * NIL_REGEN_RATE);

  if (newNil >= maxNil) {
    return { newNil, nextTickSeconds: 0 };
  }
  const intoNext = elapsed % NIL_REGEN_INTERVAL_MS;
  const nextTickSeconds = Math.max(1, Math.ceil((NIL_REGEN_INTERVAL_MS - intoNext) / 1000));
  return { newNil, nextTickSeconds };
}

/** Map a character row to a live NIL readout, applying passive regen lazily. */
export function toNilStatus(row: typeof characters.$inferSelect): NilStatus {
  const { newNil, nextTickSeconds } = calculateRegen(row.nil, row.maxNil, row.nilUpdatedAt);
  return {
    current: newNil,
    max: row.maxNil,
    nextTickSeconds,
    regenerating: newNil < row.maxNil,
    updatedAt: row.nilUpdatedAt.toISOString(),
  };
}

/** Load the caller's character row, 404 when none exists. */
async function findCharacter(userId: string): Promise<typeof characters.$inferSelect> {
  const [row] = await db.select().from(characters).where(eq(characters.userId, userId)).limit(1);
  if (!row) {
    throw new AppError(404, "CHARACTER_NOT_FOUND", "Nenhum personagem encontrado para esta conta");
  }
  return row;
}

/**
 * Live NIL readout for the user's character. Applies regen in memory only —
 * this endpoint never writes to the database.
 */
export async function getNilStatus(userId: string): Promise<NilStatus> {
  const row = await findCharacter(userId);
  return toNilStatus(row);
}

/** POST /api/characters/me/nil/consume — request validation. */
export const consumeNilSchema = z.object({
  amount: z
    .number()
    .int("Amount must be an integer")
    .positive("Amount must be positive")
    .max(100, "Amount too large"),
});

/** Deduct NIL (e.g. a gig) from the user's character and persist the new snapshot. */
export async function consumeNil(userId: string, amount: number): Promise<NilConsumeResponse> {
  const row = await findCharacter(userId);
  const { newNil: current } = calculateRegen(row.nil, row.maxNil, row.nilUpdatedAt);

  if (amount > current) {
    throw new AppError(400, "INSUFFICIENT_NIL", `NIL insuficiente (tem ${current}, precisa de ${amount})`);
  }

  // Atomic spend: persist regen AND deduct in one UPDATE. `regened` is
  // re-evaluated inside the row lock against the live row, so a concurrent
  // consume that passed the fail-fast check still loses the WHERE race and
  // gets INSUFFICIENT_NIL (double-spend guard).
  const elapsed = Math.max(0, Date.now() - row.nilUpdatedAt.getTime());
  const regenOffset = Math.floor(elapsed / NIL_REGEN_INTERVAL_MS) * NIL_REGEN_RATE;
  const regened = sql`LEAST(${characters.maxNil}, ${characters.nil} + ${regenOffset})`;

  // Optimistic lock: capture the stored value this read saw. If a concurrent
  // transaction commits a lower `nil` before our UPDATE lands, the guard
  // `gte(characters.nil, rawNil)` fails, the UPDATE returns no rows, and we
  // throw INSUFFICIENT_NIL instead of double-spending.
  const rawNil = row.nil;

  const [updated] = await db
    .update(characters)
    .set({
      nil: sql`${regened} - ${amount}`,
      nilUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(characters.userId, userId),
        gte(characters.nil, rawNil), // optimistic lock: fail if another tx modified nil
        sql`${regened} >= ${amount}`, // belt-and-suspenders
      ),
    )
    .returning();

  if (!updated) {
    throw new AppError(400, "INSUFFICIENT_NIL", "NIL insuficiente");
  }

  return { consumed: amount, remaining: updated.nil, status: toNilStatus(updated) };
}

/**
 * Syn-café: instantly restores +20 NIL (capped at max), gated by a 1h Redis
 * cooldown key per character. Returns the amount actually restored.
 */
export async function useStim(redis: Redis, userId: string): Promise<NilStimResponse> {
  const row = await findCharacter(userId);
  const { newNil: current } = calculateRegen(row.nil, row.maxNil, row.nilUpdatedAt);

  // Atomic cooldown gate — SET NX succeeds only when the key is absent, so two
  // concurrent stims can't both pass the guard (the loser gets COOLDOWN).
  const key = `nil:stim:${row.id}`;
  const acquired = await redis.set(key, "1", "EX", NIL_SYN_CAFE_COOLDOWN_S, "NX");
  if (acquired !== "OK") {
    const ttl = await redis.ttl(key);
    throw new AppError(400, "NIL_STIM_COOLDOWN", "Syn-café ainda está em cooldown", {
      retryAfterSeconds: ttl > 0 ? ttl : NIL_SYN_CAFE_COOLDOWN_S,
    });
  }

  if (current >= row.maxNil) {
    // Don't burn the cooldown for a zero-gain stim.
    await redis.del(key);
    throw new AppError(400, "NIL_FULL", "NIL já está cheio");
  }

  const newNil = Math.min(row.maxNil, current + NIL_SYN_CAFE_AMOUNT);

  // Optimistic lock: capture the stored value this read saw. If a concurrent
  // consume commits a lower `nil` before our UPDATE lands, the guard
  // `gte(characters.nil, rawNil)` fails, the UPDATE returns no rows, and we
  // throw instead of overwriting the consumption (lost-update guard).
  const rawNil = row.nil;

  const [updated] = await db
    .update(characters)
    .set({ nil: newNil, nilUpdatedAt: new Date() })
    .where(
      and(
        eq(characters.userId, userId),
        gte(characters.nil, rawNil), // optimistic lock: fail if another tx modified nil
      ),
    )
    .returning();

  if (!updated) {
    // Don't waste the cooldown on a failed write — let the player retry.
    await redis.del(key);
    throw new AppError(409, "NIL_CONCURRENT_MODIFICATION", "NIL foi modificado por outra ação, tente novamente");
  }

  return { added: newNil - current, status: toNilStatus(updated) };
}
