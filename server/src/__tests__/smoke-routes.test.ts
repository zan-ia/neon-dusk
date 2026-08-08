/**
 * ND-018: Smoke test — every API route must return a non-5xx status.
 *
 * Creates one player with character, then tests every route (public + JWT-auth
 * + admin auth). Admins use the API key from env. Each route is its own `it`
 * block so failures pinpoint the exact broken endpoint.
 *
 * Workspace: start the test DB/Redis stack (docker-compose.test.yml) before
 * running: `npx vitest run server/src/__tests__/smoke-routes.test.ts`
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { envSchema } from "../env";
import { startTestServer, json, authHeader, resetDb, resetRounds } from "./helpers";
import type { AuthResponse, Character } from "@neon-dusk/shared";
import { seedGigs } from "../db/seed";
import { db } from "../db";
import { users } from "../db/schema";

// DB 0: redis:7-alpine default max 16 databases (0-15)
const REDIS_TEST_DB = "redis://localhost:56379/0";
const PASSWORD = "StrongPass123!";
// ADMIN_KEY matches process.env.ADMIN_API_KEY set by setup.ts
const ADMIN_KEY = "test-admin-key-that-is-at-least-32-characters-long";

let seq = 0;
function uniqueEmail(): string {
  return `smoke-${Date.now()}-${seq++}@neondusk.test`;
}
function uniqueName(): string {
  return `SMK-${Date.now()}-${seq++}`;
}

describe("ND-018 — smoke test (all routes)", () => {
  let app: FastifyInstance;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let auth: AuthResponse;
  let headers: Record<string, string>;
  let adminHeaders: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await resetRounds();

    const redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
    await redis.flushdb();
    redis.disconnect();

    app = await buildApp({ env: envSchema.parse({ ...process.env, REDIS_URL: REDIS_TEST_DB }) });
    server = await startTestServer(app);
    await seedGigs();

    // Register + create character once for JWT tests
    const email = uniqueEmail();
    const regRes = await server.post("/api/auth/register", { email, password: PASSWORD });
    auth = await json<AuthResponse>(regRes);
    headers = authHeader(auth.accessToken);

    const charRes = await server.post(
      "/api/characters",
      {
        name: uniqueName(),
        origin: "a_paraiso",
        role: "solo",
        attributes: { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 },
      },
      headers,
    );
    await json<Character>(charRes);

    // Promote user to admin and re-login to get a JWT with role='admin'.
    await db.update(users).set({ role: "admin" }).where(eq(users.id, auth.user.id));
    const adminLoginRes = await server.post("/api/auth/login", { email, password: PASSWORD });
    const adminAuth = await json<AuthResponse>(adminLoginRes);
    adminHeaders = authHeader(adminAuth.accessToken);
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Health (public) ─────────────────────────────────────────────────────
  it("GET /api/health → 200 (no auth)", async () => {
    const res = await server.get("/api/health");
    expect(res.status).toBe(200);
  });

  // ─── Auth (public + JWT) ─────────────────────────────────────────────────
  it("POST /api/auth/register → 201/409", async () => {
    const res = await server.post("/api/auth/register", {
      email: uniqueEmail(),
      password: PASSWORD,
    });
    expect([201, 409]).toContain(res.status);
  });

  it("POST /api/auth/login → 200/401", async () => {
    const res = await server.post("/api/auth/login", {
      email: "does-not-exist@test.com",
      password: PASSWORD,
    });
    expect([200, 401]).toContain(res.status);
  });

  it("POST /api/auth/refresh → 401 (invalid token)", async () => {
    const res = await server.post("/api/auth/refresh", { refreshToken: "not-a-token" });
    expect([400, 401]).toContain(res.status);
  });

  it("GET /api/auth/me → 200 (JWT)", async () => {
    const res = await server.get("/api/auth/me", headers);
    expect(res.status).toBe(200);
  });

  // ─── Characters (JWT) ────────────────────────────────────────────────────
  it("POST /api/characters → 409 (already has one)", async () => {
    const res = await server.post(
      "/api/characters",
      {
        name: uniqueName(),
        origin: "a_paraiso",
        role: "solo",
        attributes: { body: 5, reflexes: 4, intelligence: 4, technical: 4, cool: 5 },
      },
      headers,
    );
    expect([201, 409]).toContain(res.status);
  });

  // ─── NIL (JWT) ───────────────────────────────────────────────────────────
  it("GET /api/characters/me/nil → 200 (JWT)", async () => {
    const res = await server.get("/api/characters/me/nil", headers);
    expect(res.status).toBe(200);
  });

  // ─── Economy (JWT) ───────────────────────────────────────────────────────
  it("GET /api/economy/balance → 200 (JWT)", async () => {
    const res = await server.get("/api/economy/balance", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/economy/transactions → 200 (JWT)", async () => {
    const res = await server.get("/api/economy/transactions", headers);
    expect(res.status).toBe(200);
  });

  // ─── Vendors (JWT) ───────────────────────────────────────────────────────
  it("GET /api/vendors → 200 (JWT)", async () => {
    const res = await server.get("/api/vendors", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/vendors/:id → 200/404 (JWT)", async () => {
    const res = await server.get(
      `/api/vendors/${"00000000-0000-0000-0000-000000000000"}`,
      headers,
    );
    expect([200, 404]).toContain(res.status);
  });

  // ─── Chrome (JWT) ────────────────────────────────────────────────────────
  it("GET /api/chrome → 200 (JWT)", async () => {
    const res = await server.get("/api/chrome", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/chrome/installed → 200 (JWT)", async () => {
    const res = await server.get("/api/chrome/installed", headers);
    expect(res.status).toBe(200);
  });

  // ─── Gigs (JWT) ──────────────────────────────────────────────────────────
  it("GET /api/gigs → 200 (JWT)", async () => {
    const res = await server.get("/api/gigs", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/gigs/active → 200 (JWT)", async () => {
    const res = await server.get("/api/gigs/active", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/gigs/history → 200 (JWT)", async () => {
    const res = await server.get("/api/gigs/history", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/gigs/:id → 200/404 (JWT)", async () => {
    // Get a real gig ID from the board
    const boardRes = await server.get("/api/gigs", headers);
    const board = await json<{ gigs: Array<{ id: string }> }>(boardRes);
    const gigId = board.gigs[0]?.id ?? "00000000-0000-0000-0000-000000000000";
    const res = await server.get(`/api/gigs/${gigId}`, headers);
    expect([200, 404]).toContain(res.status);
  });

  // ─── Street Cred (JWT + public) ──────────────────────────────────────────
  it("GET /api/street-cred → 200 (JWT)", async () => {
    const res = await server.get("/api/street-cred", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/street-cred/leaderboard → 200 (public)", async () => {
    const res = await server.get("/api/street-cred/leaderboard");
    expect(res.status).toBe(200);
  });

  // ─── PvP (JWT) ───────────────────────────────────────────────────────────
  it("GET /api/pvp/attackable → 200 (JWT)", async () => {
    const res = await server.get("/api/pvp/attackable", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/pvp/history → 200 (JWT)", async () => {
    const res = await server.get("/api/pvp/history", headers);
    expect(res.status).toBe(200);
  });

  // ─── Saideira (JWT) ──────────────────────────────────────────────────────
  it("GET /api/saideira → 200 (JWT)", async () => {
    const res = await server.get("/api/saideira", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/saideira/chat/history → 200 (JWT)", async () => {
    const res = await server.get("/api/saideira/chat/history", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/saideira/legends → 200 (JWT)", async () => {
    const res = await server.get("/api/saideira/legends", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/saideira/leaderboard/crews → 200 (JWT)", async () => {
    const res = await server.get("/api/saideira/leaderboard/crews", headers);
    expect(res.status).toBe(200);
  });

  // ─── Crews (JWT) ─────────────────────────────────────────────────────────
  it("GET /api/crews → 200 (JWT)", async () => {
    const res = await server.get("/api/crews", headers);
    expect(res.status).toBe(200);
  });

  // ─── Round (JWT + admin) ─────────────────────────────────────────────────
  it("GET /api/round → 200 (JWT)", async () => {
    const res = await server.get("/api/round", headers);
    expect(res.status).toBe(200);
  });

  it("GET /api/round/history → 200 (JWT)", async () => {
    const res = await server.get("/api/round/history", headers);
    expect(res.status).toBe(200);
  });

  // ─── Admin routes (JWT rejection + admin acceptance) ─────────────────────
  it("GET /api/admin/players → 401 (no JWT)", async () => {
    const res = await server.get("/api/admin/players");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/players → 403 (non-admin JWT)", async () => {
    const res = await server.get("/api/admin/players", headers);
    expect(res.status).toBe(403);
  });

  it("GET /api/admin/players → 200 (admin JWT)", async () => {
    const res = await server.get("/api/admin/players", adminHeaders);
    expect(res.status).toBe(200);
  });

  it("GET /api/admin/economy → 403 (non-admin JWT)", async () => {
    const res = await server.get("/api/admin/economy", headers);
    expect(res.status).toBe(403);
  });

  it("GET /api/admin/economy → 200 (admin JWT)", async () => {
    const res = await server.get("/api/admin/economy", adminHeaders);
    expect(res.status).toBe(200);
  });

  it("GET /api/admin/transactions → 403 (non-admin JWT)", async () => {
    const res = await server.get("/api/admin/transactions", headers);
    expect(res.status).toBe(403);
  });

  it("GET /api/admin/transactions → 200 (admin JWT)", async () => {
    const res = await server.get("/api/admin/transactions", adminHeaders);
    expect(res.status).toBe(200);
  });

  it("GET /api/admin/params → 403 (non-admin JWT)", async () => {
    const res = await server.get("/api/admin/params", headers);
    expect(res.status).toBe(403);
  });

  it("GET /api/admin/params → 200 (admin JWT)", async () => {
    const res = await server.get("/api/admin/params", adminHeaders);
    expect(res.status).toBe(200);
  });

  it("POST /api/round/trigger-reset → 401 (no x-api-key)", async () => {
    const res = await server.post("/api/round/trigger-reset");
    expect(res.status).toBe(401);
  });

  // ─── Metrics (public) ────────────────────────────────────────────────────
  it("GET /metrics → 200 (public)", async () => {
    const res = await server.get("/metrics");
    expect(res.status).toBe(200);
  });

  // ─── Admin acceptance via x-api-key (round trigger) ──────────────────────
  it("POST /api/round/trigger-reset → 200 (x-api-key)", async () => {
    const res = await server.post("/api/round/trigger-reset", undefined, {
      "x-api-key": ADMIN_KEY,
    });
    expect(res.status).toBe(200);
  });
});
