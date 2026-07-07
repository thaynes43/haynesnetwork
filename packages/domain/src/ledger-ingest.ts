import {
  ledgerEvents,
  mediaItems,
  syncState,
  users,
  type Database,
  type DbClient,
  type LedgerEventSource,
  type LedgerEventType,
  type SyncSource,
  type Transaction,
} from '@hnet/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/** One normalized event ready for the ledger (D-07 shapes; payload keeps rawEventType). */
export interface LedgerEventInput {
  /** Null when the item isn't in the ledger yet (Seerr request before the *arr add). */
  mediaItemId?: string | null;
  eventType: LedgerEventType;
  source: LedgerEventSource;
  /** *arr history id / Seerr request id — the dedupe key; null events always insert. */
  sourceEventId?: string | null;
  occurredAt: Date;
  requestedByUserId?: string | null;
  payload: Record<string, unknown>;
}

export interface IngestLedgerEventsInput {
  db?: DbClient;
  /** The sync_state row to advance (the *arr being polled, or 'seerr'). */
  source: SyncSource;
  events: LedgerEventInput[];
  /** New history cursor = max source `date` of the batch; omitted ⇒ cursor untouched. */
  cursor?: Date;
}

export interface IngestLedgerEventsResult {
  inserted: number;
  /** Events skipped by the (source, source_event_id) dedupe index — overlap re-delivery. */
  skipped: number;
}

/**
 * DESIGN-005 D-12/D-14 — the single writer for history/request ingestion: events land
 * with ON CONFLICT DO NOTHING on the D-07 dedupe unique index, and the source's
 * sync_state.history_cursor advances in the SAME transaction (never backwards —
 * GREATEST), so a crash never re-processes committed events and overlap re-delivery
 * is a no-op.
 */
