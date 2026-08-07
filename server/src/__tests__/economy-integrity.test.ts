import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { characterWallets, transactionLog, vendorInventory, vendors } from "../db/schema";
import { buyFromVendor, ensureWallet, getWallet, transfer } from "../services/economy-service";
import { insertTestCharacter, resetDb } from "./helpers";

// ND-010 — integrity tests: money conservation, optimistic locking under race
// conditions, and transaction atomicity. These assert DB-level invariants, not
// just API responses.

describe("economy integrity", () => {
  beforeAll(async () => {
    await resetDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
  });

  describe("money conservation", () => {
    it("should keep the ledger balanced across many transfers (Σ deltas = 0)", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      // 5 credits of 100, 5 debits of 100 → net zero after the seed.
      for (let i = 0; i < 5; i++) {
        await transfer(characterId, 100, "GIG_PAYOUT", `gig-${i}`);
        await transfer(characterId, -100, "VENDOR_PURCHASE", `buy-${i}`);
      }

      const [{ sum }] = await db
        .select({
          sum: sql<number>`coalesce(sum(balance_after - balance_before), 0)`,
        })
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            // Exclude the seed — it IS the capital injected into the system.
            sql`${transactionLog.type} != 'ADMIN_ADJUSTMENT'`,
          ),
        );

      expect(Number(sum)).toBe(0);

      // Wallet balance must equal the running sum of ALL its transactions.
      const [{ running }] = await db
        .select({
          running: sql<number>`coalesce(sum(amount), 0)`,
        })
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));
      const wallet = await getWallet(characterId);

      expect(Number(running)).toBe(wallet.balance);
    });

    it("should conserve total eddies across multiple wallets (Σ balance = Σ credits - Σ debits)", async () => {
      const a = await insertTestCharacter();
      const b = await insertTestCharacter();

      // Seed both wallets (2 × 500 injected).
      for (const { characterId } of [a, b]) {
        await db.transaction((tx) => ensureWallet(characterId, tx));
      }
      // Cross-wallet movement: A earns 300, spends 100 → B receives 100.
      await transfer(a.characterId, 300, "GIG_PAYOUT", "gig");
      await transfer(a.characterId, -100, "PVP_LOSS", "pvp");
      await transfer(b.characterId, 100, "PVP_REWARD", "pvp");

      const wallets = await db.select().from(characterWallets);
      const totalBalance = wallets.reduce((acc, w) => acc + w.balance, 0);

      // Injected: 1000 (seed) + 300 (A earns) + 100 (B reward). Spent: 100 (A loss).
      expect(totalBalance).toBe(1000 + 300 + 100 - 100);

      // And the sum of every transaction amount matches the sum of balances.
      const [{ txSum }] = await db.select({
        txSum: sql<number>`coalesce(sum(amount), 0)`,
      }).from(transactionLog);
      expect(Number(txSum)).toBe(totalBalance);
    });
  });

  describe("optimistic locking under race conditions", () => {
    it("should not lose updates when many transfers race the same wallet", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      // 10 concurrent +20 transfers on a wallet starting at 500.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => transfer(characterId, 20, "GIG_PAYOUT", `race-${i}`)),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;

      // Whatever the retry outcome, no eddies are created or destroyed:
      // balance reflects exactly the successful transfers.
      const wallet = await getWallet(characterId);
      expect(wallet.balance).toBe(500 + 20 * succeeded);
      expect(wallet.lifetimeEarned).toBe(500 + 20 * succeeded);
      expect(wallet.version).toBe(succeeded); // one bump per successful write
    });

    it("should produce sequential version numbers without gaps or duplicates", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => transfer(characterId, 5, "GIG_PAYOUT", `v-${i}`)),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;

      // version starts at 0 (seed) and each successful write bumps by exactly 1,
      // so the final version equals the number of successful writes.
      const wallet = await getWallet(characterId);
      expect(wallet.version).toBe(ok);

      // And every transaction log entry is internally consistent (after - before = amount).
      const rows = await db
        .select()
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));
      for (const row of rows) {
        expect(row.balanceAfter - row.balanceBefore).toBe(row.amount);
      }

      // Consecutive audit entries must chain: each row's balance_before equals
      // the previous row's balance_after (in ascending order).
      const asc = [...rows].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      for (let i = 1; i < asc.length; i++) {
        expect(asc[i].balanceBefore).toBe(asc[i - 1].balanceAfter);
      }
    });

    it("should keep the race-safe when mixing credits and debits concurrently", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const ops = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? transfer(characterId, 30, "GIG_PAYOUT", `in-${i}`)
          : transfer(characterId, -20, "VENDOR_PURCHASE", `out-${i}`),
      );
      const results = await Promise.allSettled(ops);

      // Net change = Σ fulfilled op amounts (allSettled preserves op order).
      const net = results.reduce((acc, r, idx) => {
        if (r.status === "fulfilled") {
          return acc + (idx % 2 === 0 ? 30 : -20);
        }
        return acc;
      }, 0);

      const wallet = await getWallet(characterId);
      expect(wallet.balance).toBe(500 + net);
      expect(wallet.balance).toBeGreaterThanOrEqual(0);
    });
  });

  describe("atomicity", () => {
    it("should roll back the wallet debit when the stock decrement fails mid-transaction", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const [vendor] = await db
        .insert(vendors)
        .values({ name: `Store-${Date.now()}`, type: "FIXER", district: "o_fluxo" })
        .returning();
      const [item] = await db
        .insert(vendorInventory)
        .values({ vendorId: vendor.id, itemType: "weapon", itemId: "nova-9", price: 100, stock: 2 })
        .returning();

      // Break the stock decrement AFTER the wallet debit: a trigger that rejects
      // the UPDATE on vendor_inventory. buyFromVendor's transaction must then
      // roll back the wallet debit and the audit entry too.
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION nd_test_block_stock() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected stock failure'; END;
        $$ LANGUAGE plpgsql
      `);
      await db.execute(sql`
        CREATE TRIGGER nd_test_stock_guard
        BEFORE UPDATE ON vendor_inventory
        FOR EACH ROW EXECUTE FUNCTION nd_test_block_stock()
      `);

      try {
        await expect(
          buyFromVendor(characterId, vendor.id, "weapon", "nova-9", 1),
        ).rejects.toThrow(/injected stock failure/);

        // Wallet untouched — the debit was rolled back.
        const wallet = await getWallet(characterId);
        expect(wallet.balance).toBe(500);
        expect(wallet.version).toBe(0);

        // No audit entry for the aborted purchase.
        const purchases = await db
          .select()
          .from(transactionLog)
          .where(
            and(
              eq(transactionLog.characterId, characterId),
              eq(transactionLog.type, "VENDOR_PURCHASE"),
            ),
          );
        expect(purchases).toHaveLength(0);

        // Stock untouched.
        const [after] = await db
          .select()
          .from(vendorInventory)
          .where(eq(vendorInventory.id, item.id));
        expect(after.stock).toBe(2);
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS nd_test_stock_guard ON vendor_inventory`);
        await db.execute(sql`DROP FUNCTION IF EXISTS nd_test_block_stock()`);
      }
    });

    it("should leave no partial state when a concurrent buyer loses the race", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const [vendor] = await db
        .insert(vendors)
        .values({ name: `Store-${Date.now()}`, type: "FIXER", district: "o_fluxo" })
        .returning();
      await db.insert(vendorInventory).values({
        vendorId: vendor.id,
        itemType: "weapon",
        itemId: "nova-9",
        price: 100,
        stock: 3,
      });

      // Two buyers race the same item. The loser (version conflict or stock
      // race) must roll back entirely — no wallet debit, no audit row, no
      // partial stock change. Whatever the interleaving, the DB state must
      // be exactly consistent with the number of fulfilled purchases.
      const results = await Promise.allSettled([
        buyFromVendor(characterId, vendor.id, "weapon", "nova-9", 1),
        buyFromVendor(characterId, vendor.id, "weapon", "nova-9", 1),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected");

      // Every failure must be a clean business error (never a partial commit).
      for (const f of failed) {
        const code = (f as PromiseRejectedResult).reason?.code;
        expect(["CONCURRENCY_CONFLICT", "OUT_OF_STOCK", "INSUFFICIENT_FUNDS"]).toContain(code);
      }

      // State is exactly consistent with `ok` landed purchases.
      const wallet = await getWallet(characterId);
      expect(wallet.balance).toBe(500 - 100 * ok);
      expect(wallet.version).toBe(ok);

      const purchases = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "VENDOR_PURCHASE"),
          ),
        );
      expect(purchases).toHaveLength(ok);

      const [inventory] = await db
        .select()
        .from(vendorInventory)
        .where(eq(vendorInventory.vendorId, vendor.id));
      expect(inventory.stock).toBe(3 - ok);
    });
  });
});
