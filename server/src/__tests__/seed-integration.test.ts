import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "../db";
import { resetDb, resetRounds, insertTestCharacter } from "./helpers";
import { seedAll, seedGigs } from "../db/seed";
import { performRoundReset } from "../services/round-service";
import { ensureWallet } from "../services/economy-service";
import {
  activeGigs,
  characterWallets,
  chromeDefinitions,
  crews,
  crewMembers,
  gigHistory,
  gigs,
  heat,
  installedChrome,
  lootTables,
  rounds,
  transactionLog,
  vendorInventory,
  vendors,
} from "../db/schema";

// ND-054 — seed executor integration tests. Real Postgres on the isolated
// test stack (docker-compose.test.yml). These tests run the ACTUAL seed
// functions (seedAll/seedGigs from db/seed.ts) against a truncated catalog
// so counts are deterministic, then verify idempotency, content correctness,
// round-reset compatibility and wallet integrity.
//
// NOTE: the test DB must be migrated (db:migrate) before this suite — the
// chrome-integration suite already depends on seeded chrome_definitions rows
// for the same reason.

const CONTENT_COUNTS = {
  gigs: 10,
  chrome: 5,
  vendors: 4,
  inventory: 8,
  loot: 9,
} as const;

async function count(table: PgTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row!.n;
}