export async function ingestLedgerEvents(
  input: IngestLedgerEventsInput,
): Promise<IngestLedgerEventsResult> {
  return inTransaction(input.db, async (tx) => {
    let inserted = 0;
    if (input.events.length > 0) {
      const rows = await tx
        .insert(ledgerEvents)
        .values(
          input.events.map((e) => ({
            mediaItemId: e.mediaItemId ?? null,
            eventType: e.eventType,
            source: e.source,
            sourceEventId: e.sourceEventId ?? null,
            occurredAt: e.occurredAt,
            requestedByUserId: e.requestedByUserId ?? null,
            payload: e.payload,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: ledgerEvents.id });
      inserted = rows.length;
    }

    if (input.cursor !== undefined) {
      await tx
        .insert(syncState)
        .values({ source: input.source, historyCursor: input.cursor })
        .onConflictDoUpdate({
          target: syncState.source,
          set: {
            historyCursor: sql`GREATEST(coalesce(${syncState.historyCursor}, 'epoch'::timestamptz), excluded.history_cursor)`,
            updatedAt: sql`now()`,
          },
        });
    }

    return { inserted, skipped: input.events.length - inserted };
  });
}

export interface BackfillEventAttributionInput {
  db?: DbClient;
}

export interface BackfillEventAttributionResult {
  itemsLinked: number;
  usersLinked: number;
}

/**
 * DESIGN-005 D-12/D-14 — re-resolve formerly-unmatched Seerr 'requested' events after
 * items/users appear. Item match (from payload external ids kept at ingest):
 * mediaType 'movie' → radarr row by tmdbId; 'tv' → sonarr row by tvdbId, fallback
 * tmdbId. User match: case-insensitive payload.requestedBy.email vs users.email
 * (Q-01 resolution — email-only auto-link; plexUsername stays a payload suggestion).
 * Unresolved events stay NULL and render "unattributed" (ADR-008 C-05).
 */
export async function backfillEventAttribution(
  input: BackfillEventAttributionInput = {},
): Promise<BackfillEventAttributionResult> {
  return inTransaction(input.db, async (tx) => {
    const pending = await tx
      .select({
        id: ledgerEvents.id,
        mediaItemId: ledgerEvents.mediaItemId,
        requestedByUserId: ledgerEvents.requestedByUserId,
        payload: ledgerEvents.payload,
      })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.source, 'seerr'),
          eq(ledgerEvents.eventType, 'requested'),
          or(isNull(ledgerEvents.mediaItemId), isNull(ledgerEvents.requestedByUserId)),
        ),
      );

    let itemsLinked = 0;
    let usersLinked = 0;

    for (const event of pending) {
      const payload = event.payload;
      const patch: Partial<{ mediaItemId: string; requestedByUserId: string }> = {};

      if (event.mediaItemId === null) {
        const mediaType = payload['mediaType'];
        const itemId = await resolveMediaItemId(tx, {
          mediaType: typeof mediaType === 'string' ? mediaType : null,
          tmdbId: numberOrNull(payload['tmdbId']),
          tvdbId: numberOrNull(payload['tvdbId']),
        });
        if (itemId !== null) {
          patch.mediaItemId = itemId;
          itemsLinked += 1;
        }
      }

      if (event.requestedByUserId === null) {
        const requestedBy = payload['requestedBy'];
        const email =
          typeof requestedBy === 'object' && requestedBy !== null
            ? (requestedBy as Record<string, unknown>)['email']
            : undefined;
        const userId = await resolveUserIdByEmail(tx, typeof email === 'string' ? email : null);
        if (userId !== null) {
          patch.requestedByUserId = userId;
          usersLinked += 1;
        }
      }

      if (Object.keys(patch).length > 0) {
        await tx.update(ledgerEvents).set(patch).where(eq(ledgerEvents.id, event.id));
      }
    }

    return { itemsLinked, usersLinked };
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function findItemId(
  executor: Database | Transaction,
  kind: 'sonarr' | 'radarr',
  by: 'tmdbId' | 'tvdbId',
  value: number,
): Promise<string | undefined> {
  const column = by === 'tmdbId' ? mediaItems.tmdbId : mediaItems.tvdbId;
  const [row] = await executor
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(eq(mediaItems.arrKind, kind), sql`${column} = ${value}`))
    .limit(1);
  return row?.id;
}

/**
 * DESIGN-005 D-12 / ADR-008 C-05 — the SINGLE email→user attribution path (Q-01: email-only
 * auto-link, case-insensitive). Factored so Seerr ledger attribution (backfill) AND ADR-026
 * notification ingest reuse it — never a second attribution path. Null email / no match ⇒ null
 * ("unattributed"). Accepts an injected tx/db so it composes inside a caller's transaction.
 */
export async function resolveUserIdByEmail(
  executor: DbClient | undefined,
  email: string | null | undefined,
): Promise<string | null> {
  if (typeof email !== 'string' || email.length === 0) return null;
  const db = resolveDb(executor);
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return user?.id ?? null;
}

/**
 * DESIGN-005 D-12 / ADR-026 — the SINGLE external-id→Media Item match (movie→radarr by tmdbId;
 * tv→sonarr by tvdbId, fallback tmdbId). Factored from backfillEventAttribution so notification
 * ingest reuses the identical logic. When `mediaType` is absent (Tautulli/Maintainerr carry no
 * Seerr media_type), it probes radarr(tmdb) → sonarr(tvdb) → sonarr(tmdb) in turn. No match ⇒ null.
 */
export async function resolveMediaItemId(
  executor: DbClient | undefined,
  input: { mediaType?: string | null; tmdbId?: number | null; tvdbId?: number | null },
): Promise<string | null> {
  const db = resolveDb(executor);
  const tmdbId = numberOrNull(input.tmdbId ?? null);
  const tvdbId = numberOrNull(input.tvdbId ?? null);
  let itemId: string | undefined;
  if (input.mediaType === 'movie') {
    if (tmdbId !== null) itemId = await findItemId(db, 'radarr', 'tmdbId', tmdbId);
  } else if (input.mediaType === 'tv') {
    if (tvdbId !== null) itemId = await findItemId(db, 'sonarr', 'tvdbId', tvdbId);
    if (itemId === undefined && tmdbId !== null) itemId = await findItemId(db, 'sonarr', 'tmdbId', tmdbId);
  } else {
    // No media-type hint: probe movie then tv by whichever external ids are present.
    if (tmdbId !== null) itemId = await findItemId(db, 'radarr', 'tmdbId', tmdbId);
    if (itemId === undefined && tvdbId !== null) itemId = await findItemId(db, 'sonarr', 'tvdbId', tvdbId);
    if (itemId === undefined && tmdbId !== null) itemId = await findItemId(db, 'sonarr', 'tmdbId', tmdbId);
  }
  return itemId ?? null;
}
