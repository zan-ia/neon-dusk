import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { checkCooldown, cooldownConfig } from "../middleware/cooldown";
import { insertTestCharacter, resetDb } from "./helpers";

// ND-053 — action cooldown gate (checkCooldown). Unit tests against a
// dedicated redis db (14). The middleware CHECKS the key (keyed by the DB
// character id resolved via requireCharacterId — NOT the JWT sub); the route
// handler sets it after success (ADR-2) — tests set it directly to simulate.
// A real user+character row is required: requireCharacterId throws
// NO_CHARACTER for a sub without a character.

const REDIS_TEST_DB = "redis://localhost:56379/14"; // shared with crews-api (sequential fork, self-flushed)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requestFor(userId: string, auditContext: Record<string, unknown> = {}) {
  return { user: { sub: userId }, audit_context: auditContext } as unknown as FastifyRequest;
}

describe("checkCooldown (anti-cheat cooldown gate)", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
  });

  beforeEach(async () => {
    await resetDb();
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("should allow the first request when no cooldown key exists", async () => {
    const { userId } = await insertTestCharacter();
    const preHandler = checkCooldown(redis, "gig_accept");

    await expect(preHandler(requestFor(userId))).resolves.toBeUndefined();
  });

  it("should reject with 429 COOLDOWN_ACTIVE and Retry-After within the window", async () => {
    const { userId, characterId } = await insertTestCharacter();
    const preHandler = checkCooldown(redis, "gig_accept");

    // Route handler sets the key after a successful action (ADR-2), keyed by
    // the DB character id — the same id requireCharacterId resolves.
    await redis.setex(`cooldown:${characterId}:gig_accept`, cooldownConfig.gig_accept.durationMs / 1000, "1");

    const auditContext = {};
    await expect(preHandler(requestFor(userId, auditContext))).rejects.toMatchObject({
      statusCode: 429,
      code: "COOLDOWN_ACTIVE",
      message: "Ação em cooldown. Aguarde.",
      details: { retryAfter: expect.any(Number) },
    });
    // ND-053: the middleware tags the audit context before throwing.
    expect(auditContext).toEqual({ result: "cooldown_active" });
  });

  it("should allow the request again after the cooldown expires", async () => {
    const { userId, characterId } = await insertTestCharacter();
    const preHandler = checkCooldown(redis, "gig_accept");

    await redis.setex(`cooldown:${characterId}:gig_accept`, 1, "1");
    await expect(preHandler(requestFor(userId))).rejects.toMatchObject({
      code: "COOLDOWN_ACTIVE",
    });

    await sleep(1_100); // key TTL is 1s — wait for natural expiry

    await expect(preHandler(requestFor(userId))).resolves.toBeUndefined();
  });

  it("should keep cooldowns independent across different actions", async () => {
    const { userId, characterId } = await insertTestCharacter();
    const gigPreHandler = checkCooldown(redis, "gig_accept");
    const chatPreHandler = checkCooldown(redis, "chat_message");

    await redis.setex(`cooldown:${characterId}:gig_accept`, 30, "1");

    // gig_accept is on cooldown…
    await expect(gigPreHandler(requestFor(userId))).rejects.toMatchObject({
      code: "COOLDOWN_ACTIVE",
    });

    // …but chat_message has its own independent key → passes.
    await expect(chatPreHandler(requestFor(userId))).resolves.toBeUndefined();
  });

  it("should reject with 404 NO_CHARACTER when the user has no character", async () => {
    const preHandler = checkCooldown(redis, "gig_accept");

    // requireCharacterId runs before the Redis check — a sub without a
    // character must be rejected, not silently allowed.
    await expect(preHandler(requestFor(randomUUID()))).rejects.toMatchObject({
      statusCode: 404,
      code: "NO_CHARACTER",
      message: "Crie um personagem primeiro",
    });
  });

  it("should fail open when Redis is unavailable (exists throws)", async () => {
    const { userId } = await insertTestCharacter();
    const deadRedis = {
      exists: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as Redis;

    const preHandler = checkCooldown(deadRedis, "gig_accept");
    await expect(preHandler(requestFor(userId))).resolves.toBeUndefined();
  });
});
