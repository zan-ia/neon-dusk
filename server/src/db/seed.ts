import { pathToFileURL } from "node:url";
import { db, client } from "./index";
import {
  chromeDefinitions,
  gigs,
  lootTables,
  vendorInventory,
  vendors,
} from "./schema";
import { CHROME_DEFINITIONS } from "../content/chrome-definitions";
import { VENDOR_SEED } from "../content/vendor-inventories";
import { GIG_TEMPLATES } from "../content/gig-templates";
import { LOOT_TABLES } from "../content/loot-tables";

// Neon Dusk — Content seed (ND-054)
// ============================================================================
// Runtime seeding of the static game catalog (chrome, vendors, gigs, loot).
// Fully idempotent: re-running is safe (upserts + conflict-do-nothing).
// Run with `npm run db:seed` after `db:migrate`. Mirrors db/migrate.ts:
// plain stdout logging and an explicit client.end() before process.exit.

/**
 * Insert the gig catalog from content/gig-templates.ts, deriving the
 * per-tier cooldown (T1 refreshes fast, T2 keeps you out of the same play).
 * Returns how many rows were actually inserted (0 on a no-op re-run).
 */
export async function seedGigs(): Promise<number> {
  let inserted = 0;
  for (const t of GIG_TEMPLATES) {
    const cooldownMinutes = t.tier === "t1" ? 10 : 25;
    const rows = await db
      .insert(gigs)
      .values({
        name: t.name,
        description: t.description,
        tier: t.tier,
        type: t.type,
        district: t.district,
        difficulty: t.difficulty,
        escapeDifficulty: t.escapeDifficulty,
        requiredStats: t.requiredStats,
        requiredStreetCred: t.requiredStreetCred,
        baseReward: t.baseReward,
        nilCost: t.nilCost,
        heatGenerated: t.heatGenerated,
        legworkMinutes: t.legworkMinutes,
        cooldownMinutes,
      })
      .onConflictDoNothing({ target: gigs.name })
      .returning({ id: gigs.id });
    inserted += rows.length;
  }
  return inserted;
}

/** Row counts per table from the last seed run (attempted, except gigs). */
export interface SeedResult {
  chrome: number;
  vendors: number;
  inventory: number;
  gigs: number;
  loot: number;
}

/**
 * Run the full content seed (chrome, vendors, inventory, gigs, loot) against
 * the connected database. Idempotent — safe to call repeatedly. Exported so
 * tests can exercise the real executor; `main()` is the CLI wrapper.
 */
export async function seedAll(): Promise<SeedResult> {
  // Chrome — upsert by slug.
  let chromeCount = 0;
  for (const c of CHROME_DEFINITIONS) {
    await db
      .insert(chromeDefinitions)
      .values({
        slug: c.slug,
        name: c.name,
        slot: c.slot,
        tier: c.tier,
        bonuses: c.bonuses,
        humanityCost: c.humanityCost,
        basePrice: c.basePrice,
        description: c.description,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: chromeDefinitions.slug,
        set: {
          name: c.name,
          slot: c.slot,
          tier: c.tier,
          bonuses: c.bonuses,
          humanityCost: c.humanityCost,
          basePrice: c.basePrice,
          description: c.description,
        },
      });
    chromeCount++;
  }

  // Vendors — fixed UUIDs, skip if already present (PK conflict).
  let vendorCount = 0;
  for (const v of VENDOR_SEED) {
    await db
      .insert(vendors)
      .values({
        id: v.id,
        name: v.name,
        type: v.type,
        district: v.district,
        description: v.description,
      })
      .onConflictDoNothing();
    vendorCount++;
  }

  // Vendor inventory — upsert by (vendor_id, item_type, item_id).
  let inventoryCount = 0;
  for (const v of VENDOR_SEED) {
    for (const inv of v.inventory) {
      await db
        .insert(vendorInventory)
        .values({
          vendorId: v.id,
          itemType: inv.itemType,
          itemId: inv.itemId,
          price: inv.price,
          stock: inv.stock,
        })
        .onConflictDoUpdate({
          target: [vendorInventory.vendorId, vendorInventory.itemType, vendorInventory.itemId],
          set: { price: inv.price, stock: inv.stock },
        });
      inventoryCount++;
    }
  }

  // Gigs — upsert by name; returns 0 on a no-op re-run.
  const gigCount = await seedGigs();

  // Loot tables — fixed UUIDs, skip if already present (PK conflict).
  let lootCount = 0;
  for (const l of LOOT_TABLES) {
    await db
      .insert(lootTables)
      .values({
        id: l.id,
        gigTier: l.gigTier,
        itemType: l.itemType,
        itemId: l.itemId,
        weight: l.weight,
        minQuantity: l.minQuantity,
        maxQuantity: l.maxQuantity,
      })
      .onConflictDoNothing({ target: lootTables.id });
    lootCount++;
  }

  return { chrome: chromeCount, vendors: vendorCount, inventory: inventoryCount, gigs: gigCount, loot: lootCount };
}

async function main(): Promise<void> {
  console.log("🌆 Seeding Neon Dusk content...");

  const result = await seedAll();

  console.log(
    `✅ Seed complete: ${result.chrome} chrome, ${result.vendors} vendors, ` +
      `${result.inventory} inventory, ${result.gigs} gigs, ${result.loot} loot rows`,
  );
  // BF-1: close the postgres client, not `db` (same as db/migrate.ts).
  await client.end();
  process.exit(0);
}

// Only run when executed directly (`tsx src/db/seed.ts`), so tests can import
// `seedGigs` without triggering the CLI exit path.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
}
