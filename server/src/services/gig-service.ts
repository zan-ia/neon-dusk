import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type {
  ActiveGig,
  Attributes,
  GigAcceptResponse,
  GigBoardResponse,
  GigDetailResponse,
  GigEscapeResponse,
  GigExecuteResponse,
  GigHistoryEntry,
  GigHistoryResponse,
  GigListItem,
  GigTemplate,
  GigWrapupResponse,
} from "@neon-dusk/shared";
import { NIL_REGEN_INTERVAL_MS, NIL_REGEN_RATE } from "@neon-dusk/shared";
import { db, type Tx } from "../db";
import {
  activeGigs,
  characterWallets,
  characters,
  chromeDefinitions,
  gigHistory,
  gigs,
  heat as heatTable,
  installedChrome,
  transactionLog,
} from "../db/schema";
import { AppError } from "../middleware/error-handler";
import {
  calculateEscapeChance,
  calculateHeat,
  calculatePayout,
  calculateStreetCred,
  calculateSuccessChance,
  canTransition,
  getEscapeStat,
  getRelevantStats,
  isCooldownExpired,
  isUnderDailyLimit,
  meetsStatRequirements,
  rollGigOutcome,
} from "../game/gigs";
import { calculateGigSuccessBonus } from "../game/chrome";
import { ensureWallet } from "./economy-service";
import { transferEddies } from "../game/economy";
import { emitEvent } from "../telemetry/emit-event";

// Neon Dusk — Gig service (orchestration over the pure game logic)
// ============================================================================
// One active gig per character, 5-phase loop (meet → legwork → execute →
// escape → wrap_up, see 03-mecanicas-core.md §2). Phase values are produced
// by the game/gigs.ts state machine and stored verbatim. NIL spend (accept)
// and wallet credit (wrap up) use the same in-transaction optimistic-lock
// patterns as nil-service and chrome-service, so every multi-row write is
// atomic.

/** Queryable client union — helpers run against `db` or a transaction client. */
type Queryable = Tx | typeof db;

/** Columns shared by the active-gig queries (active_gigs ⋈ gigs). */
function activeGigSelect(q: Queryable) {
  return q
    .select({
      id: activeGigs.id,
      gigId: activeGigs.gigId,
      gigName: gigs.name,
      gigType: gigs.type,
      gigTier: gigs.tier,
      phase: activeGigs.phase,
      status: activeGigs.status,
      acceptedAt: activeGigs.acceptedAt,
      legworkStartedAt: activeGigs.legworkStartedAt,
      legworkCompleted: activeGigs.legworkCompleted,
      legworkMinutes: gigs.legworkMinutes,
      executeOutcome: activeGigs.executeOutcome,
      escapeOutcome: activeGigs.escapeOutcome,
      actualPayout: activeGigs.actualPayout,
      escapeDifficulty: gigs.escapeDifficulty,
    })
    .from(activeGigs)
    .innerJoin(gigs, eq(activeGigs.gigId, gigs.id));
}

/** Phases the DB enum accepts (the game state machine only emits these). */
type StoredPhase = NonNullable<typeof activeGigs.$inferInsert.phase>;

/** Query builder for the active-gig join (used to derive the row type). */
function activeGigQuery(q: Queryable, characterId: string) {
  return activeGigSelect(q).where(eq(activeGigs.characterId, characterId)).limit(1);
}

/** One active_gigs ⋈ gigs row as returned by `queryActiveGig`. */
type ActiveGigJoined = Awaited<ReturnType<typeof activeGigQuery>>[number];

