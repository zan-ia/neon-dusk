import { and, eq, gte } from "drizzle-orm";
import type {
  ChromeBonuses,
  ChromeDefinition,
  ChromeInstallResponse,
  ChromeSlot,
  ChromeUninstallResponse,
  InstalledChromeRecord,
  InstalledChromeResponse,
} from "@neon-dusk/shared";
import { SLOT_CAPACITY, NIL_MAX_BASE } from "@neon-dusk/shared";
import { db } from "../db";
import {
  characterWallets,
  characters,
  chromeDefinitions,
  installedChrome,
  transactionLog,
  vendorInventory,
} from "../db/schema";
import { AppError } from "../middleware/error-handler";
import {
  calculateGigSuccessBonus,
  calculateHpBonus,
  calculateHumanityCost,
  calculateNilMaxBonus,
  calculateStatBonus,
  validateHumanityAfterInstall,
  validateSlotAvailability,
} from "../game/chrome";
import { transferEddies } from "../game/economy";
import { ensureWallet } from "./economy-service";

// Neon Dusk — Chrome service (install / uninstall / loadout / catalog)
// ============================================================================
// Install is a single PostgreSQL transaction: vendor stock check → wallet
// debit (optimistic lock, same pattern as buyFromVendor) → audit entry →
// implant insert → atomic humanity decrement. The UPDATE's WHERE guard
// (`humanity >= cost`) re-validates the cost against the row's current
// humanity at write time, so concurrent installs that both read the same
// value can never overwrite each other's deduction.

/** DB row → API shape (strips isActive/createdAt internals). */
function toPublicDefinition(row: typeof chromeDefinitions.$inferSelect): ChromeDefinition {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    slot: row.slot,
    tier: row.tier,
    bonuses: row.bonuses,
    humanityCost: row.humanityCost,
    basePrice: row.basePrice,
    description: row.description,
  };
}

/** Detect Postgres unique violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

/**
 * Install chrome bought from a ripperdoc. Validates the implant, the vendor
 * stock, the slot capacity and the humanity cost, then atomically debits the
 * wallet and records the implant + audit entry. Returns the new loadout entry,
 * the effective humanity and the post-purchase wallet balance.
 */
