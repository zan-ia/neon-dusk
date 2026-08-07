import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  characterWallets,
  transactionLog,
  vendorInventory,
  vendors,
} from "../db/schema";
import {
  buyFromVendor,
  ensureWallet,
  getTransactions,
  getVendor,
  getWallet,
  listVendors,
  transfer,
} from "../services/economy-service";
import { insertTestCharacter, resetDb } from "./helpers";

// ND-010 — economy service tests against the isolated test Postgres.
// Characters are inserted directly (no HTTP) so each test controls its own
// wallet state; vendors are seeded inline per test.

describe("economy service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
  });

  describe("ensureWallet", () => {
    it("should create a wallet with seed capital (500) for a new character", async () => {
      const { characterId } = await insertTestCharacter();

      const wallet = await db.transaction((tx) => ensureWallet(characterId, tx));

      expect(wallet.balance).toBe(500);
      expect(wallet.lifetimeEarned).toBe(500);
      expect(wallet.lifetimeSpent).toBe(0);
      expect(wallet.escrow).toBe(0);
      expect(wallet.version).toBe(0);
    });

    it("should record an ADMIN_ADJUSTMENT seed transaction with balance_before 0 and balance_after 500", async () => {
      const { characterId } = await insertTestCharacter();

      await db.transaction((tx) => ensureWallet(characterId, tx));

      const [seed] = await db
        .select()
        .from(transactionLog)
        .where(eq(transactionLog.characterId, characterId));

      expect(seed).toMatchObject({
        type: "ADMIN_ADJUSTMENT",
        amount: 500,
        balanceBefore: 0,
        balanceAfter: 500,
        source: "Initial seed capital",
      });
    });

    it("should be idempotent — not create a duplicate wallet or a second seed transaction", async () => {
      const { characterId } = await insertTestCharacter();

      await db.transaction((tx) => ensureWallet(characterId, tx));
      const second = await db.transaction((tx) => ensureWallet(characterId, tx));

      const wallets = await db
        .select()
        .from(characterWallets)
        .where(eq(characterWallets.characterId, characterId));
      const seeds = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "ADMIN_ADJUSTMENT"),
          ),
        );

      expect(wallets).toHaveLength(1);
      expect(seeds).toHaveLength(1);
      expect(second.balance).toBe(500);
    });
  });

  describe("getWallet", () => {
    it("should return the wallet state for an existing wallet", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const wallet = await getWallet(characterId);

      expect(wallet.balance).toBe(500);
      expect(wallet.lifetimeEarned).toBe(500);
      expect(wallet.version).toBe(0);
    });

    it("should auto-create the wallet on first read (ensureWallet side effect)", async () => {
      const { characterId } = await insertTestCharacter();

      const wallet = await getWallet(characterId);
      const stored = await db
        .select()
        .from(characterWallets)
        .where(eq(characterWallets.characterId, characterId));

      expect(wallet.balance).toBe(500);
      expect(stored).toHaveLength(1);
    });

    it("should return correct escrow/lifetime stats", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      await transfer(characterId, 500, "GIG_PAYOUT", "gig");
      await transfer(characterId, -200, "VENDOR_PURCHASE", "vendor");

      const wallet = await getWallet(characterId);

      expect(wallet.balance).toBe(800); // 500 seed + 500 payout - 200 purchase
      expect(wallet.lifetimeEarned).toBe(1000);
      expect(wallet.lifetimeSpent).toBe(200);
    });
  });

  describe("transfer — happy path", () => {
    it("should credit the balance and update lifetime stats", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const { wallet, transaction } = await transfer(characterId, 250, "GIG_PAYOUT", "gig-1");

      expect(wallet.balance).toBe(750);
      expect(wallet.lifetimeEarned).toBe(750);
      expect(wallet.lifetimeSpent).toBe(0);
      expect(wallet.version).toBe(1);
      expect(transaction.amount).toBe(250);
      expect(transaction.balanceBefore).toBe(500);
      expect(transaction.balanceAfter).toBe(750);
      expect(transaction.type).toBe("GIG_PAYOUT");
    });

    it("should debit the balance and update lifetime stats", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const { wallet } = await transfer(characterId, -150, "VENDOR_PURCHASE", "vendor");

      expect(wallet.balance).toBe(350);
      expect(wallet.lifetimeEarned).toBe(500);
      expect(wallet.lifetimeSpent).toBe(150);
    });

    it("should write a transaction log entry with correct balances", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      await transfer(
        characterId,
        -120,
        "VENDOR_PURCHASE",
        "vendor",
        "vendor",
        "11111111-2222-4333-8444-555555555555",
      );

      const [log] = await db
        .select()
        .from(transactionLog)
        .where(eq(transactionLog.type, "VENDOR_PURCHASE"));

      expect(log).toMatchObject({
        characterId,
        amount: -120,
        balanceBefore: 500,
        balanceAfter: 380,
        source: "vendor",
        referenceType: "vendor",
        referenceId: "11111111-2222-4333-8444-555555555555",
      });
    });

    it("should increment the wallet version on each write", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      const first = await transfer(characterId, 10, "GIG_PAYOUT", "gig");
      const second = await transfer(characterId, 10, "GIG_PAYOUT", "gig");

      expect(first.wallet.version).toBe(1);
      expect(second.wallet.version).toBe(2);
    });
  });

  describe("transfer — errors", () => {
    it("should return 400 INSUFFICIENT_FUNDS when debiting more than the balance", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      await expect(transfer(characterId, -1500, "VENDOR_PURCHASE", "vendor")).rejects.toMatchObject({
        statusCode: 400,
        code: "INSUFFICIENT_FUNDS",
      });
    });

    it("should retry and succeed on concurrent modification", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      // Two writers race on version 0; one wins, the other retries and lands.
      const [a, b] = await Promise.all([
        transfer(characterId, 100, "GIG_PAYOUT", "gig-a"),
        transfer(characterId, 50, "GIG_PAYOUT", "gig-b"),
      ]);

      expect(a.wallet.version + b.wallet.version).toBe(3); // versions 1 and 2
      const wallet = await getWallet(characterId);
      expect(wallet.balance).toBe(650); // 500 + 100 + 50, no lost update
    });

    it("should return 409 CONCURRENCY_CONFLICT after max retries are exhausted", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      // 10 writers all start from version 0. With MAX_RETRIES=3, the losers
      // that keep colliding on every attempt surface CONCURRENCY_CONFLICT.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          transfer(characterId, 10, "GIG_PAYOUT", `gig-${i}`),
        ),
      );

      const conflicts = results.filter((r) => r.status === "rejected");
      const ok = results.filter((r) => r.status === "fulfilled");

      expect(conflicts.length).toBeGreaterThan(0);
      for (const c of conflicts) {
        expect((c as PromiseRejectedResult).reason).toMatchObject({
          statusCode: 409,
          code: "CONCURRENCY_CONFLICT",
        });
      }

      // No eddies lost: balance reflects exactly the successful transfers.
      const wallet = await getWallet(characterId);
      expect(wallet.balance).toBe(500 + 10 * ok.length);
      expect(wallet.version).toBe(ok.length);
    });
  });

  describe("getTransactions", () => {
    it("should return transactions in descending order by createdAt", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      await transfer(characterId, 100, "GIG_PAYOUT", "first");
      await transfer(characterId, -50, "VENDOR_PURCHASE", "second");

      const { transactions } = await getTransactions(characterId);

      expect(transactions.map((t) => t.type)).toEqual([
        "VENDOR_PURCHASE",
        "GIG_PAYOUT",
        "ADMIN_ADJUSTMENT",
      ]);
      expect(transactions[0].createdAt >= transactions[1].createdAt).toBe(true);
    });

    it("should respect the limit", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      for (let i = 0; i < 5; i++) {
        await transfer(characterId, 10, "GIG_PAYOUT", `gig-${i}`);
      }

      const { transactions, nextCursor } = await getTransactions(characterId, 3);

      expect(transactions).toHaveLength(3);
      expect(nextCursor).not.toBeNull();
    });

    it("should paginate with a cursor and return null nextCursor on the last page", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      for (let i = 0; i < 5; i++) {
        await transfer(characterId, 10, "GIG_PAYOUT", `gig-${i}`);
      }
      // 1 seed + 5 transfers = 6 rows. Page 1: 2 rows, page 2: 2, page 3: 2 (end).

      const page1 = await getTransactions(characterId, 2);
      expect(page1.transactions).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await getTransactions(characterId, 2, page1.nextCursor ?? undefined);
      expect(page2.transactions).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await getTransactions(characterId, 2, page2.nextCursor ?? undefined);
      expect(page3.transactions).toHaveLength(2);
      expect(page3.nextCursor).toBeNull();

      // No overlaps across pages.
      const allIds = [...page1.transactions, ...page2.transactions, ...page3.transactions].map(
        (t) => t.id,
      );
      expect(new Set(allIds).size).toBe(6);
    });

    it("should return an empty page for a character with no transactions", async () => {
      const { characterId } = await insertTestCharacter();

      const { transactions, nextCursor } = await getTransactions(characterId);

      expect(transactions).toEqual([]);
      expect(nextCursor).toBeNull();
    });
  });

  describe("listVendors / getVendor", () => {
    async function seedVendor(opts: { isActive?: boolean } = {}) {
      const [vendor] = await db
        .insert(vendors)
        .values({
          name: `Doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "RIPPERDOC",
          district: "a_paraiso",
          isActive: opts.isActive ?? true,
        })
        .returning();
      return vendor;
    }

    it("should list only active vendors", async () => {
      const active = await seedVendor();
      const inactive = await seedVendor({ isActive: false });

      const list = await listVendors();
      const ids = list.map((v) => v.id);

      expect(ids).toContain(active.id);
      expect(ids).not.toContain(inactive.id);
    });

    it("should return a vendor with its inventory", async () => {
      const vendor = await seedVendor();
      await db
        .insert(vendorInventory)
        .values({ vendorId: vendor.id, itemType: "weapon", itemId: "nova-9", price: 100, stock: 3 });

      const result = await getVendor(vendor.id);

      expect(result.vendor.id).toBe(vendor.id);
      expect(result.inventory).toHaveLength(1);
      expect(result.inventory[0]).toMatchObject({
        vendorId: vendor.id,
        itemType: "weapon",
        itemId: "nova-9",
        price: 100,
        stock: 3,
      });
    });

    it("should return 404 for a non-existent vendor", async () => {
      await expect(getVendor("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
        statusCode: 404,
        code: "VENDOR_NOT_FOUND",
      });
    });
  });

  describe("buyFromVendor — happy path", () => {
    async function seedStore(opts: { price?: number; stock?: number } = {}) {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      const [vendor] = await db
        .insert(vendors)
        .values({
          name: `Store-${Date.now()}`,
          type: "FIXER",
          district: "o_fluxo",
          isActive: true,
        })
        .returning();
      const [item] = await db
        .insert(vendorInventory)
        .values({
          vendorId: vendor.id,
          itemType: "weapon",
          itemId: "nova-9",
          price: opts.price ?? 100,
          stock: opts.stock ?? 5,
        })
        .returning();
      return { characterId, vendorId: vendor.id, item };
    }

    it("should debit the wallet and return the purchased item", async () => {
      const { characterId, vendorId, item } = await seedStore();

      const result = await buyFromVendor(characterId, vendorId, "weapon", "nova-9", 2);

      expect(result.balanceBefore).toBe(500);
      expect(result.balanceAfter).toBe(300);
      expect(result.item).toEqual({
        itemType: "weapon",
        itemId: "nova-9",
        quantity: 2,
        unitPrice: 100,
        totalPrice: 200,
      });
      expect(item.id).toBeTruthy();
    });

    it("should decrement the stock when stock is finite", async () => {
      const { characterId, vendorId } = await seedStore({ stock: 5 });

      await buyFromVendor(characterId, vendorId, "weapon", "nova-9", 2);

      const [row] = await db
        .select()
        .from(vendorInventory)
        .where(eq(vendorInventory.vendorId, vendorId));
      expect(row.stock).toBe(3);
    });

    it("should record a VENDOR_PURCHASE transaction log entry", async () => {
      const { characterId, vendorId } = await seedStore();

      await buyFromVendor(characterId, vendorId, "weapon", "nova-9", 1);

      const [log] = await db
        .select()
        .from(transactionLog)
        .where(
          and(
            eq(transactionLog.characterId, characterId),
            eq(transactionLog.type, "VENDOR_PURCHASE"),
          ),
        );

      expect(log).toMatchObject({
        amount: -100,
        balanceBefore: 500,
        balanceAfter: 400,
      });
    });

    it("should allow any quantity from an unlimited-stock vendor (stock = -1)", async () => {
      const { characterId, vendorId } = await seedStore({ price: 10, stock: -1 });

      const result = await buyFromVendor(characterId, vendorId, "weapon", "nova-9", 50);

      expect(result.balanceAfter).toBe(500 - 10 * 50);
      const [row] = await db
        .select()
        .from(vendorInventory)
        .where(eq(vendorInventory.vendorId, vendorId));
      expect(row.stock).toBe(-1); // untouched
    });
  });

  describe("buyFromVendor — errors", () => {
    async function seedStore(opts: { price?: number; stock?: number } = {}) {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));
      const [vendor] = await db
        .insert(vendors)
        .values({ name: `Store-${Date.now()}`, type: "FIXER", district: "o_fluxo" })
        .returning();
      await db
        .insert(vendorInventory)
        .values({
          vendorId: vendor.id,
          itemType: "weapon",
          itemId: "nova-9",
          price: opts.price ?? 100,
          stock: opts.stock ?? 5,
        });
      return { characterId, vendorId: vendor.id };
    }

    it("should return 404 when the vendor does not exist", async () => {
      const { characterId } = await insertTestCharacter();
      await db.transaction((tx) => ensureWallet(characterId, tx));

      await expect(
        buyFromVendor(characterId, "00000000-0000-0000-0000-000000000000", "weapon", "nova-9", 1),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "ITEM_NOT_FOUND",
      });
    });

    it("should return 404 when the item is not sold by the vendor", async () => {
      const { characterId, vendorId } = await seedStore();

      await expect(
        buyFromVendor(characterId, vendorId, "weapon", "ghost-blade", 1),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "ITEM_NOT_FOUND",
      });
    });

    it("should return 400 OUT_OF_STOCK when quantity exceeds stock", async () => {
      const { characterId, vendorId } = await seedStore({ stock: 1 });

      await expect(
        buyFromVendor(characterId, vendorId, "weapon", "nova-9", 2),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "OUT_OF_STOCK",
      });
    });

    it("should return 400 INSUFFICIENT_FUNDS when balance - escrow is below the price", async () => {
      const { characterId, vendorId } = await seedStore({ price: 1500 });

      await expect(
        buyFromVendor(characterId, vendorId, "weapon", "nova-9", 1),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INSUFFICIENT_FUNDS",
      });
    });

    it("should account for escrow when checking funds", async () => {
      const { characterId, vendorId } = await seedStore({ price: 800 });
      // Balance is 500 but 300 is committed to escrow → only 200 available.
      await db
        .update(characterWallets)
        .set({ escrow: 300 })
        .where(eq(characterWallets.characterId, characterId));

      await expect(
        buyFromVendor(characterId, vendorId, "weapon", "nova-9", 1),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INSUFFICIENT_FUNDS",
      });
    });

    it("should return 400 INVALID_QUANTITY for zero, negative and non-integer quantities", async () => {
      const { characterId, vendorId } = await seedStore();

      for (const qty of [0, -1, 1.5]) {
        await expect(
          buyFromVendor(characterId, vendorId, "weapon", "nova-9", qty),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: "INVALID_QUANTITY",
        });
      }
    });
  });
});
