// Neon Dusk — Loot Table Seeds (ND-054 Data Seeding)
// ============================================================================
// Weighted loot tables for gig completion rewards (rollLoot() in economy.ts).
// Weights are relative probabilities — drop rate is implied by total weight
// composition, not by explicit percentage configuration.
//
// UUIDs use namespace 00000000-0000-4000-8001-xxxxxxxxxxxx (distinct from
// vendor namespace) for idempotent re-runs.
//
// Balance: T1 ~30% drop rate, T2 ~50% implied by weight distribution.
// Min-max quantity always validated (min >= 1, max >= min).

export interface LootTableSeedEntry {
  id: string;
  gigTier: string; // 't1' | 't2'
  itemType: string; // 'EDDIES' | 'CONSUMABLE' | 'LOOT'
  itemId: string;
  weight: number; // > 0, relative probability
  minQuantity: number; // >= 1
  maxQuantity: number; // >= minQuantity
}

export const LOOT_TABLES: LootTableSeedEntry[] = [
  // ═══ T1 Loot (low-value, ~30% implied drop rate) ════════════════════════
  {
    id: "00000000-0000-4000-8001-000000000001",
    gigTier: "t1",
    itemType: "EDDIES",
    itemId: "eddies",
    weight: 40,
    minQuantity: 50,
    maxQuantity: 200,
  },
  {
    id: "00000000-0000-4000-8001-000000000002",
    gigTier: "t1",
    itemType: "CONSUMABLE",
    itemId: "syn-cafe",
    weight: 30,
    minQuantity: 1,
    maxQuantity: 1,
  },
  {
    id: "00000000-0000-4000-8001-000000000003",
    gigTier: "t1",
    itemType: "LOOT",
    itemId: "e-scrap",
    weight: 20,
    minQuantity: 1,
    maxQuantity: 3,
  },
  {
    id: "00000000-0000-4000-8001-000000000004",
    gigTier: "t1",
    itemType: "LOOT",
    itemId: "broken-chip",
    weight: 10,
    minQuantity: 1,
    maxQuantity: 1,
  },

  // ═══ T2 Loot (higher value, ~50% implied drop rate) ════════════════════
  {
    id: "00000000-0000-4000-8001-000000000005",
    gigTier: "t2",
    itemType: "EDDIES",
    itemId: "eddies",
    weight: 45,
    minQuantity: 200,
    maxQuantity: 800,
  },
  {
    id: "00000000-0000-4000-8001-000000000006",
    gigTier: "t2",
    itemType: "CONSUMABLE",
    itemId: "combat-stim",
    weight: 20,
    minQuantity: 1,
    maxQuantity: 2,
  },
  {
    id: "00000000-0000-4000-8001-000000000007",
    gigTier: "t2",
    itemType: "LOOT",
    itemId: "rare-component",
    weight: 20,
    minQuantity: 1,
    maxQuantity: 1,
  },
  {
    id: "00000000-0000-4000-8001-000000000008",
    gigTier: "t2",
    itemType: "LOOT",
    itemId: "chrome-fragment",
    weight: 10,
    minQuantity: 1,
    maxQuantity: 1,
  },
  {
    id: "00000000-0000-4000-8001-000000000009",
    gigTier: "t2",
    itemType: "LOOT",
    itemId: "access-chip",
    weight: 5,
    minQuantity: 1,
    maxQuantity: 1,
  },
];