export async function installChrome(
  characterId: string,
  chromeDefinitionId: string,
  vendorId: string,
): Promise<ChromeInstallResponse> {
  // 1. Chrome definition must exist and be active
  const [definition] = await db
    .select()
    .from(chromeDefinitions)
    .where(
      and(
        eq(chromeDefinitions.id, chromeDefinitionId),
        eq(chromeDefinitions.isActive, true),
      ),
    )
    .limit(1);
  if (!definition) throw new AppError(404, "CHROME_NOT_FOUND", "Chrome não encontrado");

  // 2. Vendor must stock this chrome (item_type='CHROME', item_id=slug)
  const [stockItem] = await db
    .select()
    .from(vendorInventory)
    .where(
      and(
        eq(vendorInventory.vendorId, vendorId),
        eq(vendorInventory.itemType, "CHROME"),
        eq(vendorInventory.itemId, definition.slug),
      ),
    )
    .limit(1);
  if (!stockItem) {
    throw new AppError(404, "ITEM_NOT_FOUND", "Este ripperdoc não tem esse chrome em estoque");
  }

  return db.transaction(async (tx) => {
    // 3. Character — humanity read fresh inside the tx (it guards the write)
    const [character] = await tx
      .select({ humanity: characters.humanity })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!character) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");

    // 4. Current loadout — duplicate check + per-slot count
    const loadout = await tx
      .select({
        definitionId: installedChrome.chromeDefinitionId,
        slot: chromeDefinitions.slot,
      })
      .from(installedChrome)
      .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
      .where(eq(installedChrome.characterId, characterId));

    if (loadout.some((row) => row.definitionId === chromeDefinitionId)) {
      throw new AppError(409, "ALREADY_INSTALLED", "Chrome já instalado");
    }

    // 5. Slot capacity (one definition per install, so counts never double)
    const installedInSlot = loadout.filter((row) => row.slot === definition.slot).length;
    if (!validateSlotAvailability(definition.slot, installedInSlot)) {
      throw new AppError(
        400,
        "SLOT_FULL",
        `No free ${definition.slot} slot (${installedInSlot}/${SLOT_CAPACITY[definition.slot]})`,
      );
    }

    // 6. Humanity cost
    if (!validateHumanityAfterInstall(character.humanity, definition.humanityCost)) {
      throw new AppError(400, "HUMANITY_TOO_LOW", "Humanidade insuficiente para instalar este chrome");
    }

    // 7. Wallet debit with optimistic locking (pattern of buyFromVendor)
    const wallet = await ensureWallet(characterId, tx);
    const price = stockItem.price; // vendor price is authoritative
    const availableFunds = wallet.balance - wallet.escrow;
    if (availableFunds < price) {
      throw new AppError(400, "INSUFFICIENT_FUNDS", `Precisa de ${price} eddies, tem ${availableFunds}`);
    }

    const result = transferEddies(wallet, -price, {
      type: "CHROME_PURCHASE",
      source: `Purchased ${definition.name} (${definition.slug}) from vendor ${vendorId}`,
      referenceType: "chrome_definition",
      referenceId: definition.id,
    });

    const [updated] = await tx
      .update(characterWallets)
      .set({
        balance: result.wallet.balance,
        escrow: result.wallet.escrow,
        lifetimeSpent: result.wallet.lifetimeSpent,
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
    if (!updated) {
      throw new AppError(409, "CONCURRENCY_CONFLICT", "Modificação concorrente detectada. Tente novamente.");
    }

    // Audit entry
    await tx.insert(transactionLog).values({
      characterId,
      type: "CHROME_PURCHASE",
      amount: -price,
      balanceBefore: result.transaction.balanceBefore,
      balanceAfter: result.transaction.balanceAfter,
      source: result.transaction.source,
      referenceType: "chrome_definition",
      referenceId: definition.id,
    });

    // Implant record — unique(character, definition) is the last line of
    // defense against concurrent duplicate installs.
    let installed: typeof installedChrome.$inferSelect;
    try {
      [installed] = await tx
        .insert(installedChrome)
        .values({ characterId, chromeDefinitionId: definition.id })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, "ALREADY_INSTALLED", "Chrome já instalado");
      }
      throw err;
    }

    // Atomic humanity decrement — the WHERE guard `gte(humanity, cost)`
    // re-validates at write time; a 0-row match silently no-ops (unreachable
    // under normal operation via the wallet optimistic lock, defense in depth).
    const effectiveHumanity = character.humanity - definition.humanityCost;
    await tx
      .update(characters)
      .set({ humanity: effectiveHumanity, updatedAt: new Date() })
      .where(
        and(
          eq(characters.id, characterId),
          gte(characters.humanity, definition.humanityCost),
        ),
      );

    // Recompute effective NIL max from all installed chrome (base 100 + nil_max bonuses).
    const installedDefs = await tx
      .select({ bonuses: chromeDefinitions.bonuses })
      .from(installedChrome)
      .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
      .where(eq(installedChrome.characterId, characterId));
    const nilMaxBonus = calculateNilMaxBonus(
      installedDefs.map((d) => ({ bonuses: d.bonuses as ChromeBonuses } as ChromeDefinition)),
    );
    await tx
      .update(characters)
      .set({ maxNil: NIL_MAX_BASE + nilMaxBonus, updatedAt: new Date() })
      .where(eq(characters.id, characterId));

    return {
      installedChrome: {
        installedId: installed.id,
        installedAt: installed.installedAt.toISOString(),
        definition: toPublicDefinition(definition),
      },
      effectiveHumanity,
      walletBalance: result.wallet.balance,
    };
  });
}

/**
 * Remove an installed implant. No eddie refund and no humanity recovery —
 * only an audit entry (amount 0, so the balance CHECK still holds). Returns
 * the freed slot and the unchanged effective humanity.
 */
