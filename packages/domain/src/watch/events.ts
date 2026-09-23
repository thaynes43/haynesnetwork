// ADR-088 / DESIGN-049 D-07 / D-09 step 2 — the single writer of the APPEND-ONLY Watch Event log
// (`watch_events`): insert-or-ignore on (instance, tautulli_row_id), so a re-read window never duplicates
// and the log is never capped. The ONE permitted update is `fillShowGuids` (DESIGN-049 Q-06 ruling): a null
// `show_guid` — Tautulli answered "gone" while it could not reach Plex — is filled in place once the show's
// guid is known. Nothing else about an event ever changes, and nothing outside this module deletes one
// (the no-direct-state-writes guard).
import { watchEvents, type DbClient, type PlexServerSlug, type WatchEventKind } from '@hnet/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from '../db-client';

export interface WatchEventInput {
  instance: PlexServerSlug;
  /** Tautulli history `row_id`. */
  tautulliRowId: number;
  kind: WatchEventKind;
  itemGuid: string | null;
  showGuid: string | null;
  title: string;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  ratingKey: string | null;
  grandparentRatingKey: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  percentComplete: number | null;
  watched: boolean;
}

/** A newly inserted event, as the sync needs it (which titles gained plays this run). */
export interface InsertedWatchEvent {
  id: number;
  instance: PlexServerSlug;
  kind: WatchEventKind;
  itemGuid: string | null;
  showGuid: string | null;
  title: string;
  showTitle: string | null;
  year: number | null;
}

const CHUNK = 500;

/** Insert-or-ignore a batch of Watch Events for one account; returns the rows actually inserted. */
export async function appendWatchEvents(input: {
  db?: DbClient;
  plexAccountId: number;
  events: readonly WatchEventInput[];
}): Promise<{ inserted: InsertedWatchEvent[] }> {
  if (input.events.length === 0) return { inserted: [] };
  const inserted: InsertedWatchEvent[] = [];
  await inTransaction(input.db, async (tx) => {
    for (let i = 0; i < input.events.length; i += CHUNK) {
      const chunk = input.events.slice(i, i + CHUNK).map((e) => ({
        plexAccountId: input.plexAccountId,
        instance: e.instance,
        tautulliRowId: e.tautulliRowId,
        kind: e.kind,
        itemGuid: e.itemGuid,
        showGuid: e.showGuid,
        title: e.title,
        showTitle: e.showTitle,
        season: e.season,
        episode: e.episode,
        year: e.year,
        ratingKey: e.ratingKey,
        grandparentRatingKey: e.grandparentRatingKey,
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt,
        percentComplete: e.percentComplete,
        watched: e.watched,
      }));
      const rows = await tx
        .insert(watchEvents)
        .values(chunk)
        .onConflictDoNothing({ target: [watchEvents.instance, watchEvents.tautulliRowId] })
        .returning({
          id: watchEvents.id,
          instance: watchEvents.instance,
          kind: watchEvents.kind,
          itemGuid: watchEvents.itemGuid,
          showGuid: watchEvents.showGuid,
          title: watchEvents.title,
          showTitle: watchEvents.showTitle,
          year: watchEvents.year,
        });
      inserted.push(...rows);
    }
  });
  return { inserted };
}

export interface ShowGuidFill {
  instance: PlexServerSlug;
  grandparentRatingKey: string;
  showGuid: string;
}

/**
 * DESIGN-049 Q-06 (driver ruling, PLAN-068 S6) — the ONE exception to append-only: fill a NULL
 * `show_guid` on every event of (instance, grandparent key) once the show's guid is known. A non-null guid
 * is never overwritten. Returns how many events were filled.
 */
export async function fillShowGuids(input: {
  db?: DbClient;
  plexAccountId: number;
  fills: readonly ShowGuidFill[];
}): Promise<{ filled: number }> {
  let filled = 0;
  const db = resolveDb(input.db);
  for (const f of input.fills) {
    if (!f.showGuid.startsWith('plex://show/')) continue;
    const rows = await db
      .update(watchEvents)
      .set({ showGuid: f.showGuid })
      .where(
        and(
          eq(watchEvents.plexAccountId, input.plexAccountId),
          eq(watchEvents.instance, f.instance),
          eq(watchEvents.grandparentRatingKey, f.grandparentRatingKey),
          isNull(watchEvents.showGuid),
        ),
      )
      .returning({ id: watchEvents.id });
    filled += rows.length;
  }
  return { filled };
}

/** The newest stored `started_at` for (account, instance) — the D-09 window anchor; null before any. */
export async function newestEventStart(
  db: DbClient,
  plexAccountId: number,
  instance: PlexServerSlug,
): Promise<Date | null> {
  const [row] = await db
    .select({ newest: sql<Date | null>`max(${watchEvents.startedAt})` })
    .from(watchEvents)
    .where(and(eq(watchEvents.plexAccountId, plexAccountId), eq(watchEvents.instance, instance)));
  const v = row?.newest ?? null;
  return v === null ? null : v instanceof Date ? v : new Date(v);
}
