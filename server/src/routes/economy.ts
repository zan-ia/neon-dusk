import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EconomyBalanceResponse, TransactionListResponse } from "@neon-dusk/shared";
import { authenticate } from "../middleware/auth";
import { getTransactions, getWallet, requireCharacterId } from "../services/economy-service";

// Neon Dusk — Economy routes (wallet balance + transaction history)
// ============================================================================
// Both endpoints resolve the caller's character from their JWT sub claim.
// The wallet auto-seeds (500 eddies) on first read, so a fresh character
// never hits a missing-wallet edge case.

export async function economyRoutes(app: FastifyInstance) {
  // GET /api/economy/balance
  app.get("/economy/balance", { preHandler: [authenticate] }, async (request) => {
    const characterId = await requireCharacterId(request.user.sub);
    const wallet = await getWallet(characterId);
    const response: EconomyBalanceResponse = {
      balance: wallet.balance,
      escrow: wallet.escrow,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeSpent: wallet.lifetimeSpent,
    };
    return response;
  });

  // GET /api/economy/transactions
  app.get("/economy/transactions", { preHandler: [authenticate] }, async (request) => {
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      // cursor is a page's last createdAt, ISO 8601 (see getTransactions)
      cursor: z.string().datetime().optional(),
    });
    const query = querySchema.parse(request.query);

    const characterId = await requireCharacterId(request.user.sub);
    const result = await getTransactions(characterId, query.limit, query.cursor);
    return result as TransactionListResponse;
  });
}
