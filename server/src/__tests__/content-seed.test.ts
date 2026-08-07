import { describe, it, expect } from "vitest";
import { CHROME_SLOTS, VENDOR_TYPES, type ChromeBonuses } from "@neon-dusk/shared";
import { GIG_TEMPLATES } from "../content/gig-templates";
import { CHROME_DEFINITIONS } from "../content/chrome-definitions";
import { VENDOR_SEED } from "../content/vendor-inventories";
import { LOOT_TABLES } from "../content/loot-tables";

// ND-054 — content file integrity (pure unit tests, no DB).
// Every content file is the source of truth for the seeded catalog; these
// tests lock the shape, cardinality and balance anchors so a bad edit to a
// content file fails the suite instead of shipping a broken catalog.

const VALID_GIG_TIERS = ["t1", "t2"] as const;
const VALID_GIG_TYPES = ["extraction", "delivery", "sabotage"] as const;
const VALID_ORIGINS = [
  "a_paraiso",
  "o_fervo",
  "o_fluxo",
  "a_quebrada",
  "babilonia",
  "as_mortas",
  "o_ponto",
] as const;
const VALID_STAT_KEYS = [
  "body",
  "reflexes",
  "intelligence",
  "technical",
  "cool",
  "max_hp",
  "gig_success_rate",
] as const;
const VALID_VENDOR_ITEM_TYPES = ["CHROME", "CONSUMABLE", "LOOT"] as const;
const VALID_LOOT_ITEM_TYPES = ["EDDIES", "CONSUMABLE", "LOOT"] as const;

