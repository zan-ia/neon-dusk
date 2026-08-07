import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { envSchema } from "../env";
import { startTestServer, json, authHeader, resetDb } from "./helpers";
import { db } from "../db";
import {
  characters,
  chromeDefinitions,
  installedChrome,
  transactionLog,
  vendorInventory,
  vendors,
} from "../db/schema";
import type {
  AuthResponse,
  ChromeDefinition,
  ChromeInstallResponse,
  ChromeUninstallResponse,
  CreateCharacterRequest,
  InstalledChromeResponse,
} from "@neon-dusk/shared";

// Feature #4 — chrome API integration tests. Real HTTP against the app
// (Fastify + Postgres + Redis on the isolated test stack). Dedicated redis db
// (6) so rate-limit counters never leak across files.
//
// resetDb() truncates `vendors CASCADE`, which wipes the migration-seeded
// ripperdoc "Doc Fios", so beforeAll re-seeds it (same fixed id) plus its
// inventory of the 5 starter implants. The chrome_definitions seed rows
// survive (not truncated).

const REDIS_TEST_DB = "redis://localhost:56379/6";

// Fixed id from migration 0004 (Doc Fios, Babilônia).
const DOC_FIOS_ID = "00000000-0000-4000-8000-000000000001";
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

// Vendor prices are test fixtures sized so the 500-eddie seed wallet can
// afford the starter implants (real market prices live in content/*). stock
// -1 = unlimited.
const INVENTORY: { itemId: string; price: number }[] = [
  { itemId: "neural-booster", price: 300 },
  { itemId: "reflex-tuner", price: 300 },
  { itemId: "kiroshi-optics", price: 400 },
  { itemId: "gorilla-arms", price: 2500 },
  { itemId: "subdermal-armor", price: 2000 },
];

const PASSWORD = "StrongPass123!";

let seq = 0;
function uniqueEmail(): string {
  return `chrome-${Date.now()}-${seq++}@neondusk.test`;
}
function uniqueName(): string {
  return `Solo-${Date.now()}-${seq++}`;
}

function validAttributes(): CreateCharacterRequest["attributes"] {
  return { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 };
}

interface ErrorBody {
  error: string;
  message: string;
  details?: { path: (string | number)[]; message: string }[];
}

