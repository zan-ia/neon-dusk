import type { FastifyRequest } from "fastify";
import { AppError } from "./error-handler";
import { env } from "../env";

// Neon Dusk — Admin auth middleware (ND-007 + ND-052)
// ============================================================================
// Two admin auth strategies (ADR-1: JWT role primary, x-api-key fallback):
//
// 1. `requireAdminApiKey` — x-api-key header (existing ND-007 endpoints).
// 2. `requireAdminRole` — JWT role === "admin" (new ND-052 admin panel).

/**
 * PreHandler: requires a valid `x-api-key` header matching ADMIN_API_KEY.
 * Throws AppError(401) when missing or mismatched.
 */
export async function requireAdminApiKey(request: FastifyRequest): Promise<void> {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey !== "string" || apiKey !== env.ADMIN_API_KEY) {
    throw new AppError(401, "UNAUTHORIZED", "Chave de API admin inválida");
  }
}

/** @deprecated Use `requireAdminApiKey` instead. */
export { requireAdminApiKey as requireAdmin };

/**
 * PreHandler: requires the JWT to carry role === "admin".
 * Must run AFTER @fastify/jwt's `authenticate` preHandler.
 * Throws AppError(403) when the user is not an admin.
 */
export async function requireAdminRole(request: FastifyRequest): Promise<void> {
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Acesso admin necessário");
  }
}