/** Fixed v4 UUID with variant 8/b/9/a — the seed namespace pattern. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── GIG_TEMPLATES ─────────────────────────────────────────────────────────

describe("GIG_TEMPLATES (content/gig-templates.ts)", () => {
  it("should contain 10 entries (6 T1, 4 T2)", () => {
    expect(GIG_TEMPLATES).toHaveLength(10);
    expect(GIG_TEMPLATES.filter((g) => g.tier === "t1")).toHaveLength(6);
    expect(GIG_TEMPLATES.filter((g) => g.tier === "t2")).toHaveLength(4);
  });

  it("should spread across the 3 gig types", () => {
    const byType = (t: string) => GIG_TEMPLATES.filter((g) => g.type === t).length;
    expect(byType("extraction")).toBe(4);
    expect(byType("delivery")).toBe(3);
    expect(byType("sabotage")).toBe(3);
  });

  it("should give every entry a name, description and required fields", () => {
    for (const g of GIG_TEMPLATES) {
      expect(g.name.trim().length).toBeGreaterThan(0);
      expect(g.description.trim().length).toBeGreaterThan(0);
      expect(VALID_GIG_TIERS).toContain(g.tier);
      expect(VALID_GIG_TYPES).toContain(g.type);
      expect(g.district.trim().length).toBeGreaterThan(0);
    }
  });

  it("should keep difficulty and escape difficulty within 1-100", () => {
    for (const g of GIG_TEMPLATES) {
      expect(g.difficulty).toBeGreaterThanOrEqual(1);
      expect(g.difficulty).toBeLessThanOrEqual(100);
      expect(g.escapeDifficulty).toBeGreaterThanOrEqual(1);
      expect(g.escapeDifficulty).toBeLessThanOrEqual(100);
    }
  });

  it("should keep economy fields sane: positive reward/NIL, non-negative heat, 5-30 min legwork, SC >= 0", () => {
    for (const g of GIG_TEMPLATES) {
      expect(g.baseReward).toBeGreaterThan(0);
      expect(g.nilCost).toBeGreaterThan(0);
      expect(g.heatGenerated).toBeGreaterThanOrEqual(0);
      expect(g.legworkMinutes).toBeGreaterThanOrEqual(5);
      expect(g.legworkMinutes).toBeLessThanOrEqual(30);
      expect(g.requiredStreetCred).toBeGreaterThanOrEqual(0);
    }
  });

  it("should pay T1 gigs 500-2000 and T2 gigs 2000-8000", () => {
    for (const g of GIG_TEMPLATES) {
      if (g.tier === "t1") {
        expect(g.baseReward).toBeGreaterThanOrEqual(500);
        expect(g.baseReward).toBeLessThanOrEqual(2000);
      } else {
        expect(g.baseReward).toBeGreaterThanOrEqual(2000);
        expect(g.baseReward).toBeLessThanOrEqual(8000);
      }
    }
  });

  it("should require street cred 0 on T1 and 5+ on T2", () => {
    for (const g of GIG_TEMPLATES) {
      if (g.tier === "t1") {
        expect(g.requiredStreetCred).toBe(0);
      } else {
        expect(g.requiredStreetCred).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("should use valid stat names with positive values in requiredStats", () => {
    for (const g of GIG_TEMPLATES) {
      expect(Object.keys(g.requiredStats).length).toBeGreaterThan(0);
      for (const [stat, value] of Object.entries(g.requiredStats)) {
        expect(VALID_STAT_KEYS.slice(0, 5)).toContain(stat); // core attrs only
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it("should not repeat gig names (name is the upsert key)", () => {
    const names = GIG_TEMPLATES.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ─── CHROME_DEFINITIONS ────────────────────────────────────────────────────

describe("CHROME_DEFINITIONS (content/chrome-definitions.ts)", () => {
  it("should contain 5 entries", () => {
    expect(CHROME_DEFINITIONS).toHaveLength(5);
  });

  it("should give every entry a kebab-case unique slug (the stable id)", () => {
    const slugs = CHROME_DEFINITIONS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(KEBAB_RE);
    }
  });

  it("should use a valid chrome slot", () => {
    for (const c of CHROME_DEFINITIONS) {
      expect(CHROME_SLOTS).toContain(c.slot);
    }
  });

  it("should keep tier at 1-2 and costs positive", () => {
    for (const c of CHROME_DEFINITIONS) {
      expect([1, 2]).toContain(c.tier);
      expect(c.humanityCost).toBeGreaterThan(0);
      expect(c.basePrice).toBeGreaterThan(0);
      expect(c.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("should only grant valid stat bonuses with positive deltas", () => {
    for (const c of CHROME_DEFINITIONS) {
      for (const [stat, value] of Object.entries(c.bonuses)) {
        expect(VALID_STAT_KEYS).toContain(stat);
        expect(value).toBeGreaterThan(0);
      }
    }
  });
});

// ─── VENDOR_SEED ───────────────────────────────────────────────────────────

describe("VENDOR_SEED (content/vendor-inventories.ts)", () => {
  it("should contain 4 vendors", () => {
    expect(VENDOR_SEED).toHaveLength(4);
  });

  it("should give every vendor a valid type, district and fixed v4 UUID", () => {
    const ids = VENDOR_SEED.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VENDOR_SEED) {
      expect(VENDOR_TYPES).toContain(v.type);
      expect(VALID_ORIGINS).toContain(v.district);
      expect(v.id).toMatch(UUID_V4_RE);
      expect(v.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("should keep inventory prices positive and stock unlimited (-1) or positive", () => {
    for (const v of VENDOR_SEED) {
      for (const item of v.inventory) {
        expect(item.price).toBeGreaterThan(0);
        expect(item.stock === -1 || item.stock >= 1).toBe(true);
        expect(VALID_VENDOR_ITEM_TYPES).toContain(item.itemType);
        expect(item.itemId.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("should not repeat an item inside the same vendor's inventory", () => {
    for (const v of VENDOR_SEED) {
      const keys = v.inventory.map((i) => `${i.itemType}:${i.itemId}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("should reference only existing chrome slugs in CHROME inventory items", () => {
    const chromeSlugs = new Set(CHROME_DEFINITIONS.map((c) => c.slug));
    for (const v of VENDOR_SEED) {
      for (const item of v.inventory) {
        if (item.itemType === "CHROME") {
          expect(chromeSlugs.has(item.itemId)).toBe(true);
        }
      }
    }
  });

  it("should carry 8 inventory rows total (5 ripperdoc, 0 fixer, 1 stim, 2 black market)", () => {
    const counts = VENDOR_SEED.map((v) => v.inventory.length);
    expect(counts).toEqual([5, 0, 1, 2]);
  });
});

// ─── LOOT_TABLES ───────────────────────────────────────────────────────────

describe("LOOT_TABLES (content/loot-tables.ts)", () => {
  it("should contain 9 entries (4 T1, 5 T2)", () => {
    expect(LOOT_TABLES).toHaveLength(9);
    expect(LOOT_TABLES.filter((l) => l.gigTier === "t1")).toHaveLength(4);
    expect(LOOT_TABLES.filter((l) => l.gigTier === "t2")).toHaveLength(5);
  });

  it("should give every entry a fixed v4 UUID and keep them unique", () => {
    const ids = LOOT_TABLES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
  });

  it("should keep tier, item type and weights valid", () => {
    for (const l of LOOT_TABLES) {
      expect(["t1", "t2"]).toContain(l.gigTier);
      expect(VALID_LOOT_ITEM_TYPES).toContain(l.itemType);
      expect(l.weight).toBeGreaterThan(0);
      expect(l.itemId.trim().length).toBeGreaterThan(0);
    }
  });

  it("should keep min quantity >= 1 and max >= min", () => {
    for (const l of LOOT_TABLES) {
      expect(l.minQuantity).toBeGreaterThanOrEqual(1);
      expect(l.maxQuantity).toBeGreaterThanOrEqual(l.minQuantity);
    }
  });
});

// ─── Cross-file: chrome slugs referenced by content ────────────────────────

describe("content cross-file integrity", () => {
  it("should only reference known chrome slugs anywhere in the catalog", () => {
    const chromeSlugs = new Set(CHROME_DEFINITIONS.map((c) => c.slug));
    for (const v of VENDOR_SEED) {
      for (const item of v.inventory) {
        if (item.itemType === "CHROME") {
          expect(chromeSlugs.has(item.itemId)).toBe(true);
        }
      }
    }
  });
});