/** Map an active_gigs ⋈ gigs row to the API shape (ISO timestamps). */
function toActiveGig(row: ActiveGigJoined): ActiveGig {
  return {
    id: row.id,
    gigId: row.gigId,
    gigName: row.gigName,
    gigType: row.gigType,
    gigTier: row.gigTier,
    phase: row.phase,
    status: row.status,
    acceptedAt: row.acceptedAt.toISOString(),
    legworkStartedAt: row.legworkStartedAt?.toISOString() ?? null,
    legworkCompleted: row.legworkCompleted,
    legworkMinutes: row.legworkMinutes,
    executeOutcome: row.executeOutcome,
    escapeOutcome: row.escapeOutcome,
    actualPayout: row.actualPayout,
    escapeDifficulty: row.escapeDifficulty,
  };
}

/** Character row → Attributes object for the pure game functions. */
function toAttributes(row: typeof characters.$inferSelect): Attributes {
  return {
    body: row.body,
    reflexes: row.reflexes,
    intelligence: row.intelligence,
    technical: row.technical,
    cool: row.cool,
  };
}

/** postgres-js returns aggregate timestamps (max()) as UTC strings — normalize. */
function toDate(v: Date | string | null): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  // "2026-08-07 01:35:32.908572" (UTC) → ISO with Z so Date parses it as UTC.
  return new Date(v.includes("T") ? v : `${v.replace(" ", "T")}Z`);
}

/** Seconds left on a gig cooldown (0 = ready). */
function cooldownRemainingFor(lastAt: Date | string | null, cooldownMinutes: number, now: Date): number {
  const last = toDate(lastAt);
  if (!last) return 0;
  if (isCooldownExpired(last, cooldownMinutes, now)) return 0;
  const msLeft = last.getTime() + cooldownMinutes * 60_000 - now.getTime();
  return Math.ceil(msLeft / 1000);
}

/** Number of gigs completed today (midnight-to-midnight, abandoned excluded). */
async function countTodayGigs(q: Queryable, characterId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [row] = await q
    .select({ count: sql<number>`count(*)::int` })
    .from(gigHistory)
    .where(
      and(
        eq(gigHistory.characterId, characterId),
        gte(gigHistory.completedAt, startOfDay),
        ne(gigHistory.outcome, "abandoned"),
      ),
    );
  return row?.count ?? 0;
}

/** Sum of the character's installed-chrome gig success bonus (percentage points). */
async function getGigSuccessBonus(q: Queryable, characterId: string): Promise<number> {
  const installed = await q
    .select({ defId: installedChrome.chromeDefinitionId })
    .from(installedChrome)
    .where(eq(installedChrome.characterId, characterId));
  if (installed.length === 0) return 0;

  const defs = await q
    .select()
    .from(chromeDefinitions)
    .where(inArray(chromeDefinitions.id, installed.map((i) => i.defId)));
  return calculateGigSuccessBonus(defs);
}

/**
 * Load the character's active gig joined with its template, or null.
 * Shared by every phase transition.
 */
async function queryActiveGig(q: Queryable, characterId: string): Promise<ActiveGigJoined | null> {
  const rows = await activeGigQuery(q, characterId);
  return rows[0] ?? null;
}

/** Best-effort telemetry write — a Redis/DB hiccup must never fail the action. */
function trackGigEvent(
  eventType: "GIG_STARTED" | "GIG_COMPLETED" | "GIG_FAILED",
  characterId: string,
  payload: Record<string, unknown>,
): void {
  void emitEvent({ eventType, actorId: characterId, payload }).catch(() => {
    // intentionally silent — telemetry is fire-and-forget
  });
}

/**
 * GET /api/gigs — the Fixer Cupim board: every gig with computed flags
 * (requirements met, cooldown), the character's active gig and today's count.
 */
