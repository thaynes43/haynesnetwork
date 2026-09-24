// ADR-088 / DESIGN-049 D-03 / D-07 / D-09 step 1 — the single writer of `watch_accounts`: the Server Owner
// (ADR-029) the `watch` sync resolves from `PlexReadClient.getOwnerAccount()`. The MCP surface answers for
// THE owner row (D-03), so an owner change is an UPDATE — the previous owner is demoted to an untracked
// `household` row, never deleted (watch_marks RESTRICT the delete; OPS-015 §7).
import { users, watchAccounts, type DbClient, type WatchAccountRole, type WatchAccountRow } from '@hnet/db';
import { formatNotReady } from '@hnet/watch';
import { and, eq, ne, sql } from 'drizzle-orm';
import { inTransaction } from '../db-client';

export interface WatchOwnerAccountInput {
  /** plex.tv numeric account id as `getOwnerAccount()` returns it (a string). */
  id: string | number;
  username: string | null;
  email: string | null;
}

/** A plex.tv account id → the bigint column value; anything but a positive integer is refused. */
export function plexAccountIdOf(id: string | number): number {
  const n = typeof id === 'number' ? id : Number(String(id).trim());
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new TypeError(`watch owner: plex.tv account id must be a positive integer (got "${String(id)}")`);
  }
  return n;
}

/**
 * Upsert the `owner` row (D-09 step 1) and link the app user whose email is the owner's (attribution). An
 * existing owner with a different account id is demoted in the same transaction (the partial unique
 * index allows one owner). Returns the owner row.
 */
export async function upsertWatchOwner(input: {
  db?: DbClient;
  account: WatchOwnerAccountInput;
  now?: Date;
}): Promise<WatchAccountRow> {
  const now = input.now ?? new Date();
  const plexAccountId = plexAccountIdOf(input.account.id);
  const username = input.account.username?.trim() || `plex-${plexAccountId}`;
  const email = input.account.email?.trim().toLowerCase() || null;
  return inTransaction(input.db, async (tx) => {
    const [appUser] = email
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1)
      : [];
    await tx
      .update(watchAccounts)
      .set({ role: 'household', tracked: false, updatedAt: now })
      .where(and(eq(watchAccounts.role, 'owner'), ne(watchAccounts.plexAccountId, plexAccountId)));
    const [row] = await tx
      .insert(watchAccounts)
      .values({
        plexAccountId,
        username,
        role: 'owner',
        appUserId: appUser?.id ?? null,
        tracked: true,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: watchAccounts.plexAccountId,
        set: {
          username,
          role: 'owner',
          appUserId: appUser?.id ?? null,
          tracked: true,
          resolvedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error('watch owner upsert returned no row');
    return row;
  });
}

/**
 * D-03: thrown by `markWatched`, `dismissTitle`, `undoLastChange` and `revalidateTitles` when the account
 * they are handed is not THE current `owner` row — no owner yet, or a demoted `household` row after an
 * owner change. Raised before any Plex call or write. Its message is the D-03 answer ("Watch history isn't
 * ready yet."), so a caller can speak it as-is.
 */
export class WatchNotReadyError extends Error {
  readonly plexAccountId: number;

  constructor(plexAccountId: number) {
    super(formatNotReady());
    this.name = 'WatchNotReadyError';
    this.plexAccountId = plexAccountId;
  }
}

/**
 * ADR-091 C-04 / DESIGN-050 D-07 — the mark flows (`markWatched`, `dismissTitle`, `undoLastChange`) act for ANY
 * TRACKED account: the Server Owner (the hop, or the owner's own connector) or, once PLAN-070 tracks them, a
 * household account reached through a user's connector. An untracked or unknown account — a demoted former owner,
 * an id nobody tracks — is refused with {@link WatchNotReadyError} before any Plex call or write (one primary-key
 * SELECT). Returns the account's role: only the `owner` row may write Plex (its tokens are the owner's), so the
 * flows record a non-owner's mark in history only.
 */
export async function assertTrackedWatchAccount(db: DbClient, plexAccountId: number): Promise<WatchAccountRole> {
  const [row] = await db
    .select({ role: watchAccounts.role })
    .from(watchAccounts)
    .where(and(eq(watchAccounts.plexAccountId, plexAccountId), eq(watchAccounts.tracked, true)))
    .limit(1);
  if (!row) throw new WatchNotReadyError(plexAccountId);
  return row.role;
}

/**
 * D-03: live revalidation (`revalidateTitles`) reads Plex with the OWNER's tokens, so its snapshot is the owner's
 * watched state — it serves the current owner only, and any other account is refused (one primary-key SELECT).
 * (The mark flows moved to {@link assertTrackedWatchAccount} with ADR-091 C-04.)
 */
export async function assertWatchOwner(db: DbClient, plexAccountId: number): Promise<void> {
  const [row] = await db
    .select({ plexAccountId: watchAccounts.plexAccountId })
    .from(watchAccounts)
    .where(and(eq(watchAccounts.plexAccountId, plexAccountId), eq(watchAccounts.role, 'owner')))
    .limit(1);
  if (!row) throw new WatchNotReadyError(plexAccountId);
}
