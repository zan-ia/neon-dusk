import type { FastifyInstance } from "fastify";
import type Redis from "ioredis";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  ChatHistoryResponse,
  ChatMessage,
  CreateCrewResponse,
  CrewDetailResponse,
  CrewInvite,
} from "@neon-dusk/shared";
import {
  CREW_CREATE_COST,
  CREW_CREATE_SC,
  CREW_MAX_SIZE,
  CREW_RECRUIT_SC,
} from "@neon-dusk/shared";
import { authenticate } from "../middleware/auth";
import { checkCircuitBreaker } from "../middleware/circuit-breaker";
import { checkCooldown } from "../middleware/cooldown";
import { validate } from "../middleware/validate";
import { setAuditContext } from "../middleware/audit-middleware";
import { checkActionRateLimit } from "../lib/rate-limit";
import { AppError } from "../middleware/error-handler";
import { escapeHtml } from "../lib/escape-html";
import { sseAuthenticate } from "../lib/sse-auth";
import { db, type Tx } from "../db";
import {
  characterWallets,
  characters,
  crewInvites,
  crewMembers,
  crews,
  transactionLog,
} from "../db/schema";
import { transferEddies } from "../game/economy";
import { calculateCrewBonuses } from "../game/crews";
import { ensureWallet, requireCharacterId } from "../services/economy-service";

// Neon Dusk — Crew routes (ND-016: Crews Básicas, ND-053)
// ============================================================================
// Gang social system: found a crew (5,000 eddies, SC >= 25), invite recruits
// (SC >= 10), join/leave/kick, dissolve, and a members-only real-time chat
// (Redis pub/sub + list, ADR-2 — same shape as the saideira chat, scoped per
// crew). Membership rules are mirrored in the DB (unique character_id, the
// 4-member trigger); the app-level checks are UX, the constraints are law.
//
// ND-053: All POST/DELETE endpoints are guarded by circuit-break, rate-limit,
// and audit logging. Invite also has a 60s cooldown.

export interface CrewRoutesOptions {
  redis: Redis;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createCrewSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Nome deve ter entre 3 e 20 caracteres")
    .max(20, "Nome deve ter entre 3 e 20 caracteres"),
  tag: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{3}$/, "Tag deve ter exatamente 3 letras ou números"),
});

const inviteSchema = z.object({
  characterId: z.string().uuid("characterId deve ser um UUID válido"),
});

const chatSendSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Mensagem não pode estar vazia")
    .max(500, "Mensagem muito longa (máx. 500 caracteres)"),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // invites expire after 24h
const CHAT_HISTORY_MAX = 50;
const SSE_KEEPALIVE_MS = 30_000;

const chatChannel = (crewId: string) => `crew:${crewId}:chat`;
const chatHistoryKey = (crewId: string) => `crew:${crewId}:chat:history`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a crew or throw AppError(404). */
async function getCrew(crewId: string): Promise<typeof crews.$inferSelect> {
  const [crew] = await db.select().from(crews).where(eq(crews.id, crewId)).limit(1);
  if (!crew) throw new AppError(404, "CREW_NOT_FOUND", "Crew não encontrada");
  return crew;
}

/** Count current members (the DB trigger enforces the hard cap). */
async function memberCount(tx: Tx | typeof db, crewId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crewMembers)
    .where(eq(crewMembers.crewId, crewId));
  return row?.n ?? 0;
}

/** Throw AppError(403) unless the character is a crew member. */
async function requireMember(crewId: string, characterId: string): Promise<void> {
  const [member] = await db
    .select({ id: crewMembers.id })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.characterId, characterId)))
    .limit(1);
  if (!member) throw new AppError(403, "NOT_CREW_MEMBER", "Você não é membro desta crew");
}

/** Throw AppError(403) unless the character is the crew leader. */
function requireLeader(crew: { leaderId: string }, characterId: string): void {
  if (crew.leaderId !== characterId) {
    throw new AppError(403, "NOT_CREW_LEADER", "Apenas o líder da crew pode fazer isso");
  }
}

