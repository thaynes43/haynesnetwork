import { users, userTags, tags, permissionAudit, type DbClient } from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

export interface SetFamilyDesignationInput {
  db?: DbClient;
  userId: string;
  isFamily: boolean;
  /** Acting admin's user id; null = system. */
  actorId: string | null;
}

/**
 * DESIGN-001 D-12 — single writer for users.is_family (the DIRECT family designation).
 * Audits 'set_family'/'unset_family' in the same transaction. Idempotent: requesting
 * the already-held state writes nothing and returns { changed: false } (DESIGN-003 D-11).
 */
export async function setFamilyDesignation(
  input: SetFamilyDesignationInput,
): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [current] = await tx
      .select({ isFamily: users.isFamily })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');

    if (!current) {
      throw new NotFoundError(`User ${input.userId} not found`);
    }
    if (current.isFamily === input.isFamily) {
      return { changed: false };
    }

    await tx
      .update(users)
      .set({ isFamily: input.isFamily, updatedAt: sql`now()` })
      .where(eq(users.id, input.userId));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: input.isFamily ? 'set_family' : 'unset_family',
      subjectUserId: input.userId,
      detail: { before: current.isFamily, after: input.isFamily },
    });

    return { changed: true };
  });
}

/**
 * DESIGN-001 D-11 — effective family: direct designation OR any applied tag with
 * tags.is_family. Consumed by Phase 3 library gating.
 */
export async function isEffectivelyFamily(userId: string, dbc?: DbClient): Promise<boolean> {
  const q = resolveDb(dbc);
  const [user] = await q
    .select({ isFamily: users.isFamily })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundError(`User ${userId} not found`);
  }
  if (user.isFamily) return true;

  const [familyTag] = await q
    .select({ id: userTags.id })
    .from(userTags)
    .innerJoin(tags, eq(tags.id, userTags.tagId))
    .where(and(eq(userTags.userId, userId), eq(tags.isFamily, true)))
    .limit(1);
  return familyTag !== undefined;
}