export async function listAvailableGigs(characterId: string): Promise<GigBoardResponse> {
  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

  const attrs = toAttributes(character);
  const now = new Date();

  const gigRows = await db.select().from(gigs).orderBy(asc(gigs.tier), asc(gigs.difficulty));

  // Last completion per gig template → per-gig cooldowns.
  const completions = await db
    .select({ gigId: gigHistory.gigId, lastAt: sql<Date>`max(${gigHistory.completedAt})` })
    .from(gigHistory)
    .where(eq(gigHistory.characterId, characterId))
    .groupBy(gigHistory.gigId);
  const lastByGig = new Map(completions.map((c) => [c.gigId, c.lastAt]));

  const board: GigListItem[] = gigRows.map((g) => {
    const meetsRequirements =
      meetsStatRequirements(attrs, g.requiredStats) && character.streetCred >= g.requiredStreetCred;
    return {
      id: g.id,
      name: g.name,
      tier: g.tier,
      type: g.type,
      district: g.district,
      difficulty: g.difficulty,
      baseReward: g.baseReward,
      nilCost: g.nilCost,
      requiredStats: g.requiredStats,
      meetsRequirements,
      cooldownRemaining: cooldownRemainingFor(lastByGig.get(g.id) ?? null, g.cooldownMinutes, now),
    };
  });

  const active = await queryActiveGig(db, characterId);

  return {
    gigs: board,
    activeGig: active ? toActiveGig(active) : null,
    dailyCount: await countTodayGigs(db, characterId),
  };
}

/** GET /api/gigs/active — the character's active gig, or null. */
export async function getActiveGig(characterId: string): Promise<ActiveGig | null> {
  const active = await queryActiveGig(db, characterId);
  return active ? toActiveGig(active) : null;
}

/** GET /api/gigs/:id — one template with requirement/cooldown flags. */
export async function getGigDetail(
  characterId: string,
  gigId: string,
): Promise<GigDetailResponse> {
  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  if (!gig) throw new AppError(404, "GIG_NOT_FOUND", "Gig not found");

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

  const meetsRequirements =
    meetsStatRequirements(toAttributes(character), gig.requiredStats) &&
    character.streetCred >= gig.requiredStreetCred;

  const [last] = await db
    .select({ lastAt: gigHistory.completedAt })
    .from(gigHistory)
    .where(and(eq(gigHistory.characterId, characterId), eq(gigHistory.gigId, gigId)))
    .orderBy(desc(gigHistory.completedAt))
    .limit(1);
  const cooldownRemaining = cooldownRemainingFor(last?.lastAt ?? null, gig.cooldownMinutes, new Date());

  const template: GigTemplate = {
    id: gig.id,
    name: gig.name,
    description: gig.description,
    tier: gig.tier,
    type: gig.type,
    district: gig.district,
    difficulty: gig.difficulty,
    escapeDifficulty: gig.escapeDifficulty,
    requiredStats: gig.requiredStats,
    requiredStreetCred: gig.requiredStreetCred,
    baseReward: gig.baseReward,
    nilCost: gig.nilCost,
    heatGenerated: gig.heatGenerated,
    legworkMinutes: gig.legworkMinutes,
    cooldownMinutes: gig.cooldownMinutes,
    meetsRequirements,
    cooldownRemaining,
  };

  return { gig: template, meetsRequirements, cooldownRemaining };
}

/**
 * POST /api/gigs/:id/accept — phase 1 (meet). Validates street cred, stats,
 * cooldown, daily limit and NIL, then atomically opens an active gig.
 */
