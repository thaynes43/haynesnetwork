// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state) — the app-user ↔ media-account
// MAPPING seam. The single seam for the `user_account_map` store (per-source handles: plex.tv numeric
// id, ABS user id, Kavita username). Written ONLY by `upsertUserAccountHandles` (the guard forbids any
// other module from touching the table). NO audit row — descriptive attribution config (ADR-052 C-04
// class); handle entry is admin-only (ADR-053 C-07) and the map never widens access. The Feed-
// attribution backlog item reuses this seam verbatim (ADR-053 C-01).
import { userAccountMap, type DbClient, type UserAccountMapRow } from '@hnet/db';
import { eq, isNotNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

export interface UpsertUserAccountHandlesInput {
  db?: DbClient;
  userId: string;
  /**
   * Per-source handle updates. `undefined` = LEAVE the stored value unchanged (a partial update — e.g.
   * the login auto-fill only touches plex_user_id); an explicit `null` = CLEAR the handle; a value = set
   * it. Handles are stored verbatim (they are opaque upstream ids / usernames).
   */
  plexUserId?: string | null;
  absUserId?: string | null;
  kavitaUsername?: string | null;
}

/**
 * The SINGLE WRITER for a user's account handles: merge the provided handles over any existing row and
 * upsert on the user_id PK (undefined = keep, null = clear, value = set). One row per app user. No
 * audit row (descriptive mapping, ADR-052 C-04 class). A duplicate plex_user_id / abs_user_id trips the
 * table's UNIQUE constraint (one media account maps to at most one app user) — the caller surfaces it.
 */
export async function upsertUserAccountHandles(
  input: UpsertUserAccountHandlesInput,
): Promise<UserAccountMapRow> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(userAccountMap)
      .where(eq(userAccountMap.userId, input.userId))
      .for('update');
    const merged = {
      plexUserId:
        input.plexUserId !== undefined ? input.plexUserId : (existing?.plexUserId ?? null),
      absUserId: input.absUserId !== undefined ? input.absUserId : (existing?.absUserId ?? null),
      kavitaUsername:
        input.kavitaUsername !== undefined
          ? input.kavitaUsername
          : (existing?.kavitaUsername ?? null),
    };
    const now = new Date();
    const [row] = await tx
      .insert(userAccountMap)
      .values({ userId: input.userId, ...merged, updatedAt: now })
      .onConflictDoUpdate({
        target: userAccountMap.userId,
        set: { ...merged, updatedAt: now },
      })
      .returning();
    return row!;
  });
}

/**
 * ADR-053 approach A/B — auto-fill a user's plex.tv numeric id from the resolved identity (the OIDC
 * claim / friend match) WITHOUT clobbering an admin-set value: sets plex_user_id only when the row has
 * none yet (or no row exists). Idempotent — a no-op once set. The login/session hook calls this; a
 * later admin override wins because this never overwrites a present value. Returns whether it wrote.
 */
export async function ensurePlexUserIdMapping(input: {
  db?: DbClient;
  userId: string;
  plexUserId: string;
}): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ plexUserId: userAccountMap.plexUserId })
      .from(userAccountMap)
      .where(eq(userAccountMap.userId, input.userId))
      .for('update');
    if (existing?.plexUserId) return { changed: false };
    const now = new Date();
    await tx
      .insert(userAccountMap)
      .values({ userId: input.userId, plexUserId: input.plexUserId, updatedAt: now })
      .onConflictDoUpdate({
        target: userAccountMap.userId,
        set: { plexUserId: input.plexUserId, updatedAt: now },
      });
    return { changed: true };
  });
}

/** Read one user's account map row (null when unmapped). */
export async function getUserAccountMap(
  db: DbClient | undefined,
  userId: string,
): Promise<UserAccountMapRow | null> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select()
    .from(userAccountMap)
    .where(eq(userAccountMap.userId, userId));
  return row ?? null;
}

/** The plex.tv numeric id → app user id map (the Tautulli-history attribution join). Mapped users only. */
export async function getPlexUserIdToAppUserMap(
  db: DbClient | undefined,
): Promise<Map<string, string>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ userId: userAccountMap.userId, plexUserId: userAccountMap.plexUserId })
    .from(userAccountMap)
    .where(isNotNull(userAccountMap.plexUserId));
  const map = new Map<string, string>();
  for (const r of rows) if (r.plexUserId) map.set(r.plexUserId, r.userId);
  return map;
}

/** The mapped ABS users (the per-user audiobook progress read iterates these). */
export async function listMappedAbsUsers(
  db: DbClient | undefined,
): Promise<Array<{ appUserId: string; absUserId: string }>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ userId: userAccountMap.userId, absUserId: userAccountMap.absUserId })
    .from(userAccountMap)
    .where(isNotNull(userAccountMap.absUserId));
  return rows
    .filter((r): r is { userId: string; absUserId: string } => r.absUserId !== null)
    .map((r) => ({ appUserId: r.userId, absUserId: r.absUserId }));
}
