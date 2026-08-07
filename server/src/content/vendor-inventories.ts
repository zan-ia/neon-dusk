import type { VendorType } from "@neon-dusk/shared";

// Neon Dusk — Vendor Seed (ND-054 Data Seeding)
// ============================================================================
// 4 fixed NPC vendors with deterministic UUIDs for idempotent re-runs.
// stock -1 = unlimited supply.

export interface VendorInventorySeedEntry {
  itemType: string;
  itemId: string;
  price: number;
  stock: number; // -1 = unlimited
}

export interface VendorSeedEntry {
  id: string; // fixed UUID for idempotent re-runs
  name: string;
  type: VendorType;
  district: string;
  description: string;
  inventory: VendorInventorySeedEntry[];
}

export const VENDOR_SEED: VendorSeedEntry[] = [
  // ── Doc Fios (Ripperdoc, Babilônia) ─────────────────────────────────────
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Doc Fios",
    type: "RIPPERDOC",
    district: "babilonia",
    description:
      "Ripperdoc de confiança da Babilônia. Especialista em chrome de combate e reparos de emergência.",
    inventory: [
      { itemType: "CHROME", itemId: "neural-booster", price: 1500, stock: -1 },
      { itemType: "CHROME", itemId: "reflex-tuner", price: 1500, stock: -1 },
      { itemType: "CHROME", itemId: "kiroshi-optics", price: 1800, stock: -1 },
      { itemType: "CHROME", itemId: "gorilla-arms", price: 5000, stock: -1 },
      { itemType: "CHROME", itemId: "subdermal-armor", price: 4000, stock: -1 },
    ],
  },

  // ── Cupim (Fixer, Babilônia) ────────────────────────────────────────────
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Cupim",
    type: "FIXER",
    district: "babilonia",
    description:
      "Fixer veterano, conhece cada beco da Babilônia. Intermedeia gigs e informações.",
    inventory: [], // fixer doesn't sell items — gig board is separate
  },

  // ── Zé do Pó (Stim Dealer, O Fervo) ─────────────────────────────────────
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Zé do Pó",
    type: "STIM_DEALER",
    district: "o_fervo",
    description:
      "Traficante de stims no coração do Fervo. Preços baixos, qualidade duvidosa.",
    inventory: [
      { itemType: "CONSUMABLE", itemId: "syn-cafe", price: 50, stock: -1 },
    ],
  },

  // ── Madame K (Black Market, As Mortas) ──────────────────────────────────
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Madame K",
    type: "BLACK_MARKET",
    district: "as_mortas",
    description:
      "Comerciante do submundo. Se você precisa de algo que não existe, é com ela.",
    inventory: [
      { itemType: "CONSUMABLE", itemId: "combat-stim", price: 300, stock: -1 },
      { itemType: "LOOT", itemId: "access-chip", price: 5000, stock: 3 },
    ],
  },
];
