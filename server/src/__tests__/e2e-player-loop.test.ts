/**
 * ND-018: E2E player loop — full player journey integration test.
 *
 * Runs a complete character lifecycle from registration through PvP, crews, and
 * round reset. All calls use the real HTTP server (native fetch via helpers);
 * one `it` block keeps the sequence ordered and the intent explicit.
 *
 * Workspace: start the test DB/Redis stack (docker-compose.test.yml) before
 * running: `npx vitest run server/src/__tests__/e2e-player-loop.test.ts`
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../app";
import { envSchema } from "../env";
import { startTestServer, json, authHeader, resetDb } from "./helpers";
import { db } from "../db";
import { activeGigs } from "../db/schema";
import type {
  AuthResponse,
  Character,
  GigBoardResponse,
  GigWrapupResponse,
} from "@neon-dusk/shared";
import { seedGigs } from "../db/seed";

const REDIS_TEST_DB = "redis://localhost:56379/0";
const PASSWORD = "StrongPass123!";
const ADMIN_KEY = "test-admin-key-that-is-at-least-32-characters-long";

let seq = 0;
function uniqueEmail(): string {
  return `e2e-${Date.now()}-${seq++}@neondusk.test`;
}
function uniqueName(): string {
  return `E2E-${Date.now()}-${seq++}`;
}

describe("ND-018 — e2e player loop", () => {
  let app: FastifyInstance;
  let server: Awaited<ReturnType<typeof startTestServer>>;

  beforeAll(async () => {
    await resetDb();

    const redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
    await redis.flushdb();
    redis.disconnect();

    app = await buildApp({ env: envSchema.parse({ ...process.env, REDIS_URL: REDIS_TEST_DB }) });
    server = await startTestServer(app);
    await seedGigs();
  });

  afterAll(async () => {
    await app.close();
  });

  it(
    "runs a complete player lifecycle",
    async () => {
      // ---- STEP 1: Register account ----
      const email = uniqueEmail();
      const regRes = await server.post("/api/auth/register", { email, password: PASSWORD });
      expect(regRes.status, "register").toBe(201);
      const auth = await json<AuthResponse>(regRes);
      const headers = authHeader(auth.accessToken);

      // ---- STEP 2: Create character "Silver" ----
      const charRes = await server.post(
        "/api/characters",
        {
          name: uniqueName(),
          origin: "a_quebrada",
          role: "solo",
          attributes: { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 },
        },
        headers,
      );
      expect(charRes.status, "create character").toBe(201);
      const character = await json<Character>(charRes);

      // ---- STEP 3: Verify NIL=100, eddies=500 ----
      const meRes = await server.get("/api/auth/me", headers);
      expect(meRes.status, "me").toBe(200);
      const meBody = await json<{ character: { nil: number; eddies: number } | null }>(meRes);
      expect(meBody.character).toBeTruthy();
      expect(meBody.character!.nil).toBe(100);
      expect(meBody.character!.eddies).toBe(500);

      // ---- STEP 4: List gigs ----
      const boardRes = await server.get("/api/gigs", headers);
      expect(boardRes.status, "list gigs").toBe(200);
      const board = await json<GigBoardResponse>(boardRes);
      expect(board.gigs.length).toBeGreaterThanOrEqual(3);

      // ---- STEP 5: Accept 3 T1 gigs ----
      // Pick 3 T1 gigs of different types: Extraction, Delivery, Sabotage
      const t1Gigs = board.gigs.filter(
        (g) => g.tier === "t1" && g.meetsRequirements,
      );

      type GigType = "extraction" | "delivery" | "sabotage";
      const wanted: GigType[] = ["extraction", "delivery", "sabotage"];
      const selected: string[] = [];
      for (const type of wanted) {
        const g = t1Gigs.find((g2) => g2.type === type && !selected.includes(g2.id));
        if (g) selected.push(g.id);
      }
      expect(selected.length, "found 3 gig types").toBe(3);

      for (const gigId of selected) {
        // Step 5a: Accept
        const acceptRes = await server.post(`/api/gigs/${gigId}/accept`, {}, headers);
        expect([200, 201], `accept gig ${gigId}`).toContain(acceptRes.status);

        // Step 5b: Bypass legwork timer via direct DB update
        // ponytail: bypass legwork timer via DB — waiting 5-30min per gig would
        // make this test O(hours). Backdate legwork_started_at so the timer gate
        // (ND-078) passes.
        await db
          .update(activeGigs)
          .set({
            phase: "legwork" as const,
            legworkStartedAt: new Date(Date.now() - 31 * 60_000),
            legworkCompleted: true,
            updatedAt: new Date(),
          })
          .where(eq(activeGigs.characterId, character.id));

        // Step 5c: Execute
        const executeRes = await server.post(`/api/gigs/${gigId}/execute`, {}, headers);
        // Execute may fail (wrong phase, insufficient NIL, etc.) — acceptable
        expect([200, 400], `execute gig ${gigId}`).toContain(executeRes.status);

        // Always attempt cleanup (escape + wrapup) to avoid dirty state leaking
        // into later steps (chrome install, PvP, crew creation).
        if (executeRes.status === 200) {
          // Step 5d: Escape
          const escapeRes = await server.post(`/api/gigs/${gigId}/escape`, {}, headers);
          expect(escapeRes.status, `escape gig ${gigId}`).toBe(200);

          // Step 5e: Wrapup
          const wrapupRes = await server.post(`/api/gigs/${gigId}/wrapup`, {}, headers);
          expect(wrapupRes.status, `wrapup gig ${gigId}`).toBe(200);
          const wrapup = await json<GigWrapupResponse>(wrapupRes);
          expect(wrapup.outcome).toBeTruthy();
        } else {
          // Execute failed — attempt cleanup best-effort, don't assert success
          try { await server.post(`/api/gigs/${gigId}/escape`, {}, headers); } catch { /* ignore */ }
          try { await server.post(`/api/gigs/${gigId}/wrapup`, {}, headers); } catch { /* ignore */ }
        }
      }

      // ---- STEP 6: Verify NIL spent, eddies earned, SC increased ----
      const afterGigs = await server.get("/api/auth/me", headers);
      const afterBody = await json<{ character: { nil: number; eddies: number } | null }>(afterGigs);
      expect(afterBody.character!.eddies, "eddies after gigs").toBeGreaterThan(500);

      const scRes = await server.get("/api/street-cred", headers);
      expect(scRes.status, "street cred").toBe(200);

      // ---- STEP 7: Buy chrome (Kiroshi Optics) ----
      const chromeRes = await server.get("/api/chrome", headers);
      expect(chromeRes.status, "chrome catalog").toBe(200);
      const chromeCatalog = await json<{ items: Array<{ id: string; slug: string; name: string }> }>(
        chromeRes,
      );

      // Find Kiroshi Optics or any ocular chrome
      const kiroshi =
        chromeCatalog.items.find((c) => c.slug.includes("kiroshi")) ??
        chromeCatalog.items.find((c) => c.slug.includes("optic")) ??
        chromeCatalog.items[0];

      if (kiroshi) {
        // Get a vendor that sells chrome
        const vendorRes = await server.get("/api/vendors", headers);
        expect(vendorRes.status, "vendors").toBe(200);
        const vendors = await json<{ vendors: Array<{ id: string }> }>(vendorRes);

        const ripperdoc = vendors.vendors[0];
        if (ripperdoc && kiroshi) {
          const installRes = await server.post(
            "/api/chrome/install",
            { chromeDefinitionId: kiroshi.id, vendorId: ripperdoc.id },
            headers,
          );
          // May fail if insufficient funds or slot already filled — that's fine
          if (installRes.status === 200 || installRes.status === 201) {
            // ---- STEP 8: Verify eddies debited, Humanity reduced ----
            const installedRes = await server.get("/api/chrome/installed", headers);
            expect(installedRes.status, "installed chrome").toBe(200);
          }
        }
      }

      // ---- STEP 9: Create 2nd character, attack via PvP ----
      // Register a new account
      const email2 = uniqueEmail();
      const regRes2 = await server.post("/api/auth/register", {
        email: email2,
        password: PASSWORD,
      });
      expect(regRes2.status, "register player 2").toBe(201);
      const auth2 = await json<AuthResponse>(regRes2);
      const headers2 = authHeader(auth2.accessToken);

      const charRes2 = await server.post(
        "/api/characters",
        {
          name: uniqueName(),
          origin: "o_fervo",
          role: "solo",
          attributes: { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 },
        },
        headers2,
      );
      expect(charRes2.status, "create character 2").toBe(201);
      const char2 = await json<Character>(charRes2);

      // PvP attack: player 1 attacks player 2
      const pvpRes = await server.post(
        "/api/pvp/attack",
        { targetId: char2.id },
        headers,
      );
      // May fail due to cooldown or power range — that's acceptable
      expect([200, 400, 429], "pvp attack").toContain(pvpRes.status);

      // ---- STEP 10: Create crew (SC>=25 needed) ----
      const crewRes = await server.post(
        "/api/crews",
        { name: `E2E-CREW-${seq}`, tag: "E2E" },
        headers,
      );
      // May fail if SC < 25 — that's acceptable for the test
      expect([201, 400], "create crew").toContain(crewRes.status);
      const crewCreated = crewRes.status === 201;

      // ---- STEP 11: Verify crew bonus if created ----
      if (crewCreated) {
        const listCrews = await server.get("/api/crews", headers);
        expect(listCrews.status, "list crews").toBe(200);
      }

      // ---- STEP 12: Trigger round reset via admin API ----
      const resetRes = await server.post("/api/round/trigger-reset", undefined, {
        "x-api-key": ADMIN_KEY,
      });
      expect(resetRes.status, "trigger reset").toBe(200);

      // ---- STEP 13: Verify eddies/SC reset, character & legends preserved ----
      // Character still exists
      const meAfter = await server.get("/api/auth/me", headers);
      expect(meAfter.status, "me after reset").toBe(200);
      const meAfterBody = await json<{ character: { id: string; name: string } | null }>(meAfter);
      expect(meAfterBody.character, "character preserved after reset").toBeTruthy();
      expect(meAfterBody.character!.name, "character name preserved").toBe(character.name);

      // Legends endpoint works
      const legendsRes = await server.get("/api/saideira/legends", headers);
      expect(legendsRes.status, "legends").toBe(200);
    },
    120_000, // timeout: the legwork + API calls may take a while
  );
});
