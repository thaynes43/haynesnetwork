// ADR-047 / DESIGN-025 (PLAN-028 — Library deep links) — the SINGLE WRITER for the *arr→Plex match cache
// (`media_plex_matches`). The `plex-match` sync mode resolves each ledger media_item to its exact Plex
// {library, ratingKey} by shared-GUID match (the @hnet/sync fetcher knows the Plex wire shape), and hands
// the resolved rows here to be UPSERTED (one row per media_item) and RECONCILED (a title that dropped out
// of a fully-read library is removed) — all in one transaction. Rebuildable derived cache (the *arrs + Plex
// are the sources of truth), so no per-row audit event; the no-direct-state-writes guard forbids any other
// module from touching the table.
import { mediaPlexMatches, type DbClient, type PlexMatchGuidSource } from '@hnet/db';
import { and, inArray, lt, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';

/** One resolved *arr→Plex match the plex-match fetcher produced. */
export interface PlexMatchInput {
  mediaItemId: string;
  plexLibraryId: string;
  ratingKey: string;
  matchedVia: PlexMatchGuidSource;
  /** DESIGN-052 D-26 — the title's Plex `addedAt` in this library; null when Plex omits it (absent ⇒ null). */
  plexAddedAt?: Date | null;
}

export interface SyncPlexMatchesInput {
  db?: DbClient;
  matches: PlexMatchInput[];
  /**
   * plex_libraries.id whose Plex section was FULLY read this run. Reconciliation (stale-delete) is scoped
   * to these, so a server outage never wrongly drops matches for a library it couldn't read this run.
   */
  scopedLibraryIds: string[];
  now?: Date;
}

export interface SyncPlexMatchesReport {
  upserted: number;
  /** Stale matches removed (matched before into a scoped library, absent from this run's set). */
  removed: number;
}

const CHUNK = 500;

/**
 * ADR-047 — upsert the fresh match set on `(media_item_id, plex_library_id)` (ON CONFLICT DO UPDATE: a
 * re-match REPLACES the ratingKey/matched_via and advances last_seen_at) then RECONCILE: delete any row of a
 * fully-read library whose last_seen_at predates the run (its title left that library). One transaction; no
 * per-row audit (derived cache). A title in several libraries has several rows — each is upserted separately.
 */
export async function syncPlexMatches(input: SyncPlexMatchesInput): Promise<SyncPlexMatchesReport> {
  const runStart = input.now ?? new Date();
  const values = input.matches.map((m) => ({
    mediaItemId: m.mediaItemId,
    plexLibraryId: m.plexLibraryId,
    ratingKey: m.ratingKey,
    matchedVia: m.matchedVia,
    plexAddedAt: m.plexAddedAt ?? null,
    firstSeenAt: runStart,
    lastSeenAt: runStart,
    updatedAt: runStart,
  }));

  let removed = 0;

  await inTransaction(input.db, async (tx) => {
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      await tx
        .insert(mediaPlexMatches)
        .values(chunk)
        .onConflictDoUpdate({
          target: [mediaPlexMatches.mediaItemId, mediaPlexMatches.plexLibraryId],
          set: {
            ratingKey: sql`excluded.rating_key`,
            matchedVia: sql`excluded.matched_via`,
            // DESIGN-052 D-26 — re-stamped every run: a re-keyed title (a replaced file) carries its new date added.
            plexAddedAt: sql`excluded.plex_added_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            updatedAt: sql`excluded.updated_at`,
            // firstSeenAt / createdAt keep their original values (not in the set).
          },
        });
    }

    if (input.scopedLibraryIds.length > 0) {
      const result = await tx
        .delete(mediaPlexMatches)
        .where(
          and(
            inArray(mediaPlexMatches.plexLibraryId, input.scopedLibraryIds),
            lt(mediaPlexMatches.lastSeenAt, runStart),
          ),
        )
        .returning({ id: mediaPlexMatches.id });
      removed = result.length;
    }
  });

  return { upserted: values.length, removed };
}
