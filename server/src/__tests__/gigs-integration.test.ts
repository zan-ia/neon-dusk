import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app";
import { envSchema } from "../env";
import { insertTestCharacter, resetDb } from "./helpers";
import { db } from "../db";
import {
  activeGigs,
  characters,
  gigHistory,
  gigs,
  heat as heatTable,
  transactionLog,
} from "../db/schema";
import {
  acceptGig,
  doLegwork,
  escapeGig,
  executeGig,
  getActiveGig,
  getGigDetail,
  getGigHistory,
  listAvailableGigs,
  wrapUpGig,
} from "../services/gig-service";
import { seedGigs } from "../db/seed";
import type {
  ActiveGig,
  AuthResponse,
  GigAcceptResponse,
  GigBoardResponse,
  GigDetailResponse,
  GigEscapeResponse,
  GigExecuteResponse,
  GigWrapupResponse,
} from "@neon-dusk/shared";

// ND-011 — gigs service + API integration tests. Real Postgres/Redis on the
// isolated test stack (docker-compose.test.yml). Routes are exercised with
// app.inject() (supertest is incompatible with Fastify 5 + rate-limit).
// Dedicated redis db (10) so rate-limit counters never leak across files.
//
// Character template used throughout (insertTestCharacter defaults):
//   body 5, reflexes 4, intelligence 4, technical 4, cool 5 — SC 0, NIL 100.
// "Corre da Farmácia" (T1, delivery): {cool:3}, SC 0, NIL 10, reward 500,
// heat 5, legwork 5 min, cooldown 10 min, district Babilônia — the gig every
// fresh character can take.

const REDIS_TEST_DB = "redis://localhost:56379/10";
const PASSWORD = "StrongPass123!";
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

let seq = 0;
function uniqueEmail(): string {
  return `gig-${Date.now()}-${seq++}@neondusk.test`;
}
function uniqueName(): string {
  return `Fixer-${Date.now()}-${seq++}`;
}

interface ErrorBody {
  error: string;
  message: string;
}