/** Nullify `crew_id` on a character (leave / kick / dissolve). */
async function clearMembership(tx: Tx, characterId: string): Promise<void> {
  await tx
    .update(characters)
    .set({ crewId: null, updatedAt: new Date() })
    .where(eq(characters.id, characterId));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function crewRoutes(app: FastifyInstance, opts: CrewRoutesOptions) {
  const { redis } = opts;

  // POST /api/crews — found a crew (5,000 eddies + SC >= 25).
  app.post(
    "/crews",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_invite"),
        checkCircuitBreaker(redis),
        validate(createCrewSchema),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply): Promise<CreateCrewResponse> => {
      const { name, tag } = request.body as z.infer<typeof createCrewSchema>;
      const characterId = await requireCharacterId(request.user.sub);

      request.audit_context!.payload = { name, tag };

      // Eligibility: SC gate + already-affiliated guard (one crew per char).
      const [leader] = await db
        .select({ name: characters.name, streetCred: characters.streetCred, crewId: characters.crewId })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1);
      if (!leader) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");
      if (leader.crewId) throw new AppError(409, "ALREADY_IN_CREW", "Você já está em uma crew");
      if (leader.streetCred < CREW_CREATE_SC) {
        throw new AppError(
          400,
          "SC_TOO_LOW",
          `Fundar uma crew requer ${CREW_CREATE_SC} de Street Cred (você tem ${leader.streetCred})`,
        );
      }
      // One transaction: debit wallet (optimistic lock, audit entry), reject
      // duplicate name/tag inside the tx (friendly 409 instead of the DB unique
      // constraint's opaque 500 — the constraints still backstop a concurrent
      // race, and a race loses by committing first).
      const { crew, member } = await db.transaction(async (tx) => {
        const wallet = await ensureWallet(characterId, tx);
        const availableFunds = wallet.balance - wallet.escrow;
        if (availableFunds < CREW_CREATE_COST) {
          throw new AppError(
            400,
            "INSUFFICIENT_FUNDS",
            `Fundar uma crew custa ${CREW_CREATE_COST} eddies (você tem ${availableFunds})`,
          );
        }
        const [dupName] = await tx
          .select({ id: crews.id })
          .from(crews)
          .where(eq(crews.name, name))
          .limit(1);
        if (dupName) throw new AppError(409, "DUPLICATE_NAME", "Já existe uma crew com este nome");
        const [dupTag] = await tx
          .select({ id: crews.id })
          .from(crews)
          .where(eq(crews.tag, tag))
          .limit(1);
        if (dupTag) throw new AppError(409, "DUPLICATE_TAG", "Já existe uma crew com esta tag");
        const debit = transferEddies(wallet, -CREW_CREATE_COST, {
          type: "CREW_CREATION",
          source: `Crew creation (${name} [${tag}])`,
        });
        const [updatedWallet] = await tx
          .update(characterWallets)
          .set({
            balance: debit.wallet.balance,
            lifetimeSpent: debit.wallet.lifetimeSpent,
            version: wallet.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(characterWallets.characterId, characterId),
              eq(characterWallets.version, wallet.version),
            ),
          )
          .returning();
        if (!updatedWallet) {
          throw new AppError(
            409,
            "CONCURRENCY_CONFLICT",
            "Modificação concorrente detectada. Tente novamente.",
          );
        }
        await tx.insert(transactionLog).values({
          characterId,
          type: "CREW_CREATION",
          amount: debit.transaction.amount,
          balanceBefore: debit.transaction.balanceBefore,
          balanceAfter: debit.transaction.balanceAfter,
          source: debit.transaction.source,
        });

        const [crew] = await tx
          .insert(crews)
          .values({ name, tag, leaderId: characterId })
          .returning();
        const [member] = await tx
          .insert(crewMembers)
          .values({ crewId: crew.id, characterId })
          .returning();
        await tx
          .update(characters)
          .set({ crewId: crew.id, updatedAt: new Date() })
          .where(eq(characters.id, characterId));
        return { crew, member };
      });

      return reply.status(201).send({
        crew: {
          id: crew.id,
          name: crew.name,
          tag: crew.tag,
          leaderId: crew.leaderId,
          createdAt: crew.createdAt.toISOString(),
        },
        member: {
          id: member.id,
          characterId,
          characterName: leader.name,
          streetCred: leader.streetCred,
          joinedAt: member.joinedAt.toISOString(),
        },
      });
    },
  );

  // GET /api/crews — list all crews (name, tag, leader, member count).
  app.get(
    "/crews",
    { preHandler: [authenticate] },
    async (): Promise<Array<{ id: string; name: string; tag: string; leaderId: string; memberCount: number }>> => {
      const rows = await db
        .select({
          id: crews.id,
          name: crews.name,
          tag: crews.tag,
          leaderId: crews.leaderId,
          memberCount: sql<number>`(
            SELECT count(*)::int FROM ${crewMembers} WHERE ${crewMembers.crewId} = ${crews.id}
          )`,
        })
        .from(crews)
        .orderBy(crews.createdAt);

      return rows;
    },
  );

  // GET /api/crews/:id — crew details (members, bonuses, ranking).
  app.get(
    "/crews/:id",
    { preHandler: [authenticate] },
    async (request): Promise<CrewDetailResponse> => {
      const crewId = (request.params as { id: string }).id;
      const crew = await getCrew(crewId);

      const memberRows = await db
        .select({
          id: crewMembers.id,
          characterId: crewMembers.characterId,
          characterName: characters.name,
          streetCred: characters.streetCred,
          joinedAt: crewMembers.joinedAt,
        })
        .from(crewMembers)
        .innerJoin(characters, eq(characters.id, crewMembers.characterId))
        .where(eq(crewMembers.crewId, crewId))
        .orderBy(crewMembers.joinedAt);

      const bonuses = calculateCrewBonuses(memberRows.length);

      // ponytail: materialize the whole ranking (O(crews)) — MVP scale is a
      // handful of crews; revisit with a window function if it grows.
      const ranked = await db
        .select({
          id: crews.id,
          totalSC: sql<number>`COALESCE(SUM(${characters.streetCred}), 0)::int`,
        })
        .from(crews)
        .leftJoin(crewMembers, eq(crewMembers.crewId, crews.id))
        .leftJoin(characters, eq(characters.id, crewMembers.characterId))
        .groupBy(crews.id)
        .orderBy(desc(sql`COALESCE(SUM(${characters.streetCred}), 0)`));
      const position = ranked.findIndex((row) => row.id === crewId);
      const leaderboardPosition = position === -1 ? null : position + 1;

      return {
        crew: {
          id: crew.id,
          name: crew.name,
          tag: crew.tag,
          leaderId: crew.leaderId,
          createdAt: crew.createdAt.toISOString(),
        },
        members: memberRows.map((member) => ({
          ...member,
          joinedAt: member.joinedAt.toISOString(),
        })),
        bonuses,
        leaderboardPosition,
      };
    },
  );

  // POST /api/crews/:id/invite — leader invites a recruit (SC >= 10).
  app.post(
    "/crews/:id/invite",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_invite"),
        checkCircuitBreaker(redis),
        checkCooldown(redis, "crew_invite"),
        validate(inviteSchema),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply): Promise<CrewInvite> => {
      const crewId = (request.params as { id: string }).id;
      const { characterId: targetId } = request.body as z.infer<typeof inviteSchema>;
      const characterId = await requireCharacterId(request.user.sub);

      request.audit_context!.payload = { crewId, targetCharacterId: targetId };

      const crew = await getCrew(crewId);
      requireLeader(crew, characterId);
      if ((await memberCount(db, crewId)) >= CREW_MAX_SIZE) {
        throw new AppError(409, "CREW_FULL", `Crew cheia (máx. ${CREW_MAX_SIZE} membros)`);
      }

      const [target] = await db
        .select({ id: characters.id, streetCred: characters.streetCred, crewId: characters.crewId })
        .from(characters)
        .where(eq(characters.id, targetId))
        .limit(1);
      if (!target) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");
      if (target.crewId) throw new AppError(409, "ALREADY_IN_CREW", "Este personagem já está em uma crew");
      if (target.streetCred < CREW_RECRUIT_SC) {
        throw new AppError(
          400,
          "SC_TOO_LOW",
          `Recrutas precisam de pelo menos ${CREW_RECRUIT_SC} de Street Cred`,
        );
      }

      // One pending invite per (crew, character): reject a live duplicate,
      // replace an expired one (the unique constraint would reject the row).
      const [existing] = await db
        .select({ id: crewInvites.id, expiresAt: crewInvites.expiresAt })
        .from(crewInvites)
        .where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.characterId, targetId)))
        .limit(1);
      if (existing) {
        if (existing.expiresAt > new Date()) {
          throw new AppError(409, "ALREADY_INVITED", "Este personagem já foi convidado");
        }
        await db.delete(crewInvites).where(eq(crewInvites.id, existing.id));
      }

      const [invite] = await db
        .insert(crewInvites)
        .values({
          crewId,
          characterId: targetId,
          invitedBy: characterId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning();
      if (!invite) throw new AppError(500, "INVITE_FAILED", "Não foi possível criar o convite");

      // Set cooldown AFTER success (ADR-2) — 60s.
      await redis.setex(`cooldown:${characterId}:crew_invite`, 60, "1");

      return reply.status(201).send({
        id: invite.id,
        crewId: invite.crewId,
        characterId: invite.characterId,
        invitedBy: invite.invitedBy,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
      });
    },
  );

  // POST /api/crews/:id/join — accept an invite.
  app.post(
    "/crews/:id/join",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_join"),
        checkCircuitBreaker(redis),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply): Promise<CrewDetailResponse["members"][number]> => {
      const crewId = (request.params as { id: string }).id;
      const characterId = await requireCharacterId(request.user.sub);

      request.audit_context!.payload = { crewId };

      const { member, target } = await db.transaction(async (tx) => {
        const [invite] = await tx
          .select()
          .from(crewInvites)
          .where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.characterId, characterId)))
          .limit(1);
        if (!invite) throw new AppError(404, "NO_INVITE", "Você não tem um convite para esta crew");
        if (invite.expiresAt <= new Date()) {
          throw new AppError(410, "INVITE_EXPIRED", "Convite expirado — peça um novo");
        }
        if ((await memberCount(tx, crewId)) >= CREW_MAX_SIZE) {
          throw new AppError(409, "CREW_FULL", `Crew cheia (máx. ${CREW_MAX_SIZE} membros)`);
        }
        // Guard against joining a second crew (unique character_id backstops).
        const [target] = await tx
          .select({ id: characters.id, name: characters.name, streetCred: characters.streetCred })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1);
        if (!target) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");

        const [member] = await tx
          .insert(crewMembers)
          .values({ crewId, characterId })
          .returning();
        await tx.delete(crewInvites).where(eq(crewInvites.id, invite.id));
        await tx
          .update(characters)
          .set({ crewId, updatedAt: new Date() })
          .where(eq(characters.id, characterId));

        return { member, target };
      });

      // Send AFTER the transaction commits: the client must not see a 201
      // before characters.crew_id is durable (read-after-write visibility).
      return reply.status(201).send({
        id: member.id,
        characterId,
        characterName: target.name,
        streetCred: target.streetCred,
        joinedAt: member.joinedAt.toISOString(),
      });
    },
  );

  // POST /api/crews/:id/leave — quit (leader must dissolve instead).
  app.post(
    "/crews/:id/leave",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_leave"),
        checkCircuitBreaker(redis),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply) => {
      const crewId = (request.params as { id: string }).id;
      const characterId = await requireCharacterId(request.user.sub);
      const crew = await getCrew(crewId);

      request.audit_context!.payload = { crewId };

      if (crew.leaderId === characterId) {
        throw new AppError(400, "LEADER_CANNOT_LEAVE", "O líder deve dissolver a crew para sair");
      }
      await requireMember(crewId, characterId);

      await db.transaction(async (tx) => {
        await tx
          .delete(crewMembers)
          .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.characterId, characterId)));
        await clearMembership(tx, characterId);
      });

      return reply.status(204).send();
    },
  );

  // DELETE /api/crews/:id/members/:characterId — leader kicks a member.
  app.delete(
    "/crews/:id/members/:characterId",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_kick"),
        checkCircuitBreaker(redis),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply) => {
      const { id: crewId, characterId: targetId } = request.params as {
        id: string;
        characterId: string;
      };
      const characterId = await requireCharacterId(request.user.sub);
      const crew = await getCrew(crewId);

      request.audit_context!.payload = { crewId, targetCharacterId: targetId };

      requireLeader(crew, characterId);
      if (targetId === crew.leaderId) {
        throw new AppError(400, "CANNOT_KICK_LEADER", "Não é possível remover o líder");
      }
      await requireMember(crewId, targetId);

      await db.transaction(async (tx) => {
        await tx
          .delete(crewMembers)
          .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.characterId, targetId)));
        await clearMembership(tx, targetId);
      });

      return reply.status(204).send();
    },
  );

  // DELETE /api/crews/:id — dissolve the crew (leader only).
  app.delete(
    "/crews/:id",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_dissolve"),
        checkCircuitBreaker(redis),
        checkActionRateLimit(redis, "crew_invite"),
      ],
    },
    async (request, reply) => {
      const crewId = (request.params as { id: string }).id;
      const characterId = await requireCharacterId(request.user.sub);
      const crew = await getCrew(crewId);

      request.audit_context!.payload = { crewId };

      requireLeader(crew, characterId);

      await db.transaction(async (tx) => {
        await tx.update(characters).set({ crewId: null, updatedAt: new Date() }).where(eq(characters.crewId, crewId));
        await tx.delete(crewInvites).where(eq(crewInvites.crewId, crewId));
        await tx.delete(crewMembers).where(eq(crewMembers.crewId, crewId));
        await tx.delete(crews).where(eq(crews.id, crewId));
      });
      await redis.del(chatHistoryKey(crewId));

      return reply.status(204).send();
    },
  );

  // GET /api/crews/:id/chat/history — last 50 messages, oldest first.
  app.get(
    "/crews/:id/chat/history",
    { preHandler: [authenticate] },
    async (request): Promise<ChatHistoryResponse> => {
      const crewId = (request.params as { id: string }).id;
      const characterId = await requireCharacterId(request.user.sub);
      await requireMember(crewId, characterId);

      const raw = await redis.lrange(chatHistoryKey(crewId), 0, CHAT_HISTORY_MAX - 1);
      const messages = raw.map((m) => JSON.parse(m) as ChatMessage).reverse();
      return { messages };
    },
  );

  // POST /api/crews/:id/chat — send a message (1 msg / 5s per member via the
  // chat_message cooldown, same gate as the saideira chat — ND-053).
  app.post(
    "/crews/:id/chat",
    {
      preHandler: [
        authenticate,
        setAuditContext("crew_chat"),
        checkCircuitBreaker(redis),
        checkActionRateLimit(redis, "saideira_chat"),
        checkCooldown(redis, "chat_message"),
        validate(chatSendSchema),
      ],
    },
    async (request, reply): Promise<ChatMessage> => {
      const crewId = (request.params as { id: string }).id;
      const { message } = request.body as z.infer<typeof chatSendSchema>;
      const characterId = await requireCharacterId(request.user.sub);
      const crew = await getCrew(crewId);
      await requireMember(crewId, characterId);

      request.audit_context!.payload = { crewId, messageLength: message.length };

      const [char] = await db
        .select({ name: characters.name })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1);
      if (!char) throw new AppError(404, "NO_CHARACTER", "Personagem não encontrado");

      const chatMessage: ChatMessage = {
        id: randomUUID(),
        characterName: char.name,
        crewTag: crew.tag,
        message: escapeHtml(message),
        createdAt: new Date().toISOString(),
      };
      const payload = JSON.stringify(chatMessage);

      await redis.publish(chatChannel(crewId), payload);
      await redis.lpush(chatHistoryKey(crewId), payload);
      await redis.ltrim(chatHistoryKey(crewId), 0, CHAT_HISTORY_MAX - 1);

      // Set cooldown AFTER success (ADR-2) — 5s.
      await redis.setex(`cooldown:${characterId}:chat_message`, 5, "1");

      return reply.status(201).send(chatMessage);
    },
  );

  // GET /api/crews/:id/chat/stream — SSE stream (members only).
  // Uses reply.raw + reply.hijack() (ADR-1): Fastify serialization is bypassed.
  app.get("/crews/:id/chat/stream", { preHandler: [sseAuthenticate] }, async (request, reply) => {
    const crewId = (request.params as { id: string }).id;
    const characterId = await requireCharacterId(request.user.sub);
    await requireMember(crewId, characterId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx: do not buffer
    });
    reply.raw.write(":ok\n\n"); // SSE handshake — client knows it connected

    let subscriber: Redis | null = null;
    try {
      subscriber = redis.duplicate();
      await subscriber.subscribe(chatChannel(crewId));
    } catch (err) {
      if (subscriber) void subscriber.quit();
      request.log.error(err, "crews: SSE subscriber setup failed");
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ error: "Chat stream unavailable — tente novamente" })}\n\n`,
      );
      reply.raw.end();
      reply.hijack();
      return;
    }

    subscriber.on("message", (_channel, msg) => {
      reply.raw.write(`data: ${msg}\n\n`);
    });

    const ping = setInterval(() => {
      reply.raw.write(":ping\n\n");
    }, SSE_KEEPALIVE_MS);

    request.raw.on("close", () => {
      clearInterval(ping);
      void subscriber.unsubscribe(chatChannel(crewId));
      void subscriber.quit();
    });

    reply.hijack();
  });
}
