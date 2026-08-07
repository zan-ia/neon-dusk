import { and, desc, eq, lt } from "drizzle-orm";
import type { TransactionRecord, TransactionType, VendorRecord } from "@neon-dusk/shared";
import { db, type Tx } from "../db";
import {
  characterWallets,
  characters,
  transactionLog,
  vendorInventory,
  vendors,
} from "../db/schema";
import { AppError } from "../middleware/error-handler";
import { calculatePrice, transferEddies, type WalletState } from "../game/economy";

// Neon Dusk — Economy service (orchestration over the pure game logic)
// ============================================================================
// Wallets use optimistic locking: every write bumps `version` and only
// commits if the row still matches the version read earlier. Concurrent
// writers get a CONCURRENCY error and the caller retries.

/** Seed capital granted when a character's wallet is first created. */
const INITIAL_BALANCE = 500;
/** Max attempts for optimistic-lock write retries (exponential backoff). */
const MAX_RETRIES = 3;

/** Sleep helper for retry backoff. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure a character has a wallet. Creates one with INITIAL_BALANCE (and an
 * ADMIN_ADJUSTMENT audit entry) the first time; otherwise returns it as-is.
 */
export async function ensureWallet(characterId: string, tx: Tx): Promise<WalletState> {
  const existing = await tx
    .select()
    .from(characterWallets)
    .where(eq(characterWallets.characterId, characterId))
    .limit(1);

  if (existing.length > 0) {
    const w = existing[0];
    return {
      balance: w.balance,
      escrow: w.escrow,
      lifetimeEarned: w.lifetimeEarned,
      lifetimeSpent: w.lifetimeSpent,
      version: w.version,
    };
  }

  // Create wallet with seed capital. Concurrent requests may both reach this
  // INSERT (SELECT-then-INSERT race); ON CONFLICT DO NOTHING makes the loser a
  // no-op instead of a UNIQUE(character_id) violation.
  const [wallet] = await tx
    .insert(characterWallets)
    .values({
      characterId,
      balance: INITIAL_BALANCE,
      lifetimeEarned: INITIAL_BALANCE,
      escrow: 0,
      lifetimeSpent: 0,
      version: 0,
    })
    .onConflictDoNothing()
    .returning();

  if (!wallet) {
    // A concurrent request created the wallet first — re-read it. The conflict
    // means the row is committed, so this select is guaranteed to find it.
    const [existing] = await tx
      .select()
      .from(characterWallets)
      .where(eq(characterWallets.characterId, characterId))
      .limit(1);

    if (!existing) {
      throw new AppError(500, "WALLET_CREATE_FAILED", "Failed to create wallet");
    }
    return {
      balance: existing.balance,
      escrow: existing.escrow,
      lifetimeEarned: existing.lifetimeEarned,
      lifetimeSpent: existing.lifetimeSpent,
      version: existing.version,
    };
  }

  // Record seed transaction (only when THIS call created the wallet, so a
  // concurrent loser never writes a duplicate ADMIN_ADJUSTMENT entry).
  await tx.insert(transactionLog).values({
    characterId,
    type: "ADMIN_ADJUSTMENT",
    amount: INITIAL_BALANCE,
    balanceBefore: 0,
    balanceAfter: INITIAL_BALANCE,
    source: "Initial seed capital",
    referenceType: "system",
  });

  return {
    balance: wallet.balance,
    escrow: wallet.escrow,
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeSpent: wallet.lifetimeSpent,
    version: wallet.version,
  };
}

/**
 * Resolve the current user's character id (users have exactly one character).
 * Throws AppError(404) when the user has not created a character yet.
 */
export async function requireCharacterId(userId: string): Promise<string> {
  const [character] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.userId, userId))
    .limit(1);

  if (!character) throw new AppError(404, "NO_CHARACTER", "Create a character first");
  return character.id;
}

/**
 * Get wallet (read-only, no lock). Auto-creates with seed capital on first
 * read so a brand-new character can always see their balance.
 */
export async function getWallet(characterId: string): Promise<WalletState> {
  const [wallet] = await db
    .select()
    .from(characterWallets)
    .where(eq(characterWallets.characterId, characterId))
    .limit(1);

  if (!wallet) {
    return db.transaction(async (tx) => ensureWallet(characterId, tx));
  }

  return {
    balance: wallet.balance,
    escrow: wallet.escrow,
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeSpent: wallet.lifetimeSpent,
    version: wallet.version,
  };
}