export async function acceptGig(characterId: string, gigId: string): Promise<GigAcceptResponse> {
  return db.transaction(async (tx) => {
    const [character] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

    const [gig] = await tx.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
    if (!gig) throw new AppError(404, "GIG_NOT_FOUND", "Gig not found");

    // Lock the row: INSERT first (unique character_id) — a concurrent accept
    // loses the race here and fails BEFORE any NIL is spent.
    const [inserted] = await tx
      .insert(activeGigs)
      .values({ characterId, gigId })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      throw new AppError(400, "ALREADY_ACTIVE_GIG", "You already have an active gig");
    }

    try {
      if (character.streetCred < gig.requiredStreetCred) {
        throw new AppError(
          403,
          "INSUFFICIENT_STREET_CRED",
          `Need ${gig.requiredStreetCred} street cred, have ${character.streetCred}`,
        );
      }
      if (!meetsStatRequirements(toAttributes(character), gig.requiredStats)) {
        throw new AppError(403, "INSUFFICIENT_STATS", "Attributes do not meet the gig requirements");
      }

      const [last] = await tx
        .select({ lastAt: gigHistory.completedAt })
        .from(gigHistory)
        .where(and(eq(gigHistory.characterId, characterId), eq(gigHistory.gigId, gigId)))
        .orderBy(desc(gigHistory.completedAt))
        .limit(1);
      if (last && !isCooldownExpired(last.lastAt, gig.cooldownMinutes)) {
        throw new AppError(400, "GIG_COOLDOWN", "This gig is still on cooldown");
      }

      if (!isUnderDailyLimit(await countTodayGigs(tx, characterId))) {
        throw new AppError(400, "DAILY_GIG_LIMIT", "You have reached today's gig limit");
      }

      // NIL spend (in-transaction, mirrors nil-service.consumeNil): persist the
      // passive regen snapshot AND deduct in one UPDATE. The gte guard is an
      // optimistic lock — a concurrent spend that passed the fail-fast check
      // still loses the WHERE race and gets INSUFFICIENT_NIL.
      const elapsed = Math.max(0, Date.now() - character.nilUpdatedAt.getTime());
      const regenOffset = Math.floor(elapsed / NIL_REGEN_INTERVAL_MS) * NIL_REGEN_RATE;
      const regened = sql`LEAST(${characters.maxNil}, ${characters.nil} + ${regenOffset})`;
      const rawNil = character.nil;

      const [updated] = await tx
        .update(characters)
        .set({ nil: sql`${regened} - ${gig.nilCost}`, nilUpdatedAt: new Date() })
        .where(
          and(
            eq(characters.id, characterId),
            gte(characters.nil, rawNil),
            sql`${regened} >= ${gig.nilCost}`,
          ),
        )
        .returning();
      if (!updated) {
        throw new AppError(400, "INSUFFICIENT_NIL", `Not enough NIL (need ${gig.nilCost})`);
      }

      const activeGig: ActiveGig = {
        id: inserted.id,
        gigId: gig.id,
        gigName: gig.name,
        gigType: gig.type,
        gigTier: gig.tier,
        phase: inserted.phase,
        status: inserted.status,
        acceptedAt: inserted.acceptedAt.toISOString(),
        legworkStartedAt: null,
        legworkCompleted: false,
        legworkMinutes: gig.legworkMinutes,
        executeOutcome: null,
        escapeOutcome: null,
        actualPayout: null,
        escapeDifficulty: gig.escapeDifficulty,
      };

      trackGigEvent("GIG_STARTED", characterId, { gigId: gig.id, gigName: gig.name, tier: gig.tier });
      return { activeGig, nilRemaining: updated.nil };
    } catch (err) {
      // Any validation failure after the INSERT rolls the gig back — the
      // player only pays NIL for a successfully accepted gig.
      await tx.delete(activeGigs).where(eq(activeGigs.id, inserted.id));
      throw err;
    }
  });
}

/**
 * POST /api/gigs/:id/legwork — phase 2. Starts the legwork timer (5-30 min);
 * when it elapses, execute gets +20% success and payout.
 */
export async function doLegwork(characterId: string, gigId: string): Promise<ActiveGig> {
  return db.transaction(async (tx) => {
    const active = await queryActiveGig(tx, characterId);
    if (!active) throw new AppError(404, "NO_ACTIVE_GIG", "No active gig");
    if (active.gigId !== gigId) throw new AppError(409, "GIG_MISMATCH", "Active gig does not match");

    const next = canTransition(active.phase, "start_legwork");
    if (!next) {
      throw new AppError(409, "INVALID_PHASE_TRANSITION", `Cannot start legwork from ${active.phase}`);
    }

    await tx
      .update(activeGigs)
      .set({ phase: next as StoredPhase, legworkStartedAt: new Date(), updatedAt: new Date() })
      .where(eq(activeGigs.id, active.id));

    return toActiveGig({ ...active, phase: next as StoredPhase, legworkStartedAt: new Date() });
  });
}

