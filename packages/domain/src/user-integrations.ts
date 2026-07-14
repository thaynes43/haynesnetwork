// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the SINGLE WRITER for user_integrations.
// A USER links / unlinks an external account; each link/unlink co-writes a permission_audit row in the
// SAME transaction (CLAUDE.md hard rule 6 — link_integration / unlink_integration). The sync-driven
// last_synced_at / last_sync_error bookkeeping (markIntegrationSynced) is NOT audited (the synced-content
// exemption). Reads (list linked / get) live here too. Linking is PER-USER (R1). The guard forbids any
// other module from touching the table.
import {
  permissionAudit,
  userIntegrations,
  users,
  type DbClient,
  type IntegrationProvider,
  type IntegrationStatus,
  type UserIntegrationRow,
} from '@hnet/db';
import { and, eq, ne } from 'drizzle-orm';
import { InvalidGoodreadsProfileError, NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * Extract the numeric Goodreads user id from a profile reference WITHOUT a network call. Accepts a bare
 * numeric id, a profile URL (`.../user/show/12345-name`), or a review-list URL (`.../review/list[_rss]/12345`).
 * Returns null for a VANITY url (`.../haynesnetwork`) which has no id in it — the caller resolves those by
 * following the redirect server-side (@hnet/goodreads resolveGoodreadsUserId). Pure — used by the API
 * fast-path + the unit tests.
 */
export function parseGoodreadsProfile(ref: string): { externalUserId: string } | null {
  const trimmed = (ref ?? '').trim();
  if (/^\d{1,20}$/.test(trimmed)) return { externalUserId: trimmed };
  const m = /goodreads\.com\/(?:user\/show|review\/list(?:_rss)?)\/(\d{1,20})/i.exec(trimmed);
  if (m?.[1]) return { externalUserId: m[1] };
  return null;
}

/** Reject an id that is not a plausible Goodreads numeric user id (defence beneath the API resolver). */
export function assertGoodreadsUserId(externalUserId: string): void {
  if (!/^\d{1,20}$/.test(externalUserId.trim())) {
    throw new InvalidGoodreadsProfileError(
      'That does not look like a Goodreads profile. Paste your profile URL ' +
        '(e.g. https://www.goodreads.com/haynesnetwork or .../user/show/12345-name) or your numeric user id.',
    );
  }
}

export interface LinkIntegrationInput {
  db?: DbClient;
  userId: string;
  provider: IntegrationProvider;
  /** The RESOLVED numeric provider user id (the API resolves a vanity URL → id before calling this). */
  externalUserId: string;
  /** The profile URL / id the user entered (stored as the display + audit copy). */
  profileRef: string;
  /** Shelves to sync (default the want shelf). */
  shelves?: string[];
  actorId: string | null;
}

export interface LinkIntegrationResult {
  integration: UserIntegrationRow;
  changed: boolean;
}

/**
 * Link (or re-link) an external account for a user. Parses the profile ref to the provider user id,
 * upserts the (user, provider) row to status 'linked' (a re-link flips 'unlinked' → 'linked' and updates
 * the ref/shelves), and writes a `link_integration` permission_audit row in the same transaction.
 */
export async function linkIntegration(input: LinkIntegrationInput): Promise<LinkIntegrationResult> {
  const externalUserId = input.externalUserId.trim();
  assertGoodreadsUserId(externalUserId);
  const shelves = input.shelves && input.shelves.length > 0 ? input.shelves : ['to-read'];
  return inTransaction(input.db, async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) throw new NotFoundError(`User ${input.userId} not found`);

    const [existing] = await tx
      .select({ id: userIntegrations.id, status: userIntegrations.status })
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, input.userId),
          eq(userIntegrations.provider, input.provider),
        ),
      );

    const [row] = await tx
      .insert(userIntegrations)
      .values({
        userId: input.userId,
        provider: input.provider,
        externalUserId,
        profileRef: input.profileRef.trim(),
        status: 'linked',
        shelves,
      })
      .onConflictDoUpdate({
        target: [userIntegrations.userId, userIntegrations.provider],
        set: {
          externalUserId,
          profileRef: input.profileRef.trim(),
          status: 'linked',
          shelves,
          lastSyncError: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('user_integrations upsert returned no row');

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'link_integration',
      subjectUserId: input.userId,
      detail: {
        provider: input.provider,
        external_user_id: externalUserId,
        profile_ref: input.profileRef.trim(),
        shelves,
        relinked: existing?.status === 'unlinked',
      },
    });

    return { integration: row, changed: existing?.status !== 'linked' };
  });
}