/**
 * Transfer eddies with optimistic locking (version compare-and-swap).
 * Retries up to MAX_RETRIES times with exponential backoff on conflicts.
 * Throws AppError(400) on insufficient funds, AppError(409) on persistent
 * concurrency conflicts.
 */
export async function transfer(
  characterId: string,
  amount: number,
  type: TransactionType,
  source: string,
  referenceType?: string,
  referenceId?: string,
): Promise<{ wallet: WalletState; transaction: TransactionRecord }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Read current wallet state (or seed it on first use)
        const [row] = await tx
          .select()
          .from(characterWallets)
          .where(eq(characterWallets.characterId, characterId))
          .limit(1);

        const wallet: WalletState = row
          ? {
              balance: row.balance,
              escrow: row.escrow,
              lifetimeEarned: row.lifetimeEarned,
              lifetimeSpent: row.lifetimeSpent,
              version: row.version,
            }
          : await ensureWallet(characterId, tx);

        // Apply transfer via game logic. Escrow is committed but not spendable:
        // check available funds (balance − escrow) BEFORE the debit so a
        // check(escrow <= balance) violation surfaces as a clean 400, not a 500.
        if (amount < 0) {
          const availableFunds = wallet.balance - wallet.escrow;
          if (Math.abs(amount) > availableFunds) {
            throw new AppError(
              400,
              "INSUFFICIENT_FUNDS",
              `Need ${Math.abs(amount)} available eddies, have ${availableFunds}`,
            );
          }
        }
        const result = transferEddies(wallet, amount, { type, source, referenceType, referenceId });

        // Optimistic update with version check
        const [updated] = await tx
          .update(characterWallets)
          .set({
            balance: result.wallet.balance,
            escrow: result.wallet.escrow,
            lifetimeEarned: result.wallet.lifetimeEarned,
            lifetimeSpent: result.wallet.lifetimeSpent,
            version: result.wallet.version + 1,
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
          throw new Error("CONCURRENCY");
        }

        // Append audit entry
        const [txLog] = await tx
          .insert(transactionLog)
          .values({
            characterId,
            type: result.transaction.type,
            amount: result.transaction.amount,
            balanceBefore: result.transaction.balanceBefore,
            balanceAfter: result.transaction.balanceAfter,
            source: result.transaction.source,
            referenceType: result.transaction.referenceType ?? null,
            referenceId: result.transaction.referenceId ?? null,
          })
          .returning();

        return {
          wallet: { ...result.wallet, version: updated.version },
          transaction: {
            ...txLog,
            createdAt: txLog.createdAt.toISOString(),
          },
        };
      });
    } catch (err) {
      if (err instanceof Error && err.message === "CONCURRENCY") {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(10 * Math.pow(2, attempt));
          continue;
        }
        // Retries exhausted — surface the documented client-facing error.
        throw new AppError(
          409,
          "CONCURRENCY_CONFLICT",
          "Too many concurrent operations. Try again.",
        );
      }
      if (err instanceof Error && err.message === "Insufficient funds") {
        throw new AppError(400, "INSUFFICIENT_FUNDS", "Not enough eddies");
      }
      throw err;
    }
  }

  // Defensive: the loop above always returns or throws, but TS control-flow
  // analysis cannot prove it — keep an explicit terminal throw.
  throw new AppError(409, "CONCURRENCY_CONFLICT", "Too many concurrent operations. Try again.");
}

/**
 * Get a character's transactions, newest first, with cursor-based pagination.
 * Returns one extra row internally to detect whether a next page exists.
 */
