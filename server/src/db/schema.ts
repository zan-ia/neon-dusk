import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { desc, sql } from "drizzle-orm";
import { GAME_EVENT_TYPES, type ChromeBonuses } from "@neon-dusk/shared";

// Neon Dusk — Database Schema
// ============================================================================
// Feature #1: users + characters (account & character creation).
// Feature #2: NIL columns on characters (energy + passive regen).
// Drizzle tracks applied migrations automatically via the
// `__drizzle_migrations` table. No manual tracking table needed.

// --- Enums -------------------------------------------------------------------

export const roleEnum = pgEnum("role", ["solo", "netrunner", "tech", "fixer", "nomad"]);

export const originEnum = pgEnum("origin", [
  "a_paraiso",
  "o_fervo",
  "o_fluxo",
  "a_quebrada",
  "babilonia",
  "as_mortas",
  "o_ponto",
]);

// Feature #3 (ND-010): Economy. Transaction types record every wallet movement;
// vendor types classify the NPC vendors that sell gear and consumables.
export const transactionTypeEnum = pgEnum("transaction_type", [
  "GIG_PAYOUT",
  "VENDOR_PURCHASE",
  "PVP_REWARD",
  "PVP_LOSS",
  "STIM_PURCHASE",
  "CREW_BONUS",
  "ADMIN_ADJUSTMENT",
  "CHROME_PURCHASE",
  "CHROME_UNINSTALL",
  "STREET_CRED_AWARD",
  "CREW_CREATION",
]);

export const vendorTypeEnum = pgEnum("vendor_type", [
  "RIPPERDOC",
  "STIM_DEALER",
  "FIXER",
  "BLACK_MARKET",
]);

// Feature #7 (ND-007): Telemetry. Every player action worth auditing lands in
// `game_events` as a typed event; the enum values mirror the shared
// GAME_EVENT_TYPES constant so the DB and the app agree.
export const gameEventTypeEnum = pgEnum("game_event_type", [...GAME_EVENT_TYPES]);

// Feature #4 (ND-011): Gigs. The `gig_phase` enum mirrors the phase machine in
// game/gigs.ts — the terminal phase is `wrap_up`, never `wrapup`.
export const gigTypeEnum = pgEnum("gig_type", ["extraction", "delivery", "sabotage"]);
export const gigTierEnum = pgEnum("gig_tier", ["t1", "t2"]);
export const gigPhaseEnum = pgEnum("gig_phase", [
  "meet",
  "legwork",
  "execute",
  "escape",
  "wrap_up",
]);
export const gigOutcomeEnum = pgEnum("gig_outcome", ["success", "failure"]);
export const historyOutcomeEnum = pgEnum("history_outcome", ["success", "failure", "abandoned"]);

// Feature #4: Chrome (cyberware). Implants fill body slots, grant stat bonuses
// and drain humanity (0-100). Slot capacities follow 04-sistemas-e-progressao.md.
export const chromeSlotEnum = pgEnum("chrome_slot", [
  "frontal_cortex",
  "ocular",
  "arms",
  "skeleton",
  "nervous_system",
  "integumentary",
]);

// --- Tables ------------------------------------------------------------------

export const health = pgTable("health", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
  healthy: boolean("healthy").notNull().default(true),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Case-insensitive unique email (functional index on lower(email)).
    uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
  ],
);

