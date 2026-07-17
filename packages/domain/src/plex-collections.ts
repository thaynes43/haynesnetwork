// ADR-064 / DESIGN-035 D-02 (PLAN-037 — mirrored Plex collections) — the SINGLE WRITER for the
// collections mirror (`plex_collections` + `plex_collection_members`). External software
// (Plex/Kometa) is ALWAYS the collections source of truth (owner doctrine R1): the `collections-sync`
// mode's fetcher reads the HOps sections' collections + members (the @hnet/sync fetcher knows the
// Plex wire shape) and hands the snapshot here to be UPSERTED and RECONCILED in one transaction.
// Rebuildable derived cache (the media_plex_matches class) — no per-row audit event; the
// no-direct-state-writes guard forbids any other module from touching the tables.
import { plexCollections, plexCollectionMembers, type DbClient } from '@hnet/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';
// DESIGN-035 D-10' — the CATEGORY is derived from the collection's LABELS by the versioned
// @hnet/domain `deriveCollectionCategory` in the sync fetcher and passed in here. It is recomputed
// each sync and COALESCE-preserved on null (a failed label read never wipes it), so the whole column
// rebuilds each sync — a classifier version bump re-annotates the estate, nothing migrates.

/** One collection (with its raw membership) the collections-sync fetcher produced. */
export interface PlexCollectionSyncInput {
  plexLibraryId: string;
  /** The COLLECTION's Plex ratingKey (identity within its library + the drill-in group key). */
  ratingKey: string;
  title: string;
  /** The RAW Plex member count (diagnostics only — never the shown count, ADR-064 C-03). */
  childCount: number;
  /**
   * PROVENANCE (owner directive 2026-07-16) — 'kometa' (Kometa's label present) / 'plex' (hand-made)
   * / null (the label read did not run this sync — the upsert PRESERVES the prior created_by via
   * COALESCE, so a transient label-read failure never re-tags a collection).
   */
  createdBy: string | null;
  /**
   * CATEGORY (DESIGN-035 D-10') — the OPEN, free-form owner category derived from the collection's
   * labels (owner inline label first, else Kometa's section-label map). null = no owner/section
   * label OR the label read did not run this sync; the upsert PRESERVES the prior category via
   * COALESCE on null, so a transient label-read failure never wipes it (symmetric with createdBy).
   */
  category: string | null;
  /** RAW membership in source-read order (owner R3 — stored regardless of ledger match). */
  members: Array<{ ratingKey: string; sortOrder: number }>;
  /**
   * True when the member read was COMPLETE (items returned == totalSize). Member reconciliation
   * (stale-delete) runs ONLY for fully-read collections — a truncated read (the 1000-item children
   * bound, DESIGN-035 D-08) never tombstones members it didn't see.
   */
  fullyRead: boolean;
}

export interface SyncPlexCollectionsInput {
  db?: DbClient;
  collections: PlexCollectionSyncInput[];
  /**
   * plex_libraries.id whose /collections listing was FULLY read this run. Collection
   * reconciliation (stale-delete, members CASCADE along) is scoped to these, so a server outage
   * or a mid-section error never wrongly drops collections the run couldn't see (the plex-match
   * scoping rule).
   */
  scopedLibraryIds: string[];
  now?: Date;
}

export interface SyncPlexCollectionsReport {
  collectionsUpserted: number;
  membersUpserted: number;
  /** Stale collections removed (present before in a scoped library, absent from this run). */
  collectionsRemoved: number;
  /** Stale members removed from fully-read collections. */
  membersRemoved: number;
}

const CHUNK = 500;

/**
 * ADR-064 — upsert the fresh collection set on `(plex_library_id, rating_key)` (a re-sync advances
 * title/child_count/last_seen_at; first_seen_at/created_at keep their originals) and each
 * collection's members on `(collection_id, rating_key)`, then RECONCILE: delete members of
 * FULLY-READ collections whose last_seen_at predates the run, and collections of fully-read
 * libraries that vanished (their members CASCADE). One transaction; no audit rows (derived cache).
 */