export async function getTransactions(
  characterId: string,
  limit: number = 20,
  cursor?: string,
): Promise<{ transactions: TransactionRecord[]; nextCursor: string | null }> {
  const conditions = [eq(transactionLog.characterId, characterId)];
  if (cursor) {
    conditions.push(lt(transactionLog.createdAt, new Date(cursor)));
  }

  const rows = await db
    .select()
    .from(transactionLog)
    .where(and(...conditions))
    .orderBy(desc(transactionLog.createdAt))
    .limit(limit + 1); // one extra row to know if there's a next page

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

  return {
    transactions: page.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/**
 * List active vendors (id, name, type, district), ordered by name.
 */
export async function listVendors(): Promise<VendorRecord[]> {
  return db
    .select({ id: vendors.id, name: vendors.name, type: vendors.type, district: vendors.district })
    .from(vendors)
    .where(eq(vendors.isActive, true))
    .orderBy(vendors.name);
}

/**
 * Get one vendor with its full inventory. Throws AppError(404) when the
 * vendor does not exist.
 */
export async function getVendor(vendorId: string): Promise<{
  vendor: VendorRecord;
  inventory: Array<{
    id: string;
    vendorId: string;
    itemType: string;
    itemId: string;
    price: number;
    stock: number;
  }>;
}> {
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);

  if (!vendor) throw new AppError(404, "VENDOR_NOT_FOUND", "Vendor not found");

  const inventory = await db
    .select()
    .from(vendorInventory)
    .where(eq(vendorInventory.vendorId, vendorId));

  return {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      type: vendor.type,
      district: vendor.district,
      description: vendor.description,
    },
    inventory,
  };
}

/**
 * Buy an item from a vendor. Runs in one PostgreSQL transaction: checks
 * stock, validates funds against the available balance (balance − escrow),
 * applies the debit with optimistic locking and records the audit entry.
 */
export async function buyFromVendor(
  characterId: string,
  vendorId: string,
  itemType: string,
  itemId: string,
  quantity: number,
): Promise<{
  balanceBefore: number;
  balanceAfter: number;
  item: {
    itemType: string;
    itemId: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  };
}> {
  // Validate input
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AppError(400, "INVALID_QUANTITY", "Quantity must be a positive integer");
  }

  return db.transaction(async (tx) => {
    // 1. Get vendor item
    const [item] = await tx
      .select()
      .from(vendorInventory)
      .where(
        and(
          eq(vendorInventory.vendorId, vendorId),
          eq(vendorInventory.itemType, itemType),
          eq(vendorInventory.itemId, itemId),
        ),
      )
      .limit(1);

    if (!item) throw new AppError(404, "ITEM_NOT_FOUND", "Item not found at this vendor");

    // 2. Check stock (stock >= 0 means limited, -1 means unlimited)
    if (item.stock >= 0 && item.stock < quantity) {
      throw new AppError(400, "OUT_OF_STOCK", `Only ${item.stock} available`);
    }

    // 3. Get wallet (seed on first use)
    const wallet = await ensureWallet(characterId, tx);

    // 4. Calculate price
    const totalPrice = calculatePrice(item.price) * quantity;

    // 5. Check funds (escrow is committed but not spendable)
    const availableFunds = wallet.balance - wallet.escrow;
    if (availableFunds < totalPrice) {
      throw new AppError(
        400,
        "INSUFFICIENT_FUNDS",
        `Need ${totalPrice} eddies, have ${availableFunds}`,
      );
    }

    // 6. Apply transfer via game logic
    const result = transferEddies(wallet, -totalPrice, {
      type: "VENDOR_PURCHASE",
      source: `Purchased ${quantity}x ${itemType}/${itemId} from vendor ${vendorId}`,
    });

    // 7. Update wallet with optimistic lock
    const [updated] = await tx
      .update(characterWallets)
      .set({
        balance: result.wallet.balance,
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
      throw new AppError(
        409,
        "CONCURRENCY_CONFLICT",
        "Concurrent modification detected. Try again.",
      );
    }

    // 8. Insert audit entry
    await tx.insert(transactionLog).values({
      characterId,
      type: "VENDOR_PURCHASE",
      amount: -totalPrice,
      balanceBefore: result.transaction.balanceBefore,
      balanceAfter: result.transaction.balanceAfter,
      source: result.transaction.source,
    });

    // 9. Decrement stock (unlimited items are skipped)
    if (item.stock >= 0) {
      await tx
        .update(vendorInventory)
        .set({ stock: item.stock - quantity })
        .where(eq(vendorInventory.id, item.id));
    }

    return {
      balanceBefore: result.transaction.balanceBefore,
      balanceAfter: result.transaction.balanceAfter,
      item: {
        itemType,
        itemId,
        quantity,
        unitPrice: item.price,
        totalPrice,
      },
    };
  });
}
