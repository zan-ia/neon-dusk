import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { ATTRIBUTE_KEYS, ATTR_TOTAL, MAX_ATTR, MIN_ATTR, ORIGINS, ROLES } from "@neon-dusk/shared";
import type { Character } from "@neon-dusk/shared";
import { db } from "../db";
import { characters } from "../db/schema";
import { AppError } from "../middleware/error-handler";
import { toPublicCharacter } from "../lib/transformers";

// Neon Dusk — Character service
// ============================================================================

export const createCharacterSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(24, "Name must be at most 24 characters"),
  origin: z.enum(ORIGINS),
  role: z.enum(ROLES),
  attributes: z.object({
    body: z.number().int().min(MIN_ATTR).max(MAX_ATTR),
    reflexes: z.number().int().min(MIN_ATTR).max(MAX_ATTR),
    intelligence: z.number().int().min(MIN_ATTR).max(MAX_ATTR),
    technical: z.number().int().min(MIN_ATTR).max(MAX_ATTR),
    cool: z.number().int().min(MIN_ATTR).max(MAX_ATTR),
  }),
});

export type CreateCharacterInput = z.infer<typeof createCharacterSchema>;

/** Create the user's single character. One user ↔ one character per round. */
export async function createCharacter(
  userId: string,
  input: CreateCharacterInput,
): Promise<Character> {
  const attrs = input.attributes;
  const total = ATTRIBUTE_KEYS.reduce((sum, key) => sum + attrs[key], 0);
  if (total !== ATTR_TOTAL) {
    throw new AppError(
      400,
      "INVALID_ATTRIBUTES",
      `Total de atributos deve ser exatamente ${ATTR_TOTAL} (atualmente ${total})`,
    );
  }

  const existing = await db.select().from(characters).where(eq(characters.userId, userId)).limit(1);
  if (existing.length) {
    throw new AppError(409, "CHARACTER_EXISTS", "Você já tem um personagem");
  }

  const nameTaken = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(sql`lower(${characters.name})`, input.name.trim().toLowerCase()))
    .limit(1);
  if (nameTaken.length) {
    throw new AppError(409, "NAME_TAKEN", "Esse nome já está em uso");
  }

  try {
    const [row] = await db
      .insert(characters)
      .values({
        userId,
        name: input.name.trim(),
        origin: input.origin,
        role: input.role,
        ...attrs,
      })
      .returning();
    return toPublicCharacter(row);
  } catch (err) {
    // Safety net for the case-insensitive unique name index (lower(name)).
    if (isUniqueViolation(err)) {
      throw new AppError(409, "NAME_TAKEN", "Esse nome já está em uso");
    }
    throw err;
  }
}

/** Detect Postgres unique violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