describe("ND-011 — gigs service & API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetDb();

    const redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
    await redis.flushdb();
    redis.disconnect();

    app = await buildApp({ env: envSchema.parse({ ...process.env, REDIS_URL: REDIS_TEST_DB }) });
    await seedGigs();
  });

  afterAll(async () => {
    await app.close();
  });

  /** DB row of a seeded template, by display name. */
  async function gigByName(name: string) {
    const [gig] = await db.select().from(gigs).where(eq(gigs.name, name)).limit(1);
    if (!gig) throw new Error(`seeded gig not found: ${name}`);
    return gig;
  }

  /** The gig every fresh test character qualifies for. */
  async function farmaGig() {
    return gigByName("Corre da Farmácia");
  }

  /** Force the active gig into the escape phase with a deterministic outcome. */
  async function forceEscapePhase(characterId: string, opts: { outcome: "success" | "failure" }) {
    await db
      .update(activeGigs)
      .set({
        phase: "escape",
        executeOutcome: opts.outcome,
        legworkCompleted: opts.outcome === "success",
        legworkStartedAt: opts.outcome === "success" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(activeGigs.characterId, characterId));
  }

  describe("gig catalog seeding (db/seed)", () => {
    it("should seed the 10 static templates into the gigs table", async () => {
      const rows = await db.select().from(gigs);
      expect(rows).toHaveLength(10);
    });

    it("should be idempotent — a second run inserts nothing", async () => {
      expect(await seedGigs()).toBe(0);
      const rows = await db.select().from(gigs);
      expect(rows).toHaveLength(10);
    });
  });

  describe("listAvailableGigs", () => {
    it("should return the full board for a fresh character: 10 gigs, no active gig, 0 daily", async () => {
      const { characterId } = await insertTestCharacter();

      const board = await listAvailableGigs(characterId);

      expect(board.gigs).toHaveLength(10);
      expect(board.activeGig).toBeNull();
      expect(board.dailyCount).toBe(0);
      for (const g of board.gigs) {
        expect(g).toMatchObject({
          id: expect.any(String),
          name: expect.any(String),
          tier: expect.stringMatching(/^t[12]$/),
          type: expect.stringMatching(/^(extraction|delivery|sabotage)$/),
          baseReward: expect.any(Number),
          nilCost: expect.any(Number),
          meetsRequirements: expect.any(Boolean),
          cooldownRemaining: expect.any(Number),
        });
      }
    });

    it("should sort by tier then difficulty (easiest T1 first)", async () => {
      const { characterId } = await insertTestCharacter();
      const board = await listAvailableGigs(characterId);

      expect(board.gigs[0].name).toBe("Corre da Farmácia"); // T1, difficulty 30
      const firstT2 = board.gigs.findIndex((g) => g.tier === "t2");
      expect(firstT2).toBeGreaterThanOrEqual(6);
      for (let i = firstT2; i < board.gigs.length; i++) {
        expect(board.gigs[i].tier).toBe("t2");
      }
    });

    it("should flag meetsRequirements true when stats and street cred allow the gig", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === farma.id)!;
      expect(entry.meetsRequirements).toBe(true); // cool 5 ≥ 3, SC 0 ≥ 0
    });

    it("should flag meetsRequirements false when a stat requirement fails", async () => {
      const { characterId } = await insertTestCharacter();
      const mula = await gigByName("Mula Noturna"); // requires {reflexes: 5, cool: 3}

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === mula.id)!;
      expect(entry.meetsRequirements).toBe(false); // reflexes 4 < 5
    });

    it("should flag meetsRequirements false for T2 gigs when street cred is below 5", async () => {
      const { characterId } = await insertTestCharacter();
      const bagre = await gigByName("Bagre Ensaboado"); // T2, SC 5

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === bagre.id)!;
      expect(entry.meetsRequirements).toBe(false); // SC 0 < 5
    });

    it("should report a fresh gig with no history as having 0 cooldown", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === farma.id)!;
      expect(entry.cooldownRemaining).toBe(0);
    });

    it("should report a running cooldown after a recent completion", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.insert(gigHistory).values({
        characterId,
        gigId: farma.id,
        outcome: "success",
        phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
        payout: 500,
        streetCredGained: 2,
        heatAccumulated: 5,
        district: farma.district,
      });

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === farma.id)!;
      expect(entry.cooldownRemaining).toBeGreaterThan(0);
      expect(entry.cooldownRemaining).toBeLessThanOrEqual(600); // 10-min cooldown
    });

    it("should report 0 cooldown once the cooldown window has elapsed", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.insert(gigHistory).values({
        characterId,
        gigId: farma.id,
        outcome: "success",
        phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
        payout: 500,
        streetCredGained: 2,
        heatAccumulated: 5,
        district: farma.district,
        completedAt: new Date(Date.now() - 20 * 60_000),
      });

      const board = await listAvailableGigs(characterId);
      const entry = board.gigs.find((g) => g.id === farma.id)!;
      expect(entry.cooldownRemaining).toBe(0);
    });

    it("should throw 404 NO_CHARACTER for an unknown character", async () => {
      await expect(listAvailableGigs(ZERO_ID)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_CHARACTER",
      });
    });
  });

  describe("getActiveGig", () => {
    it("should return null when the character has no active gig", async () => {
      const { characterId } = await insertTestCharacter();
      expect(await getActiveGig(characterId)).toBeNull();
    });

    it("should return the active gig with the template join after accepting", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);

      const active = await getActiveGig(characterId);
      expect(active).toMatchObject({
        gigId: farma.id,
        gigName: "Corre da Farmácia",
        gigType: "delivery",
        gigTier: "t1",
        phase: "meet",
        status: "active",
        legworkCompleted: false,
        executeOutcome: null,
        escapeOutcome: null,
        actualPayout: null,
        escapeDifficulty: 30,
      });
      expect(active!.legworkStartedAt).toBeNull();
    });
  });

  describe("getGigDetail", () => {
    it("should return the template with requirement flags for a fresh character", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();

      const detail = await getGigDetail(characterId, farma.id);

      expect(detail.gig.name).toBe("Corre da Farmácia");
      expect(detail.meetsRequirements).toBe(true);
      expect(detail.cooldownRemaining).toBe(0);
    });

    it("should throw 404 GIG_NOT_FOUND for an unknown gig", async () => {
      const { characterId } = await insertTestCharacter();
      await expect(getGigDetail(characterId, ZERO_ID)).rejects.toMatchObject({
        statusCode: 404,
        code: "GIG_NOT_FOUND",
      });
    });
  });

  describe("acceptGig", () => {
    it("should open the gig in the meet phase and deduct NIL", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();

      const res = await acceptGig(characterId, farma.id);

      expect(res.activeGig.phase).toBe("meet");
      expect(res.activeGig.gigName).toBe("Corre da Farmácia");
      expect(res.nilRemaining).toBe(90); // 100 - 10
    });

    it("should reject a second accept while a gig is active (no double NIL spend)", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);

      await expect(acceptGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 400,
        code: "ALREADY_ACTIVE_GIG",
      });

      const [char] = await db.select({ nil: characters.nil }).from(characters).where(eq(characters.id, characterId));
      expect(char!.nil).toBe(90);
      const active = await getActiveGig(characterId);
      expect(active!.gigId).toBe(farma.id);
    });

    it("should accept a second gig once the first is wrapped up (same day)", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      const extravio = await gigByName("Encomenda Extraviada");
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });
      await wrapUpGig(characterId, farma.id);

      const res = await acceptGig(characterId, extravio.id);
      expect(res.activeGig.gigName).toBe("Encomenda Extraviada");
      expect(res.nilRemaining).toBe(78); // 100 - 10 (farma) - 12 (extravio)
    });

    it("should throw 400 INSUFFICIENT_NIL and roll back the active gig when NIL is too low", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.update(characters).set({ nil: 5 }).where(eq(characters.id, characterId));

      await expect(acceptGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 400,
        code: "INSUFFICIENT_NIL",
      });

      // Rolled back: no active gig row, NIL untouched.
      expect(await getActiveGig(characterId)).toBeNull();
      const [char] = await db.select({ nil: characters.nil }).from(characters).where(eq(characters.id, characterId));
      expect(char!.nil).toBe(5);
    });

    it("should throw 403 INSUFFICIENT_STREET_CRED for a T2 gig below SC 5 and roll back", async () => {
      const { characterId } = await insertTestCharacter();
      const bagre = await gigByName("Bagre Ensaboado"); // T2, SC 5

      await expect(acceptGig(characterId, bagre.id)).rejects.toMatchObject({
        statusCode: 403,
        code: "INSUFFICIENT_STREET_CRED",
      });
      expect(await getActiveGig(characterId)).toBeNull();
    });

    it("should accept a T2 gig once the character has 5 street cred and the stats", async () => {
      const { characterId } = await insertTestCharacter();
      const bagre = await gigByName("Bagre Ensaboado"); // requires {body: 6, technical: 5}
      await db
        .update(characters)
        // Keep the attribute spread at 22 (characters_attrs_total CHECK).
        .set({ streetCred: 5, body: 6, reflexes: 3, intelligence: 3, technical: 5, cool: 5 })
        .where(eq(characters.id, characterId));

      const res = await acceptGig(characterId, bagre.id);
      expect(res.activeGig.gigTier).toBe("t2");
      expect(res.nilRemaining).toBe(82); // 100 - 18
    });

    it("should throw 403 INSUFFICIENT_STATS when attributes miss the requirements and roll back", async () => {
      const { characterId } = await insertTestCharacter();
      const mula = await gigByName("Mula Noturna"); // requires {reflexes: 5, cool: 3}

      await expect(acceptGig(characterId, mula.id)).rejects.toMatchObject({
        statusCode: 403,
        code: "INSUFFICIENT_STATS",
      });
      expect(await getActiveGig(characterId)).toBeNull();
      const [char] = await db.select({ nil: characters.nil }).from(characters).where(eq(characters.id, characterId));
      expect(char!.nil).toBe(100); // NIL untouched on rollback
    });

    it("should throw 400 GIG_COOLDOWN when the same gig was completed recently", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.insert(gigHistory).values({
        characterId,
        gigId: farma.id,
        outcome: "success",
        phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
        payout: 500,
        streetCredGained: 2,
        heatAccumulated: 5,
        district: farma.district,
        completedAt: new Date(), // just now — 10-min cooldown still running
      });

      await expect(acceptGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 400,
        code: "GIG_COOLDOWN",
      });
      expect(await getActiveGig(characterId)).toBeNull();
    });

    it("should allow accepting again once the cooldown has expired", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.insert(gigHistory).values({
        characterId,
        gigId: farma.id,
        outcome: "success",
        phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
        payout: 500,
        streetCredGained: 2,
        heatAccumulated: 5,
        district: farma.district,
        completedAt: new Date(Date.now() - 11 * 60_000),
      });

      const res = await acceptGig(characterId, farma.id);
      expect(res.activeGig.gigName).toBe("Corre da Farmácia");
    });

    it("should throw 400 DAILY_GIG_LIMIT once 10 gigs were completed today and roll back", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      // Completed 20 minutes ago so the per-gig cooldown (10 min) has expired
      // and the daily-limit check is the one that fires.
      await db.insert(gigHistory).values(
        Array.from({ length: 10 }, () => ({
          characterId,
          gigId: farma.id,
          outcome: "success" as const,
          phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
          payout: 0,
          streetCredGained: 0,
          heatAccumulated: 0,
          district: farma.district,
          completedAt: new Date(Date.now() - 20 * 60_000),
        })),
      );

      await expect(acceptGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 400,
        code: "DAILY_GIG_LIMIT",
      });
      expect(await getActiveGig(characterId)).toBeNull();
    });

    it("should throw 404 GIG_NOT_FOUND for an unknown gig", async () => {
      const { characterId } = await insertTestCharacter();
      await expect(acceptGig(characterId, ZERO_ID)).rejects.toMatchObject({
        statusCode: 404,
        code: "GIG_NOT_FOUND",
      });
    });

    it("should throw 404 NO_CHARACTER for an unknown character", async () => {
      const farma = await farmaGig();
      await expect(acceptGig(ZERO_ID, farma.id)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_CHARACTER",
      });
    });
  });

  describe("doLegwork", () => {
    it("should transition meet → legwork and stamp the legwork start time", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);

      const active = await doLegwork(characterId, farma.id);

      expect(active.phase).toBe("legwork");
      expect(active.legworkStartedAt).not.toBeNull();
    });

    it("should throw 404 NO_ACTIVE_GIG when no gig is active", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await expect(doLegwork(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_ACTIVE_GIG",
      });
    });

    it("should throw 409 GIG_MISMATCH when the id is not the active gig", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      const extravio = await gigByName("Encomenda Extraviada");
      await acceptGig(characterId, farma.id);

      await expect(doLegwork(characterId, extravio.id)).rejects.toMatchObject({
        statusCode: 409,
        code: "GIG_MISMATCH",
      });
    });

    it("should throw 409 INVALID_PHASE_TRANSITION when already in legwork", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);

      await expect(doLegwork(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_PHASE_TRANSITION",
      });
    });
  });

  describe("executeGig", () => {
    it("should roll the outcome and move meet → execute (skip legwork)", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);

      const res = await executeGig(characterId, farma.id);

      expect(res.activeGig.phase).toBe("execute");
      expect(res.activeGig.legworkCompleted).toBe(false);
      expect(["success", "failure"]).toContain(res.activeGig.executeOutcome);
      expect(res.activeGig.actualPayout).toBe(res.outcome.success ? 550 : 0); // 500 × 1.1
      expect(res.outcome.successChance).toBeGreaterThanOrEqual(0.05);
      expect(res.outcome.successChance).toBeLessThanOrEqual(0.95);
    });

    it("should roll from legwork without the bonus while the timer is running", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);

      const res = await executeGig(characterId, farma.id);

      expect(res.activeGig.phase).toBe("execute");
      expect(res.activeGig.legworkCompleted).toBe(false);
      expect(res.activeGig.actualPayout).toBe(res.outcome.success ? 550 : 0); // no legwork bonus
    });

    it("should mark legwork completed and apply the +20% payout when the timer elapsed", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig(); // legworkMinutes 5
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);
      // Backdate the start so the 5-minute timer has elapsed.
      await db
        .update(activeGigs)
        .set({ legworkStartedAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(activeGigs.characterId, characterId));

      const res = await executeGig(characterId, farma.id);

      expect(res.activeGig.legworkCompleted).toBe(true);
      expect(res.activeGig.actualPayout).toBe(res.outcome.success ? 660 : 0); // 500 × 1.2 × 1.1
    });

    it("should throw 404 NO_ACTIVE_GIG when no gig is active", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await expect(executeGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_ACTIVE_GIG",
      });
    });

    it("should throw 409 INVALID_PHASE_TRANSITION when executing twice", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await executeGig(characterId, farma.id);

      await expect(executeGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_PHASE_TRANSITION",
      });
    });
  });

  describe("escapeGig", () => {
    it("should roll the escape outcome, move to the escape phase and report heat", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig(); // heatGenerated 5
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);
      const exec = await executeGig(characterId, farma.id);

      const res = await escapeGig(characterId, farma.id);

      expect(res.activeGig.phase).toBe("escape");
      expect(["success", "failure"]).toContain(res.activeGig.escapeOutcome);
      // Heat is doubled when the execute roll failed.
      const expectedHeat = exec.outcome.success ? 5 : 10;
      expect(res.heatGenerated).toBe(expectedHeat);
      expect(res.outcome.successChance).toBeGreaterThanOrEqual(0.05);
      expect(res.outcome.successChance).toBeLessThanOrEqual(0.95);
    });

    it("should throw 409 INVALID_PHASE_TRANSITION before executing", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);

      await expect(escapeGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_PHASE_TRANSITION",
      });
    });

    it("should throw 404 NO_ACTIVE_GIG when no gig is active", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await expect(escapeGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_ACTIVE_GIG",
      });
    });
  });

  describe("wrapUpGig", () => {
    it("should pay out, grant street cred, accumulate heat and record history on success", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig(); // reward 500, heat 5
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });

      const res = await wrapUpGig(characterId, farma.id);

      expect(res.outcome).toBe("success");
      expect(res.payout).toBe(660); // 500 × 1.2 (legwork) × 1.1 (success)
      expect(res.streetCredGained).toBeGreaterThanOrEqual(1); // T1 range [1,3]
      expect(res.streetCredGained).toBeLessThanOrEqual(3);
      expect(res.heatAccumulated).toBe(5);
      expect(res.newBalance).toBe(1160); // 500 seed + 660

      // Active gig is closed.
      expect(await getActiveGig(characterId)).toBeNull();

      // History entry recorded.
      const [history] = await db
        .select()
        .from(gigHistory)
        .where(eq(gigHistory.characterId, characterId));
      expect(history).toMatchObject({
        gigId: farma.id,
        outcome: "success",
        payout: 660,
        streetCredGained: res.streetCredGained,
        heatAccumulated: 5,
        district: "Babilônia",
      });
      expect(history.phasesCompleted).toContain("meet");
      expect(history.phasesCompleted).toContain("legwork");
      expect(history.phasesCompleted).toContain("execute");
      expect(history.phasesCompleted).toContain("escape");
      expect(history.phasesCompleted).toContain("wrap_up");
    });

    it("should credit the wallet with a GIG_PAYOUT audit entry", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });
      await wrapUpGig(characterId, farma.id);

      const [log] = await db
        .select()
        .from(transactionLog)
        .where(and(eq(transactionLog.characterId, characterId), eq(transactionLog.type, "GIG_PAYOUT")));
      expect(log).toMatchObject({
        amount: 660,
        balanceBefore: 500,
        balanceAfter: 1160,
        referenceType: "gig",
      });
    });

    it("should pay nothing and double the heat when the execute roll failed", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "failure" });

      const res = await wrapUpGig(characterId, farma.id);

      expect(res.outcome).toBe("failure");
      expect(res.payout).toBe(0);
      expect(res.streetCredGained).toBe(0);
      expect(res.heatAccumulated).toBe(10); // 5 × 2
      expect(res.newBalance).toBe(500); // no credit

      const [history] = await db
        .select()
        .from(gigHistory)
        .where(eq(gigHistory.characterId, characterId));
      expect(history.outcome).toBe("failure");
      expect(history.payout).toBe(0);
    });

    it("should clamp street cred at 100 and report only the granted amount", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });
      await db.update(characters).set({ streetCred: 99 }).where(eq(characters.id, characterId));

      const res = await wrapUpGig(characterId, farma.id);

      expect(res.streetCredGained).toBe(1);
      const [char] = await db
        .select({ streetCred: characters.streetCred })
        .from(characters)
        .where(eq(characters.id, characterId));
      expect(char!.streetCred).toBe(100);
    });

    it("should accumulate heat into the district heat row (upsert)", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await db.insert(heatTable).values({
        characterId,
        district: farma.district,
        amount: 5,
      });
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });

      await wrapUpGig(characterId, farma.id);

      const [heatRow] = await db
        .select()
        .from(heatTable)
        .where(and(eq(heatTable.characterId, characterId), eq(heatTable.district, farma.district)));
      expect(heatRow!.amount).toBe(10); // 5 pre-existing + 5 from the gig
    });

    it("should throw 409 INVALID_PHASE_TRANSITION before the escape phase", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await doLegwork(characterId, farma.id);
      await executeGig(characterId, farma.id);

      await expect(wrapUpGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_PHASE_TRANSITION",
      });
    });

    it("should throw 404 NO_ACTIVE_GIG when no gig is active", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await expect(wrapUpGig(characterId, farma.id)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_ACTIVE_GIG",
      });
    });
  });

  describe("getGigHistory", () => {
    it("should return an empty history for a fresh character", async () => {
      const { characterId } = await insertTestCharacter();
      const res = await getGigHistory(characterId);
      expect(res).toEqual({ history: [], nextCursor: null });
    });

    it("should list the completed gig newest-first after a wrap up", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      await acceptGig(characterId, farma.id);
      await forceEscapePhase(characterId, { outcome: "success" });
      await wrapUpGig(characterId, farma.id);

      const res = await getGigHistory(characterId);
      expect(res.history).toHaveLength(1);
      expect(res.history[0]).toMatchObject({
        gigName: "Corre da Farmácia",
        outcome: "success",
        payout: 660,
        district: "Babilônia",
      });
      expect(res.nextCursor).toBeNull();
    });

    it("should paginate with the cursor (limit + next page)", async () => {
      const { characterId } = await insertTestCharacter();
      const farma = await farmaGig();
      for (const [i, offsetMin] of [30, 20, 10].entries()) {
        await db.insert(gigHistory).values({
          characterId,
          gigId: farma.id,
          outcome: i === 2 ? ("failure" as const) : ("success" as const),
          phasesCompleted: ["meet", "execute", "escape", "wrap_up"],
          payout: i === 2 ? 0 : 500,
          streetCredGained: 0,
          heatAccumulated: 5,
          district: farma.district,
          completedAt: new Date(Date.now() - offsetMin * 60_000),
        });
      }

      const page1 = await getGigHistory(characterId, 2);
      expect(page1.history).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await getGigHistory(characterId, 2, page1.nextCursor!);
      expect(page2.history).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(page2.history[0].id).not.toBe(page1.history[0].id);
    });
  });

  // ─── API routes (app.inject) ───────────────────────────────────────────────

  /** Register a user + character over HTTP; returns the token and character id. */
  async function registerApiUser(): Promise<{ accessToken: string; characterId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: uniqueEmail(), password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const { accessToken } = res.json() as AuthResponse;

    const created = await app.inject({
      method: "POST",
      url: "/api/characters",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: uniqueName(),
        origin: "a_paraiso",
        role: "solo",
        attributes: { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 },
      },
    });
    expect(created.statusCode).toBe(201);
    const character = created.json() as { id: string };
    return { accessToken, characterId: character.id };
  }

  describe("GET /api/gigs", () => {
    it("should return the board with computed flags", async () => {
      const { accessToken: token } = await registerApiUser();

      const res = await app.inject({
        method: "GET",
        url: "/api/gigs",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigBoardResponse;
      expect(body.gigs).toHaveLength(10);
      expect(body.activeGig).toBeNull();
      expect(body.dailyCount).toBe(0);
      // Fresh character meets the easiest gig (cool 5 ≥ 3) but not the Mula
      // Noturna (reflexes 4 < 5) nor any T2 (SC 0 < 5).
      const byName = new Map(body.gigs.map((g) => [g.name, g]));
      expect(byName.get("Corre da Farmácia")!.meetsRequirements).toBe(true);
      expect(byName.get("Mula Noturna")!.meetsRequirements).toBe(false);
      expect(byName.get("Bagre Ensaboado")!.meetsRequirements).toBe(false);
    });

    it("should return 401 without an access token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/gigs" });
      expect(res.statusCode).toBe(401);
      expect((res.json() as ErrorBody).error).toBe("UNAUTHORIZED");
    });
  });

  describe("GET /api/gigs/active", () => {
    it("should return null when no gig is active", async () => {
      const { accessToken: token } = await registerApiUser();

      const res = await app.inject({
        method: "GET",
        url: "/api/gigs/active",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });

    it("should return 401 without an access token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/gigs/active" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/gigs/:id", () => {
    it("should return the gig template with flags", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();

      const res = await app.inject({
        method: "GET",
        url: `/api/gigs/${farma.id}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigDetailResponse;
      expect(body.gig.name).toBe("Corre da Farmácia");
      expect(body.meetsRequirements).toBe(true);
      expect(body.cooldownRemaining).toBe(0);
    });

    it("should return 400 VALIDATION_ERROR for a non-uuid id", async () => {
      const { accessToken: token } = await registerApiUser();
      const res = await app.inject({
        method: "GET",
        url: "/api/gigs/not-a-uuid",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorBody).error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without an access token", async () => {
      const farma = await farmaGig();
      const res = await app.inject({ method: "GET", url: `/api/gigs/${farma.id}` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/gigs/history", () => {
    it("should return an empty page for a fresh character", async () => {
      const { accessToken: token } = await registerApiUser();

      const res = await app.inject({
        method: "GET",
        url: "/api/gigs/history",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ history: [], nextCursor: null });
    });

    it("should return 400 VALIDATION_ERROR for an invalid cursor", async () => {
      const { accessToken: token } = await registerApiUser();

      const res = await app.inject({
        method: "GET",
        url: "/api/gigs/history?cursor=not-a-date",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorBody).error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without an access token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/gigs/history" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/gigs/:id/accept", () => {
    it("should accept a gig, open it in the meet phase and deduct NIL", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigAcceptResponse;
      expect(body.activeGig.phase).toBe("meet");
      expect(body.activeGig.gigName).toBe("Corre da Farmácia");
      expect(body.nilRemaining).toBe(90);
    });

    it("should return 400 ALREADY_ACTIVE_GIG on a double accept", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();

      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorBody).error).toBe("ALREADY_ACTIVE_GIG");
    });

    it("should return 400 VALIDATION_ERROR for a non-uuid id", async () => {
      const { accessToken: token } = await registerApiUser();
      const res = await app.inject({
        method: "POST",
        url: "/api/gigs/not-a-uuid/accept",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorBody).error).toBe("VALIDATION_ERROR");
    });

    it("should return 404 GIG_NOT_FOUND for an unknown gig", async () => {
      const { accessToken: token } = await registerApiUser();
      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${ZERO_ID}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as ErrorBody).error).toBe("GIG_NOT_FOUND");
    });

    it("should return 401 without an access token", async () => {
      const farma = await farmaGig();
      const res = await app.inject({ method: "POST", url: `/api/gigs/${farma.id}/accept` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/gigs/:id/legwork", () => {
    it("should move the active gig into the legwork phase", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/legwork`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as ActiveGig;
      expect(body.phase).toBe("legwork");
      expect(body.legworkStartedAt).not.toBeNull();
    });

    it("should return 401 without an access token", async () => {
      const farma = await farmaGig();
      const res = await app.inject({ method: "POST", url: `/api/gigs/${farma.id}/legwork` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/gigs/:id/execute", () => {
    it("should roll the outcome straight from the meet phase (skip legwork)", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/execute`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigExecuteResponse;
      expect(body.activeGig.phase).toBe("execute");
      expect(body.activeGig.legworkCompleted).toBe(false);
      expect(typeof body.outcome.success).toBe("boolean");
      expect(body.activeGig.actualPayout).toBe(body.outcome.success ? 550 : 0);
    });

    it("should return 404 NO_ACTIVE_GIG when there is no active gig", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/execute`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect((res.json() as ErrorBody).error).toBe("NO_ACTIVE_GIG");
    });

    it("should return 401 without an access token", async () => {
      const farma = await farmaGig();
      const res = await app.inject({ method: "POST", url: `/api/gigs/${farma.id}/execute` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/gigs/:id/escape", () => {
    it("should roll the escape outcome and report the generated heat", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/legwork`,
        headers: { authorization: `Bearer ${token}` },
      });
      const exec = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/execute`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/escape`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigEscapeResponse;
      expect(body.activeGig.phase).toBe("escape");
      expect(["success", "failure"]).toContain(body.activeGig.escapeOutcome);
      const execOutcome = (exec.json() as GigExecuteResponse).outcome;
      expect(body.heatGenerated).toBe(execOutcome.success ? 5 : 10);
    });

    it("should return 409 INVALID_PHASE_TRANSITION before executing", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/escape`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(409);
      expect((res.json() as ErrorBody).error).toBe("INVALID_PHASE_TRANSITION");
    });
  });

  describe("POST /api/gigs/:id/wrapup", () => {
    it("should complete the 5-phase loop: wrap up after escaping pays out and closes the gig", async () => {
      const { accessToken: token, characterId } = await registerApiUser();
      const farma = await farmaGig(); // reward 500, heat 5, legwork 5 min
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/legwork`,
        headers: { authorization: `Bearer ${token}` },
      });
      // Backdate the legwork start so the 5-minute timer has elapsed (payout
      // then includes the +20% legwork bonus on top of the +10% success).
      await db
        .update(activeGigs)
        .set({ legworkStartedAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(activeGigs.characterId, characterId));
      const exec = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/execute`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(exec.statusCode).toBe(200);
      const execOutcome = (exec.json() as GigExecuteResponse).outcome;
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/escape`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/wrapup`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as GigWrapupResponse;
      expect(body.outcome).toBe(execOutcome.success ? "success" : "failure");
      expect(body.payout).toBe(execOutcome.success ? 660 : 0); // 500 × 1.2 × 1.1
      expect(body.heatAccumulated).toBe(execOutcome.success ? 5 : 10);
      expect(body.newBalance).toBe(execOutcome.success ? 1160 : 500);
    });

    it("should return 409 INVALID_PHASE_TRANSITION before the escape phase", async () => {
      const { accessToken: token } = await registerApiUser();
      const farma = await farmaGig();
      await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/accept`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/gigs/${farma.id}/wrapup`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(409);
      expect((res.json() as ErrorBody).error).toBe("INVALID_PHASE_TRANSITION");
    });

    it("should return 401 without an access token", async () => {
      const farma = await farmaGig();
      const res = await app.inject({ method: "POST", url: `/api/gigs/${farma.id}/wrapup` });
      expect(res.statusCode).toBe(401);
    });
  });
});
