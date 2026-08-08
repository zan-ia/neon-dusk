import type { FastifyRequest } from "fastify";
import { AppError } from "../middleware/error-handler";
import type { AccessTokenPayload } from "./auth";
import { trackActiveUser } from "../telemetry/active-tracker";

/**
 * Auth for SSE streams. EventSource cannot set Authorization headers, so
 * this accepts the access token as a `?token=` query param (ponytail: MVP —
 * switch to an HTTP-only cookie when the auth system supports it). Prefers
 * the Bearer header when present. Shared by saideira (ND-015) and crews
 * (ND-016).
 */
export async function sseAuthenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  const queryToken = (request.query as { token?: unknown } | null)?.token;
  const token =
    header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : typeof queryToken === "string" && queryToken.length > 0
        ? queryToken
        : undefined;

  if (!token) {
    throw new AppError(401, "UNAUTHORIZED", "Token de acesso ausente, inválido ou expirado");
  }

  try {
    request.user = await request.server.jwt.verify<AccessTokenPayload>(token);
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Token de acesso ausente, inválido ou expirado");
  }

  // Telemetry (ND-007): mark the user active for 24h. Fire-and-forget — a
  // Redis hiccup must never fail an otherwise valid request.
  void trackActiveUser(request.server.redis, request.user.sub).catch(() => {
    // best-effort telemetry: intentionally silent
  });
}