export interface UnlinkIntegrationInput {
  db?: DbClient;
  userId: string;
  provider: IntegrationProvider;
  actorId: string | null;
}

/**
 * Unlink an account (soft — the row is retained so a re-link keeps history, and the audit trail outlives
 * the link). Sets status 'unlinked'; writes an `unlink_integration` permission_audit row same-tx. A no-op
 * on an already-unlinked / absent integration writes no audit row (returns { changed: false }).
 */
export async function unlinkIntegration(
  input: UnlinkIntegrationInput,
): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: userIntegrations.id, status: userIntegrations.status })
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, input.userId),
          eq(userIntegrations.provider, input.provider),
        ),
      )
      .for('update');
    if (!existing || existing.status === 'unlinked') return { changed: false };

    await tx
      .update(userIntegrations)
      .set({ status: 'unlinked', updatedAt: new Date() })
      .where(eq(userIntegrations.id, existing.id));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'unlink_integration',
      subjectUserId: input.userId,
      detail: { provider: input.provider },
    });

    return { changed: true };
  });
}

/**
 * Sync bookkeeping (NOT audited — synced-content exemption): record the outcome of a shelf sync. On
 * success advances last_synced_at and clears the error (status 'linked'); on failure records the error
 * and flips status 'error' (leaving last_synced_at untouched — the marker only advances on success).
 *
 * Guarded `status <> 'unlinked'`: an in-flight sync (e.g. the fresh-link background first sync, PLAN-044)
 * that finishes AFTER the user unlinks must NOT resurrect the integration back to 'linked'/'error'. The
 * CronJob only ever syncs linked integrations, so the guard is a no-op for it.
 */
export async function markIntegrationSynced(input: {
  db?: DbClient;
  integrationId: string;
  error?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const stillLinked = and(
    eq(userIntegrations.id, input.integrationId),
    ne(userIntegrations.status, 'unlinked'),
  );
  if (input.error) {
    await db
      .update(userIntegrations)
      .set({ status: 'error', lastSyncError: input.error.slice(0, 500), updatedAt: now })
      .where(stillLinked);
    return;
  }
  await db
    .update(userIntegrations)
    .set({ status: 'linked', lastSyncError: null, lastSyncedAt: now, updatedAt: now })
    .where(stillLinked);
}

/** Read: every LINKED integration (optionally for one provider) — the goodreads-sync mode's worklist. */
export async function listLinkedIntegrations(input: {
  db?: DbClient;
  provider?: IntegrationProvider;
}): Promise<UserIntegrationRow[]> {
  const db = resolveDb(input.db);
  const where = input.provider
    ? and(eq(userIntegrations.status, 'linked' as IntegrationStatus), eq(userIntegrations.provider, input.provider))
    : eq(userIntegrations.status, 'linked' as IntegrationStatus);
  return db.select().from(userIntegrations).where(where);
}

/** Read: a user's integration for a provider (the tab's status view), or null. */
export async function getUserIntegration(input: {
  db?: DbClient;
  userId: string;
  provider: IntegrationProvider;
}): Promise<UserIntegrationRow | null> {
  const db = resolveDb(input.db);
  const [row] = await db
    .select()
    .from(userIntegrations)
    .where(
      and(eq(userIntegrations.userId, input.userId), eq(userIntegrations.provider, input.provider)),
    );
  return row ?? null;
}

/** Read: an integration by id (used to authorize a manual-search against its owner). */
export async function getIntegrationById(input: {
  db?: DbClient;
  id: string;
}): Promise<UserIntegrationRow | null> {
  const db = resolveDb(input.db);
  const [row] = await db.select().from(userIntegrations).where(eq(userIntegrations.id, input.id));
  return row ?? null;
}