export async function syncPlexCollections(
  input: SyncPlexCollectionsInput,
): Promise<SyncPlexCollectionsReport> {
  const runStart = input.now ?? new Date();
  let collectionsUpserted = 0;
  let membersUpserted = 0;
  let collectionsRemoved = 0;
  let membersRemoved = 0;

  await inTransaction(input.db, async (tx) => {
    const fullyReadCollectionIds: string[] = [];

    for (const collection of input.collections) {
      const [row] = await tx
        .insert(plexCollections)
        .values({
          plexLibraryId: collection.plexLibraryId,
          ratingKey: collection.ratingKey,
          title: collection.title,
          childCount: collection.childCount,
          // D-10' — the category annotation, derived from the collection's labels this sync.
          category: collection.category,
          // Provenance — the software that created it (from the collection's labels, this sync).
          createdBy: collection.createdBy,
          firstSeenAt: runStart,
          lastSeenAt: runStart,
          updatedAt: runStart,
        })
        .onConflictDoUpdate({
          target: [plexCollections.plexLibraryId, plexCollections.ratingKey],
          set: {
            title: sql`excluded.title`,
            childCount: sql`excluded.child_count`,
            // The category refreshes when this sync derived one (non-null); a null (labels unread
            // this run, or no owner/section label) PRESERVES the prior value — a transient label-read
            // failure never wipes the category (symmetric with created_by below).
            category: sql`COALESCE(excluded.category, ${plexCollections.category})`,
            // Provenance refreshes when this sync READ the labels (non-null); a null (unread this
            // run) PRESERVES the prior value — a transient label-read failure never re-tags a row.
            createdBy: sql`COALESCE(excluded.created_by, ${plexCollections.createdBy})`,
            lastSeenAt: sql`excluded.last_seen_at`,
            updatedAt: sql`excluded.updated_at`,
            // firstSeenAt / createdAt keep their original values (not in the set).
          },
        })
        .returning({ id: plexCollections.id });
      if (!row) throw new Error('plex_collections upsert returned no row');
      collectionsUpserted += 1;
      if (collection.fullyRead) fullyReadCollectionIds.push(row.id);

      const memberValues = collection.members.map((m) => ({
        collectionId: row.id,
        ratingKey: m.ratingKey,
        sortOrder: m.sortOrder,
        firstSeenAt: runStart,
        lastSeenAt: runStart,
        updatedAt: runStart,
      }));
      for (let i = 0; i < memberValues.length; i += CHUNK) {
        const chunk = memberValues.slice(i, i + CHUNK);
        await tx
          .insert(plexCollectionMembers)
          .values(chunk)
          .onConflictDoUpdate({
            target: [plexCollectionMembers.collectionId, plexCollectionMembers.ratingKey],
            set: {
              sortOrder: sql`excluded.sort_order`,
              lastSeenAt: sql`excluded.last_seen_at`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
        membersUpserted += chunk.length;
      }
    }

    // Member reconcile — fully-read collections only (D-08: a truncated read never tombstones).
    if (fullyReadCollectionIds.length > 0) {
      const removed = await tx
        .delete(plexCollectionMembers)
        .where(
          and(
            inArray(plexCollectionMembers.collectionId, fullyReadCollectionIds),
            lt(plexCollectionMembers.lastSeenAt, runStart),
          ),
        )
        .returning({ id: plexCollectionMembers.id });
      membersRemoved = removed.length;
    }

    // Collection reconcile — fully-read sections only (the plex-match scoping rule); members CASCADE.
    if (input.scopedLibraryIds.length > 0) {
      const removed = await tx
        .delete(plexCollections)
        .where(
          and(
            inArray(plexCollections.plexLibraryId, input.scopedLibraryIds),
            lt(plexCollections.lastSeenAt, runStart),
          ),
        )
        .returning({ id: plexCollections.id });
      collectionsRemoved = removed.length;
    }
  });

  return { collectionsUpserted, membersUpserted, collectionsRemoved, membersRemoved };
}