describe("ND-054 — seed executor (db/seed)", () => {
  beforeAll(async () => {
    // Wipe account + dependent tables (users, characters, vendors, loot_tables
    // CASCADE) and the two catalog tables resetDb deliberately leaves alone.
    await resetDb();
    await db.execute(sql`TRUNCATE TABLE gigs, chrome_definitions CASCADE`);
    await resetRounds(); // round 1 active for the round-reset compatibility test
    await seedAll();
  });

  describe("seed executor", () => {
    it("should populate every content table with the full catalog", async () => {
      expect(await count(gigs)).toBe(CONTENT_COUNTS.gigs);
      expect(await count(chromeDefinitions)).toBe(CONTENT_COUNTS.chrome);
      expect(await count(vendors)).toBe(CONTENT_COUNTS.vendors);
      expect(await count(vendorInventory)).toBe(CONTENT_COUNTS.inventory);
      expect(await count(lootTables)).toBe(CONTENT_COUNTS.loot);
    });

    it("should be idempotent — a second run changes nothing", async () => {
      const first = await seedAll();
      expect(first.gigs).toBe(0); // no-op re-run inserts 0 gigs
      expect(first).toMatchObject({
        chrome: 5,
        vendors: 4,
        inventory: 8,
        loot: 9,
      });

      expect(await count(gigs)).toBe(CONTENT_COUNTS.gigs);
      expect(await count(chromeDefinitions)).toBe(CONTENT_COUNTS.chrome);
      expect(await count(vendors)).toBe(CONTENT_COUNTS.vendors);
      expect(await count(vendorInventory)).toBe(CONTENT_COUNTS.inventory);
      expect(await count(lootTables)).toBe(CONTENT_COUNTS.loot);
    });

    it("should restore drifted content on re-run (upsert by slug)", async () => {
      // Simulate a manual price edit; the seed should push it back.
      await db
        .update(chromeDefinitions)
        .set({ basePrice: 9999 })
        .where(eq(chromeDefinitions.slug, "neural-booster"));

      await seedAll();

      const [def] = await db
        .select({ basePrice: chromeDefinitions.basePrice })
        .from(chromeDefinitions)
        .where(eq(chromeDefinitions.slug, "neural-booster"))
        .limit(1);
      expect(def!.basePrice).toBe(1500);
    });

    it("should store chrome definitions with the correct stats", async () => {
      const [booster] = await db
        .select()
        .from(chromeDefinitions)
        .where(eq(chromeDefinitions.slug, "neural-booster"))
        .limit(1);
      expect(booster).toMatchObject({
        slug: "neural-booster",
        name: "Neural Booster",
        slot: "frontal_cortex",
        tier: 1,
        humanityCost: 3,
        basePrice: 1500,
        isActive: true,
      });
      expect(booster.bonuses).toEqual({ intelligence: 2 });

      const [armor] = await db
        .select()
        .from(chromeDefinitions)
        .where(eq(chromeDefinitions.slug, "subdermal-armor"))
        .limit(1);
      expect(armor.bonuses).toEqual({ max_hp: 10 });
    });

    it("should seed 4 vendors with the expected inventory per vendor", async () => {
      const docFios = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, "00000000-0000-4000-8000-000000000001"))
        .limit(1);
      expect(docFios[0]).toMatchObject({
        name: "Doc Fios",
        type: "RIPPERDOC",
        district: "babilonia",
        isActive: true,
      });

      const rows = await db
        .select({
          vendorId: vendorInventory.vendorId,
          itemId: vendorInventory.itemId,
          price: vendorInventory.price,
          stock: vendorInventory.stock,
        })
        .from(vendorInventory)
        .orderBy(vendorInventory.vendorId);

      // 8 rows across the 4 fixed vendors: 5 ripperdoc, 0 fixer, 1 stim, 2 market.
      const perVendor = new Map<string, typeof rows>();
      for (const r of rows) {
        perVendor.set(r.vendorId, [...(perVendor.get(r.vendorId) ?? []), r]);
      }
      expect(perVendor.get("00000000-0000-4000-8000-000000000001")).toHaveLength(5);
      expect(perVendor.get("00000000-0000-4000-8000-000000000002") ?? []).toHaveLength(0);
      expect(perVendor.get("00000000-0000-4000-8000-000000000003")).toHaveLength(1);
      expect(perVendor.get("00000000-0000-4000-8000-000000000004")).toHaveLength(2);

      // Doc Fios stocks the 5 starter implants at the content prices.
      const docFiosItems = perVendor.get("00000000-0000-4000-8000-000000000001")!;
      expect(docFiosItems.map((i) => i.itemId).sort()).toEqual([
        "gorilla-arms",
        "kiroshi-optics",
        "neural-booster",
        "reflex-tuner",
        "subdermal-armor",
      ]);
      expect(docFiosItems.every((i) => i.stock === -1)).toBe(true);
      const [kiroshi] = docFiosItems.filter((i) => i.itemId === "kiroshi-optics");
      expect(kiroshi.price).toBe(1800);
    });

    it("should derive the gig cooldown from tier (T1=10, T2=25)", async () => {
      const t1 = await db.select({ cooldownMinutes: gigs.cooldownMinutes }).from(gigs).where(eq(gigs.tier, "t1"));
      const t2 = await db.select({ cooldownMinutes: gigs.cooldownMinutes }).from(gigs).where(eq(gigs.tier, "t2"));
      expect(t1).toHaveLength(6);
      expect(t2).toHaveLength(4);
      expect(t1.every((g) => g.cooldownMinutes === 10)).toBe(true);
      expect(t2.every((g) => g.cooldownMinutes === 25)).toBe(true);
    });

    it("should seed 9 loot tables (4 T1, 5 T2) with weights intact", async () => {
      const t1 = await db.select().from(lootTables).where(eq(lootTables.gigTier, "t1"));
      const t2 = await db.select().from(lootTables).where(eq(lootTables.gigTier, "t2"));
      expect(t1).toHaveLength(4);
      expect(t2).toHaveLength(5);
      const [eddies] = t1.filter((l) => l.itemType === "EDDIES");
      expect(eddies.weight).toBe(40);
      expect(eddies.minQuantity).toBe(50);
      expect(eddies.maxQuantity).toBe(200);
    });

    it("should not touch existing character data when the seed runs", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction(async (tx) => {
        await ensureWallet(characterId, tx);
      });

      await seedAll();

      const [wallet] = await db
        .select({ balance: characterWallets.balance })
        .from(characterWallets)
        .where(eq(characterWallets.characterId, characterId));
      expect(wallet!.balance).toBe(500); // seed capital untouched
      const logs = await db
        .select({ id: transactionLog.id })
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));
      expect(logs).toHaveLength(1); // only the ADMIN_ADJUSTMENT entry
    });
  });

  describe("seed + round reset compatibility", () => {
    it("should keep content tables populated and dynamic tables empty after a reset", async () => {
      const { characterId } = await insertTestCharacter();
      const [gig] = await db.select().from(gigs).limit(1);
      const [def] = await db.select().from(chromeDefinitions).limit(1);
      await db.transaction(async (tx) => {
        await ensureWallet(characterId, tx);
      });

      // Real player state the reset must wipe.
      await db.insert(activeGigs).values({
        characterId,
        gigId: gig.id,
        phase: "execute",
        status: "active",
      });
      await db.insert(gigHistory).values({
        characterId,
        gigId: gig.id,
        outcome: "success",
        phasesCompleted: ["meet", "legwork", "execute", "escape", "wrap_up"],
        payout: 500,
        streetCredGained: 2,
        heatAccumulated: 5,
        district: gig.district,
      });
      await db.insert(installedChrome).values({ characterId, chromeDefinitionId: def.id });
      await db.insert(heat).values({ characterId, district: "babilonia", amount: 10 });
      const [crew] = await db
        .insert(crews)
        .values({ name: `Banda-${Date.now()}`, tag: "BND", leaderId: characterId })
        .returning();
      await db.insert(crewMembers).values({ crewId: crew.id, characterId });

      const result = await performRoundReset();

      expect(result.endedRound).toBe(1);
      expect(result.newRound).toBe(2);

      // Content tables survive the reset untouched.
      expect(await count(gigs)).toBe(CONTENT_COUNTS.gigs);
      expect(await count(chromeDefinitions)).toBe(CONTENT_COUNTS.chrome);
      expect(await count(vendors)).toBe(CONTENT_COUNTS.vendors);
      expect(await count(vendorInventory)).toBe(CONTENT_COUNTS.inventory);
      expect(await count(lootTables)).toBe(CONTENT_COUNTS.loot);

      // Dynamic player tables are wiped.
      expect(await count(activeGigs)).toBe(0);
      expect(await count(gigHistory)).toBe(0);
      expect(await count(installedChrome)).toBe(0);
      expect(await count(heat)).toBe(0);
      expect(await count(transactionLog)).toBe(0);
      expect(await count(crews)).toBe(0);
      expect(await count(crewMembers)).toBe(0);

      // Wallets zeroed, next round opened.
      const [wallet] = await db
        .select({ balance: characterWallets.balance })
        .from(characterWallets)
        .where(eq(characterWallets.characterId, characterId));
      expect(wallet!.balance).toBe(0);
      const [active] = await db.select().from(rounds).where(eq(rounds.status, "active")).limit(1);
      expect(active!.roundNumber).toBe(2);
    });
  });

  describe("wallet initial balance", () => {
    it("should create a new wallet with INITIAL_BALANCE 500 and an audit entry", async () => {
      const { characterId } = await insertTestCharacter();

      const wallet = await db.transaction(async (tx) => ensureWallet(characterId, tx));

      expect(wallet).toMatchObject({ balance: 500, escrow: 0, lifetimeEarned: 500, lifetimeSpent: 0 });
      const [log] = await db
        .select()
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));
      expect(log).toMatchObject({
        type: "ADMIN_ADJUSTMENT",
        amount: 500,
        balanceBefore: 0,
        balanceAfter: 500,
        source: "Initial seed capital",
      });
    });

    it("should not reset an existing wallet when the seed runs", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction(async (tx) => ensureWallet(characterId, tx));
      await db
        .update(characterWallets)
        .set({ balance: 1234 })
        .where(eq(characterWallets.characterId, characterId));

      await seedAll();

      const [wallet] = await db
        .select({ balance: characterWallets.balance })
        .from(characterWallets)
        .where(eq(characterWallets.characterId, characterId));
      expect(wallet!.balance).toBe(1234);
      const logs = await db
        .select({ id: transactionLog.id })
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));
      expect(logs).toHaveLength(1);
    });
  });
});