export const characters = pgTable(
  "characters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    origin: originEnum("origin").notNull(),
    role: roleEnum("role").notNull(),
    body: integer("body").notNull().default(3),
    reflexes: integer("reflexes").notNull().default(3),
    intelligence: integer("intelligence").notNull().default(3),
    technical: integer("technical").notNull().default(3),
    cool: integer("cool").notNull().default(3),
    // Street Cred (ND-011): reputation earned by completing gigs (0-100).
    // Gates gig tiers (T2 needs 5+) and future fixers (04-sistemas-e-progressao §5).
    streetCred: integer("street_cred").notNull().default(0),
    // Street Cred decay (ND-011.2): `maxStreetCredAchieved` is the lifetime
    // max and decay floor (never falls below the highest threshold reached);
    // `lastActivityAt` is the decay clock — every gig wrap-up resets the grace.
    maxStreetCredAchieved: integer("max_street_cred_achieved").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    // NIL (Feature #2): neural load — regens +1 every 5 min. `nil_updated_at`
    // is the last persisted snapshot; regen is applied lazily on read.
    nil: integer("nil").notNull().default(100),
    maxNil: integer("max_nil").notNull().default(100),
    nilUpdatedAt: timestamp("nil_updated_at").notNull().defaultNow(),
    // Chrome (Feature #4): humanity drains with every implant. 0 = flatline.
    humanity: integer("humanity").notNull().default(100),
    // Crew (ND-016): affiliation — set when a character joins a crew, null
    // when solo. The partial unique index below guarantees one crew per char.
    // FK omitted on purpose: `characters` and `crews` reference each other,
    // which TS cannot infer (TS7022). The FK lives in migration 0010 and is
    // enforced by Postgres (ON DELETE SET NULL).
    crewId: uuid("crew_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Case-insensitive unique name (functional index on lower(name)).
    uniqueIndex("characters_name_lower_idx").on(sql`lower(${table.name})`),
    // Attributes: each 1..20, total must be exactly 22 (3 base × 5 + 7 free).
    check("characters_body_range", sql`${table.body} between 1 and 20`),
    check("characters_reflexes_range", sql`${table.reflexes} between 1 and 20`),
    check("characters_intelligence_range", sql`${table.intelligence} between 1 and 20`),
    check("characters_technical_range", sql`${table.technical} between 1 and 20`),
    check("characters_cool_range", sql`${table.cool} between 1 and 20`),
    check(
      "characters_attrs_total",
      sql`${table.body} + ${table.reflexes} + ${table.intelligence} + ${table.technical} + ${table.cool} = 22`,
    ),
    // NIL integrity: never negative, never above max, max always positive.
    check("characters_nil_range", sql`${table.nil} >= 0 and ${table.nil} <= ${table.maxNil}`),
    check("characters_max_nil_positive", sql`${table.maxNil} > 0`),
    // Humanity: 0-100. Reaching 0 is handled by the cyberpsychosis system.
    check("characters_humanity_range", sql`${table.humanity} >= 0 and ${table.humanity} <= 100`),
    // Street Cred: 0-100 reputation ceiling (04-sistemas-e-progressao.md §5).
    check(
      "characters_street_cred_range",
      sql`${table.streetCred} >= 0 AND ${table.streetCred} <= 100`,
    ),
    check(
      "characters_max_street_cred_range",
      sql`${table.maxStreetCredAchieved} >= 0 AND ${table.maxStreetCredAchieved} <= 100`,
    ),
    // Leaderboard reads: top-100 by reputation (ND-011.2).
    index("idx_characters_street_cred_desc").on(desc(table.streetCred)),
    // Crew membership (ND-016): `characters.crew_id` mirrors crew_members so
    // reads (chat tag, leaderboard affiliation) skip the join. It is NOT
    // unique — every member of a crew shares the value; the one-crew-per-
    // character rule lives in crew_members.character_id UNIQUE.
    index("idx_characters_crew_id")
      .on(table.crewId)
      .where(sql`${table.crewId} IS NOT NULL`),
  ],
);

// --- Economy (Feature #3 / ND-010) ------------------------------------------
// Character wallets hold eddies; every movement is audited in transaction_log
// and guarded by DB CHECK constraints as the last line of defense. `version`
// enables optimistic locking — writes compare-and-swap on it.

export const characterWallets = pgTable(
  "character_wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .unique()
      .references(() => characters.id, { onDelete: "cascade" }),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    escrow: bigint("escrow", { mode: "number" }).notNull().default(0),
    lifetimeEarned: bigint("lifetime_earned", { mode: "number" }).notNull().default(0),
    lifetimeSpent: bigint("lifetime_spent", { mode: "number" }).notNull().default(0),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("character_wallets_balance_non_negative", sql`${table.balance} >= 0`),
    check("character_wallets_escrow_non_negative", sql`${table.escrow} >= 0`),
    check("character_wallets_escrow_lte_balance", sql`${table.escrow} <= ${table.balance}`),
    check("character_wallets_lifetime_earned_non_negative", sql`${table.lifetimeEarned} >= 0`),
    check("character_wallets_lifetime_spent_non_negative", sql`${table.lifetimeSpent} >= 0`),
  ],
);

