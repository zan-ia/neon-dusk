import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { AppError } from "../middleware/error-handler";
import { setRateLimitHeaders } from "./headers";

// Neon Dusk — Redis-backed rate limiting (ND-053 refactored)
// ============================================================================
// The global @fastify/rate-limit guards every route by IP; these counters add
// per-character, per-action limits. The old `checkRateLimit` is kept for
// backward compatibility (login, registration).

/** All rate-limited action types. */
export type ActionType =
  | "gig_accept"
  | "gig_execute"
  | "gig_submit"
  | "pvp_attack"
  | "saideira_chat"
  | "crew_invite"
  | "chrome_install"
  | "chrome_uninstall"
  | "economy_transact"
  | "character_create"
  | "vendor_purchase"
  | "stim_use";

/** Per-action rate limit configuration. */
export interface RateLimitEntry {
  max: number;
  windowMs: number;
}

/** The master rate limit config — per-action caps. */
export const rateLimitConfig: Record<ActionType, RateLimitEntry> = {
  gig_accept:       { max: 10, windowMs: 60_000 },
  gig_execute:      { max: 10, windowMs: 60_000 },
  gig_submit:       { max: 10, windowMs: 60_000 },
  pvp_attack:       { max: 3,  windowMs: 3_600_000 },
  saideira_chat:    { max: 12, windowMs: 60_000 },
  crew_invite:      { max: 5,  windowMs: 60_000 },
  chrome_install:   { max: 5,  windowMs: 60_000 },
  chrome_uninstall: { max: 5,  windowMs: 60_000 },
  economy_transact: { max: 20, windowMs: 60_000 },
  character_create: { max: 3,  windowMs: 3_600_000 },
  vendor_purchase:  { max: 10, windowMs: 60_000 },
  stim_use:         { max: 5,  windowMs: 300_000 },
} as const;

// Circuit-break constants
const CB_COUNT_TTL_SECONDS = 3600;    // 1h window for counting strikes
const CB_BAN_TTL_SECONDS = 86_400;    // 24h ban
const CB_STRIKE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Legacy — generic per-key rate limit (kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Enforce a per-key rate limit using a Redis INCR + EXPIRE counter.
 * Throws AppError(429) when the limit is exceeded within the window.
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const counterKey = `auth:rl:${key}`;

  // Atomic INCR + EXPIRE in one multi.
  const results = await redis.multi().incr(counterKey).expire(counterKey, Math.ceil(windowMs / 1000)).exec();
  if (results === null) {
    // ponytail: Redis unavailable — fail open, don't block the user
    console.warn("Rate limiter: Redis unavailable, allowing request");
    return;
  }
  const count = results[0][1] as number;

  if (count > max) {
    const retryAfter = Math.ceil(windowMs / 1000);
    throw new AppError(429, "RATE_LIMITED", "Muitas tentativas. Tente novamente mais tarde.", { retryAfter });
  }
}

// ---------------------------------------------------------------------------
// Per-character, per-action rate limit (ND-053)
// ---------------------------------------------------------------------------

/**
 * Returns a preHandler that enforces a per-character, per-action rate limit.
 *
 * On success: sets X-RateLimit-Remaining and X-RateLimit-Reset headers.
 * On limit exceeded: increments the circuit-break counter (3 strikes = 24h ban),
 * then throws AppError(429, "RATE_LIMITED").
 */
export function checkActionRateLimit(
  redis: Redis,
  actionType: ActionType,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const config = rateLimitConfig[actionType];

  return async (request, reply) => {
    const userId = request.user.sub;
    const key = `rate:${userId}:${actionType}`;
    const windowSeconds = Math.ceil(config.windowMs / 1000);

    // Atomic INCR + EXPIRE.
    const results = await redis.multi().incr(key).expire(key, windowSeconds).exec();
    if (results === null) {
      // ponytail: Redis unavailable — fail open
      console.warn("[rate-limit] Redis unavailable, allowing request");
      return;
    }
    const count = results[0][1] as number;

    if (count <= config.max) {
      setRateLimitHeaders(reply, config.max - count, config.windowMs);
      return;
    }

    // --- RATE LIMIT EXCEEDED ---

    // Tag audit context before throwing.
    if (request.audit_context) {
      request.audit_context.result = "rate_limited";
    }

    // Increment circuit-break strike counter.
    const cbKey = `cb_count:${userId}`;
    const cbResults = await redis.multi().incr(cbKey).expire(cbKey, CB_COUNT_TTL_SECONDS).exec();
    const cbHits = cbResults !== null ? (cbResults[0][1] as number) : 0;

    if (cbHits >= CB_STRIKE_THRESHOLD) {
      await redis.setex(
        `circuit_break:${userId}`,
        CB_BAN_TTL_SECONDS,
        "1",
      );
      throw new AppError(
        429,
        "CIRCUIT_BREAK",
        "Sistema neural sobrecarregado. Retorne em 24 horas.",
        { retryAfter: CB_BAN_TTL_SECONDS },
      );
    }

    const retryAfterSec = windowSeconds;
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Muitas requisições. Aguarde.",
      { retryAfter: retryAfterSec },
    );
  };
}