/**
 * POST /api/gigs/:id/execute — phase 3. Rolls stats vs difficulty.
 * From `meet` it skips legwork (-20% success, "modo rápido"); from `legwork`
 * it applies the +20% bonus once the timer has elapsed.
 */
export async function executeGig(characterId: string, gigId: string): Promise<GigExecuteResponse> {
  return db.transaction(async (tx) => {
    const active = await queryActiveGig(tx, characterId);
    if (!active) throw new AppError(404, "NO_ACTIVE_GIG", "No active gig");
    if (active.gigId !== gigId) throw new AppError(409, "GIG_MISMATCH", "Active gig does not match");

    const [gig] = await tx.select().from(gigs).where(eq(gigs.id, active.gigId)).limit(1);
    if (!gig) throw new AppError(404, "GIG_NOT_FOUND", "Gig not found");

    const skippedLegwork = active.phase === "meet";
    const next =
      active.phase === "meet"
        ? canTransition("meet", "skip_to_execute")
        : active.phase === "legwork"
          ? canTransition("legwork", "execute")
          : null;
    if (!next) {
      throw new AppError(409, "INVALID_PHASE_TRANSITION", `Cannot execute from ${active.phase}`);
    }

    const [character] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

    const legworkDone =
      active.legworkStartedAt !== null &&
      Date.now() >= active.legworkStartedAt.getTime() + gig.legworkMinutes * 60_000;

    const { primary } = getRelevantStats(gig.type, toAttributes(character));
    const chromeBonus = await getGigSuccessBonus(tx, characterId);
    let chance = calculateSuccessChance(primary, chromeBonus, gig.difficulty);
    if (skippedLegwork) chance = Math.min(0.95, chance * 0.8);
    else if (legworkDone) chance = Math.min(0.95, chance * 1.2);

    const outcome = rollGigOutcome(chance);
    const actualPayout = outcome.success
      ? calculatePayout(gig.baseReward, { legworkBonus: legworkDone, successBonus: true })
      : 0;

    await tx
      .update(activeGigs)
      .set({
        phase: next as StoredPhase,
        legworkCompleted: legworkDone,
        executeOutcome: outcome.success ? "success" : "failure",
        actualPayout,
        updatedAt: new Date(),
      })
      .where(eq(activeGigs.id, active.id));

    return {
      activeGig: toActiveGig({
        ...active,
        phase: next as StoredPhase,
        legworkCompleted: legworkDone,
        executeOutcome: outcome.success ? "success" : "failure",
        actualPayout,
      }),
      outcome: { success: outcome.success, roll: outcome.roll, successChance: outcome.successChance },
    };
  });
}

/**
 * POST /api/gigs/:id/escape — phase 4. Rolls vs escape difficulty with a
 * district-heat penalty (every 100 heat doubles the difficulty). Persists the
 * escape outcome; the heat it generates is committed at wrap up.
 */