// Append-only audit trail. The CHECK constraint guarantees every row is an
// internally consistent balance delta (after - before = amount).
export const transactionLog = pgTable(
  "transaction_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    type: transactionTypeEnum("type").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceBefore: bigint("balance_before", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "transaction_log_balance_check",
      sql`${table.balanceAfter} - ${table.balanceBefore} = ${table.amount}`,
    ),
    // History queries: per-character page scans + per-type filtering.
    index("idx_transaction_log_character_id").on(table.characterId, desc(table.createdAt)),
    index("idx_transaction_log_type").on(table.type),
  ],
);

export const vendors = pgTable("vendors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  type: vendorTypeEnum("type").notNull(),
  district: text("district").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const vendorInventory = pgTable(
  "vendor_inventory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    price: bigint("price", { mode: "number" }).notNull(),
    stock: integer("stock").notNull().default(-1), // -1 = unlimited
  },
  (table) => [
    uniqueIndex("vendor_inventory_unique_item").on(table.vendorId, table.itemType, table.itemId),
    check("vendor_inventory_price_positive", sql`${table.price} > 0`),
  ],
);

export const lootTables = pgTable(
  "loot_tables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gigTier: text("gig_tier").notNull(),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    weight: real("weight").notNull(),
    minQuantity: integer("min_quantity").notNull().default(1),
    maxQuantity: integer("max_quantity").notNull().default(1),
  },
  (table) => [
    check("loot_tables_weight_positive", sql`${table.weight} > 0`),
    check(
      "loot_tables_quantity_range",
      sql`${table.minQuantity} >= 1 AND ${table.maxQuantity} >= ${table.minQuantity}`,
    ),
  ],
);

// --- Telemetry (Feature #7 / ND-007) -----------------------------------------
// Append-only event log written by the telemetry onResponse hook. `actor_id`
// is intentionally FK-less: it may reference a user or a character depending
// on the event, and telemetry rows must never block entity deletion.

export const gameEvents = pgTable(
  "game_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: gameEventTypeEnum("event_type").notNull(),
    actorId: uuid("actor_id"), // FK-less — never blocks deletion
    payload: jsonb("payload")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Admin metrics aggregate by type over time windows — a composite index
    // serves both the WHERE (time) and GROUP BY (type) clauses.
    index("idx_game_events_type_created_at").on(table.eventType, desc(table.createdAt)),
  ],
);

// --- Chrome (Feature #4) -----------------------------------------------------
// Static implant catalog + per-character loadouts. Slugs are stable identifiers
// used by vendor inventory (item_type='CHROME', item_id=slug) and loot tables.

export const chromeDefinitions = pgTable(
  "chrome_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    slot: chromeSlotEnum("slot").notNull(),
    tier: integer("tier").notNull(),
    bonuses: jsonb("bonuses").$type<ChromeBonuses>().notNull().default({}),
    humanityCost: integer("humanity_cost").notNull(),
    basePrice: bigint("base_price", { mode: "number" }).notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("chrome_definitions_tier_range", sql`${table.tier} between 1 and 5`),
    check("chrome_definitions_humanity_cost_positive", sql`${table.humanityCost} > 0`),
    check("chrome_definitions_base_price_positive", sql`${table.basePrice} > 0`),
  ],
);

export const installedChrome = pgTable(
  "installed_chrome",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    chromeDefinitionId: uuid("chrome_definition_id")
      .notNull()
      .references(() => chromeDefinitions.id, { onDelete: "restrict" }),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
  },
  (table) => [
    // One implant per definition per character (duplicate installs rejected).
    uniqueIndex("installed_chrome_character_definition_unique").on(
      table.characterId,
      table.chromeDefinitionId,
    ),
    // Loadout reads always filter by character.
    index("idx_installed_chrome_character_id").on(table.characterId),
  ],
);