describe("Feature #4 — chrome API", () => {
  let app: FastifyInstance;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    await resetDb();

    const redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
    await redis.flushdb();
    redis.disconnect();

    app = await buildApp({ env: envSchema.parse({ ...process.env, REDIS_URL: REDIS_TEST_DB }) });
    server = await startTestServer(app);

    // Re-seed Doc Fios (wiped by resetDb) with its fixed id + chrome inventory.
    await db.insert(vendors).values({
      id: DOC_FIOS_ID,
      name: "Doc Fios",
      type: "RIPPERDOC",
      district: "babilonia",
      description: "Ripperdoc veterano da Babilônia.",
      isActive: true,
    });
    await db.insert(vendorInventory).values(
      INVENTORY.map(({ itemId, price }) => ({
        vendorId: DOC_FIOS_ID,
        itemType: "CHROME",
        itemId,
        price,
        stock: -1,
      })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Register a fresh user + character via HTTP; returns token + character id. */
  async function registerAndCreateCharacter(): Promise<{ accessToken: string; characterId: string }> {
    const res = await server.post("/api/auth/register", { email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(201);
    const { accessToken, user } = await json<AuthResponse>(res);

    const created = await fetch(`${base()}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(accessToken) },
      body: JSON.stringify({
        name: uniqueName(),
        origin: "a_paraiso",
        role: "solo",
        attributes: validAttributes(),
      }),
    });
    expect(created.status).toBe(201);

    const [character] = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.userId, user.id))
      .limit(1);
    return { accessToken, characterId: character!.id };
  }

  /** DB id of a seeded chrome definition, by slug. */
  async function defId(slug: string): Promise<string> {
    const [row] = await db
      .select({ id: chromeDefinitions.id })
      .from(chromeDefinitions)
      .where(eq(chromeDefinitions.slug, slug))
      .limit(1);
    return row!.id;
  }

  /** A ripperdoc that stocks no chrome at all. */
  async function seedEmptyRipperdoc(): Promise<string> {
    const [vendor] = await db
      .insert(vendors)
      .values({
        name: `Ripper-${Date.now()}-${seq++}`,
        type: "RIPPERDOC",
        district: "o_fluxo",
        isActive: true,
      })
      .returning();
    return vendor.id;
  }

  async function installChrome(
    accessToken: string,
    chromeDefinitionId: string,
    vendorId = DOC_FIOS_ID,
  ): Promise<Response> {
    return server.post(
      "/api/chrome/install",
      { chromeDefinitionId, vendorId },
      authHeader(accessToken),
    );
  }

  describe("GET /api/chrome", () => {
    it("should return all 5 active chrome definitions", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/chrome`, { headers: authHeader(accessToken) });

      expect(res.status).toBe(200);
      const body = await json<ChromeDefinition[]>(res);
      expect(body).toHaveLength(5);
      expect(body.map((d) => d.slug).sort()).toEqual([
        "gorilla-arms",
        "kiroshi-optics",
        "neural-booster",
        "reflex-tuner",
        "subdermal-armor",
      ]);
      // Ordered by tier (T1 first) then name.
      expect(body[0].tier).toBe(1);
      expect(body[4].tier).toBe(2);
      expect(body[0]).not.toHaveProperty("isActive"); // internals stripped
    });

    it("should filter by tier=1", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/chrome?tier=1`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<ChromeDefinition[]>(res);
      expect(body).toHaveLength(3);
      expect(body.every((d) => d.tier === 1)).toBe(true);
    });

    it("should filter by slot=arms", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/chrome?slot=arms`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<ChromeDefinition[]>(res);
      expect(body).toHaveLength(1);
      expect(body[0].slug).toBe("gorilla-arms");
    });

    it("should filter by tier=2 AND slot=integumentary", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/chrome?tier=2&slot=integumentary`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<ChromeDefinition[]>(res);
      expect(body).toHaveLength(1);
      expect(body[0].slug).toBe("subdermal-armor");
    });

    it("should return 401 without an access token", async () => {
      const res = await server.get("/api/chrome");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/chrome/installed", () => {
    it("should return an empty loadout for a fresh character", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/chrome/installed`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<InstalledChromeResponse>(res);
      expect(body).toEqual({
        installed: [],
        effectiveHumanity: 100,
        humanitySpent: 0,
        statBonus: { body: 0, reflexes: 0, intelligence: 0, technical: 0, cool: 0 },
        hpBonus: 0,
        gigSuccessBonus: 0,
      });
    });

    it("should return the installed loadout with computed bonuses after an install", async () => {
      const { accessToken } = await registerAndCreateCharacter();
      await installChrome(accessToken, await defId("neural-booster"));

      const res = await fetch(`${base()}/api/chrome/installed`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<InstalledChromeResponse>(res);
      expect(body.installed).toHaveLength(1);
      expect(body.installed[0].definition.slug).toBe("neural-booster");
      expect(body.installed[0].installedAt).toBeTruthy();
      expect(body.statBonus).toEqual({
        body: 0,
        reflexes: 0,
        intelligence: 2, // neural-booster grants +2 INT (content/chrome-definitions.ts)
        technical: 0,
        cool: 0,
      });
      expect(body.effectiveHumanity).toBe(97);
      expect(body.humanitySpent).toBe(3);
      expect(body.hpBonus).toBe(0);
      expect(body.gigSuccessBonus).toBe(0);
    });

    it("should return 401 without an access token", async () => {
      const res = await server.get("/api/chrome/installed");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/chrome/install", () => {
    it("should install chrome, deduct eddies and reduce humanity", async () => {
      const { accessToken } = await registerAndCreateCharacter();
      const neural = await defId("neural-booster");

      const res = await installChrome(accessToken, neural);

      expect(res.status).toBe(201);
      const body = await json<ChromeInstallResponse>(res);
      expect(body.installedChrome.definition.slug).toBe("neural-booster");
      expect(body.installedChrome.installedId).toBeTruthy();
      expect(body.effectiveHumanity).toBe(97); // 100 - 3
      expect(body.walletBalance).toBe(200); // 500 - 300
    });

    it("should reject a second install of the same chrome with 409", async () => {
      const { accessToken } = await registerAndCreateCharacter();
      const neural = await defId("neural-booster");
      await installChrome(accessToken, neural);

      const res = await installChrome(accessToken, neural);

      expect(res.status).toBe(409);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("ALREADY_INSTALLED");
    });

    it("should return 404 for an unknown chrome definition", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await installChrome(accessToken, ZERO_ID);

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("CHROME_NOT_FOUND");
    });

    it("should return 404 for an unknown vendor", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await installChrome(accessToken, await defId("neural-booster"), ZERO_ID);

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("ITEM_NOT_FOUND");
    });

    it("should return 404 when the vendor does not stock the chrome", async () => {
      const { accessToken } = await registerAndCreateCharacter();
      const vendorId = await seedEmptyRipperdoc();

      const res = await installChrome(accessToken, await defId("neural-booster"), vendorId);

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("ITEM_NOT_FOUND");
    });

    it("should return 400 INSUFFICIENT_FUNDS when the wallet cannot cover the price", async () => {
      const { accessToken } = await registerAndCreateCharacter();
      // Gorilla Arms = 2500 eddies > 500 seed balance.
      const res = await installChrome(accessToken, await defId("gorilla-arms"));

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("INSUFFICIENT_FUNDS");
    });

    it("should return 400 HUMANITY_TOO_LOW when humanity would drop below 0", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();
      // Reflex Tuner costs 3 humanity and 300 eddies. At 2 humanity it would go to -1.
      await db
        .update(characters)
        .set({ humanity: 2 })
        .where(eq(characters.id, characterId));

      const res = await installChrome(accessToken, await defId("reflex-tuner"));

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("HUMANITY_TOO_LOW");
    });

    it("should allow an install that brings humanity to exactly 0 (flatline boundary)", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();
      // Reflex Tuner costs 3 humanity; at 3 humanity the result is exactly 0,
      // which the game contract allows (cyberpsychosis handles flatline).
      await db
        .update(characters)
        .set({ humanity: 3 })
        .where(eq(characters.id, characterId));

      const res = await installChrome(accessToken, await defId("reflex-tuner"));

      expect(res.status).toBe(201);
      const body = await json<ChromeInstallResponse>(res);
      expect(body.effectiveHumanity).toBe(0);
    });

    it("should return 400 for a missing body", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await server.post("/api/chrome/install", {}, authHeader(accessToken));

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for non-uuid ids", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await installChrome(accessToken, "not-a-uuid", DOC_FIOS_ID);

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without an access token", async () => {
      const res = await server.post("/api/chrome/install", {
        chromeDefinitionId: ZERO_ID,
        vendorId: DOC_FIOS_ID,
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/chrome/uninstall", () => {
    it("should uninstall chrome: free the slot, no refund, no humanity recovery", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();
      const install = await json<ChromeInstallResponse>(
        await installChrome(accessToken, await defId("neural-booster")),
      );

      const res = await server.post(
        "/api/chrome/uninstall",
        { installedChromeId: install.installedChrome.installedId },
        authHeader(accessToken),
      );

      expect(res.status).toBe(200);
      const body = await json<ChromeUninstallResponse>(res);
      expect(body.freedSlot).toBe("frontal_cortex");
      expect(body.effectiveHumanity).toBe(97); // no recovery

      // Slot freed — loadout is empty again.
      const loadout = await db
        .select()
        .from(installedChrome)
        .where(eq(installedChrome.characterId, characterId));
      expect(loadout).toHaveLength(0);

      // No refund — wallet stays at 200 (the balance after the 300-eddie purchase).
      const balance = await fetch(`${base()}/api/economy/balance`, {
        headers: authHeader(accessToken),
      });
      expect((await json<{ balance: number }>(balance)).balance).toBe(200);

      // Audit entry with amount 0.
      const [log] = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "CHROME_UNINSTALL"),
          ),
        );
      expect(log).toMatchObject({
        amount: 0,
        balanceBefore: 200,
        balanceAfter: 200,
      });
    });

    it("should return 404 when the installed chrome belongs to another character", async () => {
      const { accessToken: ownerToken } = await registerAndCreateCharacter();
      const install = await json<ChromeInstallResponse>(
        await installChrome(ownerToken, await defId("neural-booster")),
      );
      const { accessToken: otherToken } = await registerAndCreateCharacter();

      const res = await server.post(
        "/api/chrome/uninstall",
        { installedChromeId: install.installedChrome.installedId },
        authHeader(otherToken),
      );

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("INSTALLED_CHROME_NOT_FOUND");
    });

    it("should return 404 for a non-existent installed chrome id", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await server.post(
        "/api/chrome/uninstall",
        { installedChromeId: ZERO_ID },
        authHeader(accessToken),
      );

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("INSTALLED_CHROME_NOT_FOUND");
    });

    it("should return 400 for a non-uuid installed chrome id", async () => {
      const { accessToken } = await registerAndCreateCharacter();

      const res = await server.post(
        "/api/chrome/uninstall",
        { installedChromeId: "not-a-uuid" },
        authHeader(accessToken),
      );

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without an access token", async () => {
      const res = await server.post("/api/chrome/uninstall", { installedChromeId: ZERO_ID });
      expect(res.status).toBe(401);
    });
  });

  describe("wallet integrity", () => {
    it("should record balance_before and balance_after on the CHROME_PURCHASE entry", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();

      await installChrome(accessToken, await defId("neural-booster"));

      const [log] = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "CHROME_PURCHASE"),
          ),
        );
      expect(log).toMatchObject({
        amount: -300,
        balanceBefore: 500,
        balanceAfter: 200,
      });
    });

    it("should roll back atomically — a failed install leaves no wallet or humanity trace", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();
      const neural = await defId("neural-booster");
      // Simulate the race where the loadout row already exists (concurrent
      // install committed between the loadout read and the insert).
      await db.insert(installedChrome).values({
        characterId,
        chromeDefinitionId: neural,
      });

      const res = await installChrome(accessToken, neural);

      expect(res.status).toBe(409);
      // Nothing persisted: no purchase entry, humanity untouched, wallet untouched.
      const purchases = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "CHROME_PURCHASE"),
          ),
        );
      expect(purchases).toHaveLength(0);

      const [character] = await db
        .select({ humanity: characters.humanity })
        .from(characters)
        .where(eq(characters.id, characterId));
      expect(character!.humanity).toBe(100);

      const balance = await fetch(`${base()}/api/economy/balance`, {
        headers: authHeader(accessToken),
      });
      expect((await json<{ balance: number }>(balance)).balance).toBe(500);
    });

    it("should let exactly one of two concurrent installs win, with a single debit", async () => {
      const { accessToken, characterId } = await registerAndCreateCharacter();
      const neural = await defId("neural-booster");

      const [a, b] = await Promise.all([
        installChrome(accessToken, neural),
        installChrome(accessToken, neural),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Exactly one installed row and one debit.
      const loadout = await db
        .select()
        .from(installedChrome)
        .where(eq(installedChrome.characterId, characterId));
      expect(loadout).toHaveLength(1);

      const purchases = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "CHROME_PURCHASE"),
          ),
        );
      expect(purchases).toHaveLength(1);
      expect(purchases[0].amount).toBe(-300);

      const [character] = await db
        .select({ humanity: characters.humanity })
        .from(characters)
        .where(eq(characters.id, characterId));
      expect(character!.humanity).toBe(97); // 100 - 3, applied exactly once
    });
  });
});