export async function escapeGig(characterId: string, gigId: string): Promise<GigEscapeResponse> {
  return db.transaction(async (tx) => {
    const active = await queryActiveGig(tx, characterId);
    if (!active) throw new AppError(404, "NO_ACTIVE_GIG", "No active gig");
    if (active.gigId !== gigId) throw new AppError(409, "GIG_MISMATCH", "Active gig does not match");
    if (!canTransition(active.phase, "escape")) {
      throw new AppError(409, "INVALID_PHASE_TRANSITION", "Escape is only available after executing");
    }

    const [gig] = await tx.select().from(gigs).where(eq(gigs.id, active.gigId)).limit(1);
    if (!gig) throw new AppError(404, "GIG_NOT_FOUND", "Gig not found");

    const [character] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

    const [districtHeat] = await tx
      .select({ amount: heatTable.amount })
      .from(heatTable)
      .where(and(eq(heatTable.characterId, characterId), eq(heatTable.district, gig.district)))
      .limit(1);

    const stat = getEscapeStat(gig.type, toAttributes(character));
    const chance = calculateEscapeChance(stat, gig.escapeDifficulty, districtHeat?.amount ?? 0);
    const outcome = rollGigOutcome(chance);
    const heatGenerated = calculateHeat(gig.heatGenerated, active.executeOutcome ?? "failure");

    await tx
      .update(activeGigs)
      .set({
        phase: "escape",
        escapeOutcome: outcome.success ? "success" : "failure",
        updatedAt: new Date(),
      })
      .where(eq(activeGigs.id, active.id));

    return {
      activeGig: toActiveGig({
        ...active,
        phase: "escape",
        escapeOutcome: outcome.success ? "success" : "failure",
      }),
      outcome: { success: outcome.success, roll: outcome.roll, successChance: outcome.successChance },
      heatGenerated,
    };
  });
}

/**
 * POST /api/gigs/:id/wrapup — phase 5. Resolves the gig: payout (execute
 * success only), street cred, district heat, history row — then closes the
 * active gig. All wallet/character/heat writes are one atomic transaction.
 */