export async function uninstallChrome(
  characterId: string,
  installedChromeId: string,
): Promise<ChromeUninstallResponse> {
  // Load the implant joined with its definition; scoping by characterId makes
  // a foreign id indistinguishable from a missing one (404 either way).
  const [row] = await db
    .select({
      id: installedChrome.id,
      name: chromeDefinitions.name,
      slot: chromeDefinitions.slot,
    })
    .from(installedChrome)
    .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
    .where(
      and(
        eq(installedChrome.id, installedChromeId),
        eq(installedChrome.characterId, characterId),
      ),
    )
    .limit(1);
  if (!row) throw new AppError(404, "INSTALLED_CHROME_NOT_FOUND", "Chrome instalado não encontrado");

  const [character] = await db
    .select({ humanity: characters.humanity })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!character) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");

  await db.transaction(async (tx) => {
    await tx.delete(installedChrome).where(eq(installedChrome.id, installedChromeId));

    // Recompute effective NIL max from remaining chrome.
    const remaining = await tx
      .select({ bonuses: chromeDefinitions.bonuses })
      .from(installedChrome)
      .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
      .where(eq(installedChrome.characterId, characterId));
    const nilMaxBonus = calculateNilMaxBonus(
      remaining.map((d) => ({ bonuses: d.bonuses as ChromeBonuses } as ChromeDefinition)),
    );
    await tx
      .update(characters)
      .set({ maxNil: NIL_MAX_BASE + nilMaxBonus, updatedAt: new Date() })
      .where(eq(characters.id, characterId));

    // Audit-only entry: no wallet movement, so balanceBefore = balanceAfter.
    const wallet = await ensureWallet(characterId, tx);
    await tx.insert(transactionLog).values({
      characterId,
      type: "CHROME_UNINSTALL",
      amount: 0,
      balanceBefore: wallet.balance,
      balanceAfter: wallet.balance,
      source: `Uninstalled ${row.name}`,
    });
  });

  return { freedSlot: row.slot, effectiveHumanity: character.humanity };
}

/**
 * List a character's installed chrome with the effective bonuses computed by
 * the game logic (stat deltas, HP, gig success) and the total humanity spent.
 */
export async function listInstalledChrome(characterId: string): Promise<InstalledChromeResponse> {
  const [character] = await db
    .select({ humanity: characters.humanity })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!character) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");

  const rows = await db
    .select({
      installedId: installedChrome.id,
      installedAt: installedChrome.installedAt,
      definition: chromeDefinitions,
    })
    .from(installedChrome)
    .innerJoin(chromeDefinitions, eq(installedChrome.chromeDefinitionId, chromeDefinitions.id))
    .where(eq(installedChrome.characterId, characterId))
    .orderBy(installedChrome.installedAt);

  const definitions = rows.map((row) => toPublicDefinition(row.definition));
  const installed: InstalledChromeRecord[] = rows.map((row) => ({
    installedId: row.installedId,
    installedAt: row.installedAt.toISOString(),
    definition: toPublicDefinition(row.definition),
  }));

  return {
    installed,
    effectiveHumanity: character.humanity,
    humanitySpent: calculateHumanityCost(definitions),
    statBonus: calculateStatBonus(definitions),
    hpBonus: calculateHpBonus(definitions),
    gigSuccessBonus: calculateGigSuccessBonus(definitions),
    nilMaxBonus: calculateNilMaxBonus(definitions),
  };
}

/**
 * List the active chrome catalog, optionally filtered by tier and/or slot.
 */
export async function listChromeCatalog(filters?: {
  tier?: number;
  slot?: ChromeSlot;
}): Promise<ChromeDefinition[]> {
  const conditions = [eq(chromeDefinitions.isActive, true)];
  if (filters?.tier !== undefined) conditions.push(eq(chromeDefinitions.tier, filters.tier));
  if (filters?.slot !== undefined) conditions.push(eq(chromeDefinitions.slot, filters.slot));

  const rows = await db
    .select()
    .from(chromeDefinitions)
    .where(and(...conditions))
    .orderBy(chromeDefinitions.tier, chromeDefinitions.name);

  return rows.map(toPublicDefinition);
}
