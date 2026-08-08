import type { FastifyRequest } from "fastify";
import { AppError } from "./error-handler";
import { trackActiveUser } from "../telemetry/active-tracker";

// Neon Dusk — JWT auth middleware
// ============================================================================
// Verifies the Bearer access token and attaches its payload to `request.user`
// (typed via the FastifyJWT augmentation in lib/auth.ts).

/**
 * Fastify preHandler/onRequest hook: requires a valid access token.
 * Throws AppError(401) when the token is missing, invalid or expired.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Token de acesso ausente, inválido ou expirado");
  }

  // Telemetry (ND-007): mark the user active for 24h. Fire-and-forget — a
  // Redis hiccup must never fail an otherwise valid request.
  void trackActiveUser(request.server.redis, request.user.sub).catch(() => {
    // best-effort telemetry: intentionally silent
  });
}