export async function wrapUpGig(characterId: string, gigId: string): Promise<GigWrapupResponse> {
  return db.transaction(async (tx) => {
    const active = await queryActiveGig(tx, characterId);
    if (!active) throw new AppError(404, "NO_ACTIVE_GIG", "No active gig");
    if (active.gigId !== gigId) throw new AppError(409, "GIG_MISMATCH", "Active gig does not match");
    // The wrap_up action is taken while in the escape phase (see the phase
    // machine in game/gigs.ts: escape → wrap_up); wrap_up is terminal and the
    // row is deleted right after, so it is never observed by the client.
    if (active.phase !== "escape") {
      throw new AppError(409, "INVALID_PHASE_TRANSITION", "Wrap up is only available after escaping");
    }
    const terminalPhase = canTransition("escape", "wrap_up");

    const [gig] = await tx.select().from(gigs).where(eq(gigs.id, active.gigId)).limit(1);
    if (!gig) throw new AppError(404, "GIG_NOT_FOUND", "Gig not found");

    const [character] = await tx
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");

    // Outcome: execute failure means the job was botched (no payout, no cred).
    const executed = active.executeOutcome === "success";
    const outcome = executed ? "success" : "failure";
    const payout = executed
      ? calculatePayout(gig.baseReward, { legworkBonus: active.legworkCompleted, successBonus: true })
      : 0;
    const streetCredGained = executed ? calculateStreetCred(gig.tier) : 0;
    const heatDelta = calculateHeat(gig.heatGenerated, active.executeOutcome ?? "failure");

    // 1. Wallet credit — optimistic lock (same pattern as buyFromVendor).
    // A failed execute pays 0; transferEddies rejects zero amounts, so the
    // credit (and its audit entry) is skipped entirely on failure.
    const wallet = await ensureWallet(characterId, tx);
    let newBalance = wallet.balance;
    if (payout > 0) {
      const result = transferEddies(wallet, payout, {
        type: "GIG_PAYOUT",
        source: `Gig concluído: ${gig.name}`,
        referenceType: "gig",
        referenceId: gig.id,
      });
      const [updatedWallet] = await tx
        .update(characterWallets)
        .set({
          balance: result.wallet.balance,
          lifetimeEarned: result.wallet.lifetimeEarned,
          version: wallet.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(characterWallets.characterId, characterId),
            eq(characterWallets.version, wallet.version),
          ),
        )
        .returning();
      if (!updatedWallet) {
        throw new AppError(409, "CONCURRENCY_CONFLICT", "Wallet changed concurrently. Try again.");
      }
      await tx.insert(transactionLog).values({
        characterId,
        type: "GIG_PAYOUT",
        amount: payout,
        balanceBefore: result.transaction.balanceBefore,
        balanceAfter: result.transaction.balanceAfter,
        source: result.transaction.source,
        referenceType: "gig",
        referenceId: gig.id,
      });
      newBalance = updatedWallet.balance;
    }

    // 2. Street cred — clamp at 100 so the DB CHECK never fires; report the
    // amount actually granted. Every wrap-up (success or failure) refreshes
    // `lastActivityAt` — playing resets the 7-day decay grace. The lifetime
    // max (decay floor) only ever grows.
    const newStreetCred = Math.min(100, character.streetCred + streetCredGained);
    const scGranted = newStreetCred - character.streetCred;
    await tx
      .update(characters)
      .set({
        streetCred: newStreetCred,
        maxStreetCredAchieved: sql`GREATEST(max_street_cred_achieved, ${newStreetCred})`,
        lastActivityAt: sql`NOW()`,
        updatedAt: new Date(),
      })
      .where(eq(characters.id, characterId));

    // 3. District heat — upsert (one row per character + district).
    if (heatDelta > 0) {
      await tx
        .insert(heatTable)
        .values({ characterId, district: gig.district, amount: heatDelta, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [heatTable.characterId, heatTable.district],
          set: { amount: sql`${heatTable.amount} + ${heatDelta}`, updatedAt: new Date() },
        });
    }

    // 4. History entry — the phases actually visited.
    const phasesCompleted = ["meet"];
    if (active.legworkStartedAt) phasesCompleted.push("legwork");
    phasesCompleted.push("execute", "escape", terminalPhase ?? "wrap_up");

    await tx.insert(gigHistory).values({
      characterId,
      gigId: gig.id,
      outcome,
      phasesCompleted,
      payout,
      streetCredGained: scGranted,
      heatAccumulated: heatDelta,
      district: gig.district,
    });

    // 5. Close the active gig.
    await tx.delete(activeGigs).where(eq(activeGigs.id, active.id));

    trackGigEvent(
      outcome === "success" ? "GIG_COMPLETED" : "GIG_FAILED",
      characterId,
      { gigId: gig.id, gigName: gig.name, payout, streetCred: scGranted },
    );

    return {
      outcome,
      payout,
      streetCredGained: scGranted,
      heatAccumulated: heatDelta,
      newBalance,
    };
  });
}

/**
 * GET /api/gigs/history — completed gigs, newest first, cursor-paginated by
 * `completedAt` (ISO 8601). One extra row is read to detect the next page.
 */
export async function getGigHistory(
  characterId: string,
  limit: number = 20,
  cursor?: string,
): Promise<GigHistoryResponse> {
  const conditions = [eq(gigHistory.characterId, characterId)];
  if (cursor) conditions.push(lt(gigHistory.completedAt, new Date(cursor)));

  const rows = await db
    .select({
      id: gigHistory.id,
      gigId: gigHistory.gigId,
      gigName: gigs.name,
      tier: gigs.tier,
      type: gigs.type,
      outcome: gigHistory.outcome,
      payout: gigHistory.payout,
      streetCredGained: gigHistory.streetCredGained,
      heatAccumulated: gigHistory.heatAccumulated,
      district: gigHistory.district,
      completedAt: gigHistory.completedAt,
    })
    .from(gigHistory)
    .innerJoin(gigs, eq(gigHistory.gigId, gigs.id))
    .where(and(...conditions))
    .orderBy(desc(gigHistory.completedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const history: GigHistoryEntry[] = page.map((row) => ({
    ...row,
    completedAt: row.completedAt.toISOString(),
  }));

  return {
    history,
    nextCursor: hasMore ? page[page.length - 1].completedAt.toISOString() : null,
  };
}
