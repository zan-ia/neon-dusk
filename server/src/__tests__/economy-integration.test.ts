import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { envSchema } from "../env";
import { startTestServer, json, authHeader, resetDb } from "./helpers";
import { db } from "../db";
import { vendorInventory, vendors } from "../db/schema";
import type {
  AuthResponse,
  BuyResponse,
  CreateCharacterRequest,
  EconomyBalanceResponse,
  TransactionListResponse,
  VendorRecord,
  VendorWithInventory,
} from "@neon-dusk/shared";

// ND-010 — economy + vendor API integration tests. Real HTTP against the app
// (Fastify + Postgres + Redis on the isolated test stack). Dedicated redis db
// (5) so rate-limit counters never leak across files.

const REDIS_TEST_DB = "redis://localhost:56379/5";

const PASSWORD = "StrongPass123!";

let seq = 0;
function uniqueEmail(): string {
  return `eco-${Date.now()}-${seq++}@neondusk.test`;
}
function uniqueName(): string {
  return `Blade-${Date.now()}-${seq++}`;
}

function validAttributes(): CreateCharacterRequest["attributes"] {
  return { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 };
}

interface ErrorBody {
  error: string;
  message: string;
  details?: { path: (string | number)[]; message: string }[];
}

describe("Feature #3 — economy & vendors API", () => {
  let app: FastifyInstance;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  const base = () => `http://127.0.0.1:${server.port}`;

  const ITEM_TYPE = "weapon";
  const ITEM_ID = "nova-9";

  // One static vendor for listing/detail tests.
  let staticVendorId = "";

  beforeAll(async () => {
    await resetDb();

    const redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
    await redis.flushdb();
    redis.disconnect();

    app = await buildApp({ env: envSchema.parse({ ...process.env, REDIS_URL: REDIS_TEST_DB }) });
    server = await startTestServer(app);

    const [vendor] = await db
      .insert(vendors)
      .values({
        name: "Ripper " + Date.now(),
        type: "RIPPERDOC",
        district: "a_paraiso",
        description: "Test ripperdoc",
        isActive: true,
      })
      .returning();
    staticVendorId = vendor.id;
    await db.insert(vendorInventory).values({
      vendorId: vendor.id,
      itemType: ITEM_TYPE,
      itemId: ITEM_ID,
      price: 100,
      stock: 10,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Register a fresh user + character via HTTP; returns the access token. */
  async function registerAndCreateCharacter(): Promise<string> {
    const res = await server.post("/api/auth/register", { email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(201);
    const { accessToken } = await json<AuthResponse>(res);

    const created = await fetch(`${base()}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(accessToken) },
      body: JSON.stringify({
        name: uniqueName(),
        origin: "a_paraiso",
        role: "solo",
        attributes: validAttributes(),
      }),
    });
    expect(created.status).toBe(201);
    return accessToken;
  }

  /** Seed an isolated vendor + inventory row for a single test. */
  async function seedVendor(opts: { price?: number; stock?: number } = {}) {
    const [vendor] = await db
      .insert(vendors)
      .values({
        name: `Store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "FIXER",
        district: "o_fluxo",
        isActive: true,
      })
      .returning();
    await db.insert(vendorInventory).values({
      vendorId: vendor.id,
      itemType: ITEM_TYPE,
      itemId: ITEM_ID,
      price: opts.price ?? 100,
      stock: opts.stock ?? 10,
    });
    return vendor.id;
  }

  describe("GET /api/economy/balance", () => {
    it("should return the wallet balance, escrow and lifetime stats for an authenticated character", async () => {
      const accessToken = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/economy/balance`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<EconomyBalanceResponse>(res);
      expect(body.balance).toBe(500);
      expect(body.escrow).toBe(0);
      expect(body.lifetimeEarned).toBe(500);
      expect(body.lifetimeSpent).toBe(0);
    });

    it("should return 401 without an access token", async () => {
      const res = await server.get("/api/economy/balance");
      expect(res.status).toBe(401);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should return 404 NO_CHARACTER for a user without a character", async () => {
      const res = await server.post("/api/auth/register", {
        email: uniqueEmail(),
        password: PASSWORD,
      });
      const { accessToken } = await json<AuthResponse>(res);

      const balance = await fetch(`${base()}/api/economy/balance`, {
        headers: authHeader(accessToken),
      });

      expect(balance.status).toBe(404);
      const body = await json<ErrorBody>(balance);
      expect(body.error).toBe("NO_CHARACTER");
    });
  });

  describe("GET /api/economy/transactions", () => {
    it("should return the seed transaction for a fresh character", async () => {
      const accessToken = await registerAndCreateCharacter();
      // Touch balance first so the wallet (and its ADMIN_ADJUSTMENT) exists.
      await fetch(`${base()}/api/economy/balance`, { headers: authHeader(accessToken) });

      const res = await fetch(`${base()}/api/economy/transactions`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<TransactionListResponse>(res);
      expect(body.transactions.length).toBeGreaterThanOrEqual(1);
      expect(body.transactions[0].type).toBe("ADMIN_ADJUSTMENT");
      expect(body.transactions[0].amount).toBe(500);
      expect(body.nextCursor).toBeNull(); // single page — no more data
    });

    it("should respect the limit query param", async () => {
      const accessToken = await registerAndCreateCharacter();
      // Two transactions: seed + purchase.
      const vendorId = await seedVendor();
      await fetch(`${base()}/api/economy/balance`, { headers: authHeader(accessToken) });
      await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 1 },
        authHeader(accessToken),
      );

      const res = await fetch(`${base()}/api/economy/transactions?limit=1`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<TransactionListResponse>(res);
      expect(body.transactions).toHaveLength(1);
      expect(body.nextCursor).not.toBeNull();
    });

    it("should paginate using the cursor", async () => {
      const accessToken = await registerAndCreateCharacter();
      // Two transactions: seed + purchase.
      const vendorId = await seedVendor();
      await fetch(`${base()}/api/economy/balance`, { headers: authHeader(accessToken) });
      await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 1 },
        authHeader(accessToken),
      );

      const page1 = await fetch(`${base()}/api/economy/transactions?limit=1`, {
        headers: authHeader(accessToken),
      });
      const body1 = await json<TransactionListResponse>(page1);
      expect(body1.transactions).toHaveLength(1);
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await fetch(
        `${base()}/api/economy/transactions?limit=1&cursor=${encodeURIComponent(body1.nextCursor!)}`,
        { headers: authHeader(accessToken) },
      );
      const body2 = await json<TransactionListResponse>(page2);

      expect(page2.status).toBe(200);
      expect(body2.transactions).toHaveLength(1);
      expect(body2.transactions[0].id).not.toBe(body1.transactions[0].id);
      expect(body2.nextCursor).toBeNull(); // last page
    });

    it("should return 400 for an invalid cursor", async () => {
      const accessToken = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/economy/transactions?cursor=not-a-date`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without auth", async () => {
      const res = await server.get("/api/economy/transactions");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/vendors", () => {
    it("should list active vendors", async () => {
      const accessToken = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/vendors`, { headers: authHeader(accessToken) });

      expect(res.status).toBe(200);
      const body = await json<VendorRecord[]>(res);
      expect(body.some((v) => v.id === staticVendorId)).toBe(true);
      expect(body[0]).toHaveProperty("name");
      expect(body[0]).toHaveProperty("type");
      expect(body[0]).toHaveProperty("district");
    });

    it("should exclude inactive vendors", async () => {
      const [inactive] = await db
        .insert(vendors)
        .values({
          name: "Ghost Shop " + Date.now(),
          type: "BLACK_MARKET",
          district: "o_fervo",
          isActive: false,
        })
        .returning();

      const accessToken = await registerAndCreateCharacter();
      const res = await fetch(`${base()}/api/vendors`, { headers: authHeader(accessToken) });
      const body = await json<VendorRecord[]>(res);

      expect(body.some((v) => v.id === inactive.id)).toBe(false);
    });

    it("should return 401 without auth", async () => {
      const res = await server.get("/api/vendors");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/vendors/:id", () => {
    it("should return the vendor with its inventory", async () => {
      const accessToken = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/vendors/${staticVendorId}`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(200);
      const body = await json<VendorWithInventory>(res);
      expect(body.vendor.id).toBe(staticVendorId);
      expect(body.inventory).toHaveLength(1);
      expect(body.inventory[0]).toMatchObject({
        itemType: ITEM_TYPE,
        itemId: ITEM_ID,
        price: 100,
        stock: 10,
      });
    });

    it("should return 404 for a non-existent vendor", async () => {
      const accessToken = await registerAndCreateCharacter();

      const res = await fetch(`${base()}/api/vendors/00000000-0000-0000-0000-000000000000`, {
        headers: authHeader(accessToken),
      });

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("VENDOR_NOT_FOUND");
    });

    it("should return 401 without auth", async () => {
      const res = await server.get(`/api/vendors/${staticVendorId}`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/vendors/:id/buy", () => {
    it("should complete a purchase and return the updated balance", async () => {
      const accessToken = await registerAndCreateCharacter();
      const vendorId = await seedVendor({ price: 100, stock: 10 });

      const res = await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 2 },
        authHeader(accessToken),
      );

      expect(res.status).toBe(200);
      const body = await json<BuyResponse>(res);
      expect(body.success).toBe(true);
      expect(body.balanceBefore).toBe(500);
      expect(body.balanceAfter).toBe(300);
      expect(body.item).toEqual({
        itemType: ITEM_TYPE,
        itemId: ITEM_ID,
        quantity: 2,
        unitPrice: 100,
        totalPrice: 200,
      });
    });

    it("should decrement the vendor stock after a purchase", async () => {
      const accessToken = await registerAndCreateCharacter();
      const vendorId = await seedVendor({ price: 100, stock: 10 });

      await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 3 },
        authHeader(accessToken),
      );

      const res = await fetch(`${base()}/api/vendors/${vendorId}`, {
        headers: authHeader(accessToken),
      });
      const body = await json<VendorWithInventory>(res);
      expect(body.inventory[0].stock).toBe(7); // 10 - 3
    });

    it("should return 400 for an invalid body (quantity 0 / negative / non-integer)", async () => {
      const accessToken = await registerAndCreateCharacter();
      const vendorId = await seedVendor();

      for (const body of [
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 0 },
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: -1 },
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 1.5 },
      ]) {
        const res = await server.post(
          `/api/vendors/${vendorId}/buy`,
          body,
          authHeader(accessToken),
        );
        expect(res.status).toBe(400);
        const err = await json<ErrorBody>(res);
        expect(err.error).toBe("VALIDATION_ERROR");
      }
    });

    it("should return 400 INSUFFICIENT_FUNDS when the wallet cannot cover the price", async () => {
      const accessToken = await registerAndCreateCharacter();
      // 8 × 200 = 1600 > 500 seed balance, stock 10 allows the quantity.
      const vendorId = await seedVendor({ price: 200, stock: 10 });

      const res = await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 8 },
        authHeader(accessToken),
      );

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("INSUFFICIENT_FUNDS");
    });

    it("should return 400 OUT_OF_STOCK when the vendor runs out", async () => {
      const accessToken = await registerAndCreateCharacter();
      const vendorId = await seedVendor({ price: 100, stock: 2 });

      const res = await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: ITEM_ID, quantity: 3 },
        authHeader(accessToken),
      );

      expect(res.status).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("OUT_OF_STOCK");
    });

    it("should return 404 for an item not sold by the vendor", async () => {
      const accessToken = await registerAndCreateCharacter();
      const vendorId = await seedVendor();

      const res = await server.post(
        `/api/vendors/${vendorId}/buy`,
        { itemType: ITEM_TYPE, itemId: "ghost-blade", quantity: 1 },
        authHeader(accessToken),
      );

      expect(res.status).toBe(404);
      const body = await json<ErrorBody>(res);
      expect(body.error).toBe("ITEM_NOT_FOUND");
    });

    it("should return 401 without auth", async () => {
      const vendorId = await seedVendor();
      const res = await server.post(`/api/vendors/${vendorId}/buy`, {
        itemType: ITEM_TYPE,
        itemId: ITEM_ID,
        quantity: 1,
      });
      expect(res.status).toBe(401);
    });
  });
});
