import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { checkCircuitBreaker } from "../middleware/circuit-breaker";

// ND-053 — 3-strikes circuit-breaker gate (checkCircuitBreaker). Unit tests
// against a dedicated redis db (15). The ban key (`circuit_break:{characterId}`)
// is per-character, NOT per-action (ADR-4) — once set, every action throws.

const REDIS_TEST_DB = "redis://localhost:56379/15"; // shared with round-api (sequential fork, self-flushed)

function requestFor(characterId: string) {
  return { user: { sub: characterId }, audit_context: {} } as unknown as FastifyRequest;
}

describe("checkCircuitBreaker (anti-cheat circuit breaker)", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_TEST_DB, { lazyConnect: true });
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("should allow the request when no circuit_break key exists", async () => {
    const characterId = randomUUID();
    const preHandler = checkCircuitBreaker(redis);

    await expect(preHandler(requestFor(characterId))).resolves.toBeUndefined();
  });

  it("should reject with 429 CIRCUIT_BREAK and a neural-overload message", async () => {
    const characterId = randomUUID();
    const preHandler = checkCircuitBreaker(redis);

    await redis.setex(`circuit_break:${characterId}`, 86_400, "1");
    const ttl = await redis.ttl(`circuit_break:${characterId}`);

    const auditContext = {};
    const request = {
      user: { sub: characterId },
      audit_context: auditContext,
    } as unknown as FastifyRequest;

    await expect(preHandler(request)).rejects.toMatchObject({
      statusCode: 429,
      code: "CIRCUIT_BREAK",
      message: expect.stringMatching(/Sistema neural sobrecarregado/),
      details: { retryAfter: ttl },
    });
    expect(auditContext).toEqual({ result: "circuit_break" });
  });

  it("should block ALL actions for a banned character (not just the triggering one)", async () => {
    const characterId = randomUUID();
    await redis.setex(`circuit_break:${characterId}`, 86_400, "1");

    // Two breaker instances that would guard different routes — both must
    // reject, because the ban key carries no action component.
    const chatGuard = checkCircuitBreaker(redis);
    const pvpGuard = checkCircuitBreaker(redis);

    await expect(chatGuard(requestFor(characterId))).rejects.toMatchObject({
      code: "CIRCUIT_BREAK",
    });
    await expect(pvpGuard(requestFor(characterId))).rejects.toMatchObject({
      code: "CIRCUIT_BREAK",
    });
  });

  it("should fail open when Redis is unavailable (ttl throws)", async () => {
    const deadRedis = {
      ttl: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Redis;

    const preHandler = checkCircuitBreaker(deadRedis);
    await expect(preHandler(requestFor(randomUUID()))).resolves.toBeUndefined();
  });
});