// --- Gigs (Feature #4 / ND-011) ---------------------------------------------
// Static gig catalog (seeded from content/gig-templates.ts), one active gig per
// character, an append-only history and per-district heat accumulation.

export const gigs = pgTable(
  "gigs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    tier: gigTierEnum("tier").notNull(),
    type: gigTypeEnum("type").notNull(),
    district: text("district").notNull(),
    difficulty: integer("difficulty").notNull(),
    escapeDifficulty: integer("escape_difficulty").notNull().default(40),
    requiredStats: jsonb("required_stats").notNull().$type<Record<string, number>>(),
    requiredStreetCred: integer("required_street_cred").notNull().default(0),
    baseReward: integer("base_reward").notNull(),
    nilCost: integer("nil_cost").notNull(),
    heatGenerated: integer("heat_generated").notNull().default(5),
    legworkMinutes: integer("legwork_minutes").notNull(),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("gigs_difficulty_range", sql`${table.difficulty} BETWEEN 1 AND 100`),
    check("gigs_escape_difficulty_range", sql`${table.escapeDifficulty} BETWEEN 1 AND 100`),
    check("gigs_base_reward_positive", sql`${table.baseReward} > 0`),
    check("gigs_nil_cost_positive", sql`${table.nilCost} > 0`),
    check("gigs_heat_positive", sql`${table.heatGenerated} >= 0`),
    check("gigs_legwork_minutes_range", sql`${table.legworkMinutes} BETWEEN 5 AND 30`),
    check("gigs_sc_non_negative", sql`${table.requiredStreetCred} >= 0`),
    index("idx_gigs_tier").on(table.tier),
    index("idx_gigs_type").on(table.type),
    index("idx_gigs_district").on(table.district),
  ],
);

export const activeGigs = pgTable(
  "active_gigs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .unique()
      .references(() => characters.id, { onDelete: "cascade" }),
    gigId: uuid("gig_id")
      .notNull()
      .references(() => gigs.id, { onDelete: "restrict" }),
    phase: gigPhaseEnum("phase").notNull().default("meet"),
    status: text("status").notNull().default("active"),
    acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
    legworkStartedAt: timestamp("legwork_started_at"),
    legworkCompleted: boolean("legwork_completed").notNull().default(false),
    executeOutcome: gigOutcomeEnum("execute_outcome"),
    escapeOutcome: gigOutcomeEnum("escape_outcome"),
    actualPayout: integer("actual_payout"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_active_gigs_character").on(table.characterId)],
);

export const gigHistory = pgTable(
  "gig_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    gigId: uuid("gig_id")
      .notNull()
      .references(() => gigs.id, { onDelete: "restrict" }),
    outcome: historyOutcomeEnum("outcome").notNull(),
    phasesCompleted: text("phases_completed").array().notNull(),
    payout: integer("payout").notNull().default(0),
    streetCredGained: integer("street_cred_gained").notNull().default(0),
    heatAccumulated: integer("heat_accumulated").notNull().default(0),
    district: text("district").notNull(),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_gig_history_character").on(table.characterId, desc(table.completedAt)),
    index("idx_gig_history_completed_at").on(table.completedAt),
  ],
);

export const heat = pgTable(
  "heat",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    district: text("district").notNull(),
    amount: integer("amount").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("heat_character_district").on(table.characterId, table.district),
    check("heat_amount_non_negative", sql`${table.amount} >= 0`),
    index("idx_heat_character").on(table.characterId),
  ],
);

// --- PvP Combat (Feature ND-014) ---------------------------------------------
// Append-only combat log. winner_id is intentionally FK-less (derived from
// attacker/defender); loot_amount is the eddies stolen from the loser.

export const pvpCombats = pgTable(
  "pvp_combats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attackerId: uuid("attacker_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    defenderId: uuid("defender_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    attackerPower: integer("attacker_power").notNull(),
    defenderPower: integer("defender_power").notNull(),
    winnerId: uuid("winner_id").notNull(),
    lootAmount: integer("loot_amount").notNull().default(0),
    grieferPenalty: boolean("griefer_penalty").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("pvp_combats_loot_amount_non_negative", sql`${table.lootAmount} >= 0`),
    index("idx_pvp_combats_attacker").on(table.attackerId, desc(table.createdAt)),
    index("idx_pvp_combats_defender").on(table.defenderId, desc(table.createdAt)),
    index("idx_pvp_combats_attacker_defender").on(
      table.attackerId,
      table.defenderId,
      desc(table.createdAt),
    ),
  ],
);

// --- Legends (ND-015: Saideira Hub) ------------------------------------------
// Permanent Hall of Fame — characters who reached SC 100 in any round.
// No FK to characters: records survive round resets (immutable achievements).

export const legends = pgTable("legends", {
  id: uuid("id").defaultRandom().primaryKey(),
  characterName: text("character_name").notNull(),
  drinkName: text("drink_name").notNull(),
  achievedAt: timestamp("achieved_at", { withTimezone: true }).defaultNow().notNull(),
  crewName: text("crew_name"), // nullable until ND-016 (crews)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Crews (ND-016: Crews Básicas) -------------------------------------------
// Gang social system: a leader founds a crew (5,000 eddies, SC >= 25) and
// recruits up to 3 members. `crew_members.character_id` UNIQUE guarantees a
// character is in at most one crew; the DB trigger `trg_crew_member_limit`
// (migration 0010) enforces the 4-member cap as the last line of defense.

export const crews = pgTable(
  "crews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    tag: text("tag").notNull().unique(),
    leaderId: uuid("leader_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("crews_name_length", sql`char_length(${table.name}) BETWEEN 3 AND 20`),
    check("crews_tag_format", sql`${table.tag} ~ '^[A-Z0-9]{3}$'`),
  ],
);

export const crewMembers = pgTable(
  "crew_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .unique()
      .references(() => characters.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Membership reads always filter by crew.
    index("idx_crew_members_crew_id").on(table.crewId),
  ],
);

export const crewInvites = pgTable(
  "crew_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // One pending invite per (crew, character) — re-invites replace expired ones.
    uniqueIndex("crew_invites_crew_character_unique").on(table.crewId, table.characterId),
    index("idx_crew_invites_character_id").on(table.characterId),
    index("idx_crew_invites_crew_id").on(table.crewId),
  ],
);

// --- Rounds (ND-017) ---------------------------------------------------------
// 14-day rounds with a full server-side reset. `rounds` tracks the lifecycle
// (one active round at a time, sequential numbering); `round_stats` stores a
// snapshot captured at reset time BEFORE the wipe. The partial unique index
// guarantees at most one active round — the DB-level invariant the reset
// relies on.

export const roundStatusEnum = pgEnum("round_status", ["active", "ended"]);

export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roundNumber: integer("round_number").notNull().unique(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: roundStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // "Which round is active?" lookups (both cron and GET /api/round).
    index("idx_rounds_status").on(table.status),
    // At most one active round at any time.
    uniqueIndex("idx_rounds_active")
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const roundStats = pgTable(
  "round_stats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id, { onDelete: "cascade" }),
    totalGigsCompleted: integer("total_gigs_completed").notNull().default(0),
    totalEddiesEarned: bigint("total_eddies_earned", { mode: "number" }).notNull().default(0),
    totalPvpFights: integer("total_pvp_fights").notNull().default(0),
    totalActiveCharacters: integer("total_active_characters").notNull().default(0),
    // Snapshot of the top crew / top character — FK-less on purpose: crews are
    // deleted on reset and characters persist, so ids are informational only.
    topCrewId: uuid("top_crew_id"),
    topCrewName: text("top_crew_name"),
    topScCharacterId: uuid("top_sc_character_id"),
    topScCharacterName: text("top_sc_character_name"),
    topScValue: integer("top_sc_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // History reads always join rounds → round_stats by round_id.
    index("idx_round_stats_round_id").on(table.roundId),
  ],
);
