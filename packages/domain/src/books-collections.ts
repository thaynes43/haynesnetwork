// ADR-066 / DESIGN-038 D-04 (PLAN-051 — books collections mirror) — the SINGLE WRITER for the books
// collections mirror (`books_collections` + `books_collection_members`). External software
// (Kavita/ABS) is ALWAYS the collections source of truth (owner doctrine R1, the ADR-064 model
// applied to books): the `books-collections-sync` mode's fetcher reads both book servers'
// collections/reading lists (the @hnet/sync fetcher knows the wire shapes) and hands the snapshot
// here to be UPSERTED and RECONCILED in one transaction. Member refs are resolved OPPORTUNISTICALLY
// against LIVE books_items rows every run (which is why the mode runs AFTER books-sync).
// Rebuildable derived cache (the plex_collections class) — no per-row audit event; the
// no-direct-state-writes guard forbids any other module from touching the tables.
import {
  bookRequests,
  booksCollections,
  booksCollectionMembers,
  booksItems,
  type BooksCollectionKind,
  type BooksSource,
  type DbClient,
} from '@hnet/db';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';
import { recordCascadedRequestDeletes } from './book-request-events';

/** One collection (with its raw membership) the books-collections-sync fetcher produced. */
export interface BooksCollectionSyncInput {
  source: BooksSource;
  /** The source's stable id (identity with source+kind; Kavita ids are per-kind id spaces). */
  externalId: string;
  kind: BooksCollectionKind;
  /** The source library scope where the source exposes one (ABS); Kavita ⇒ null. */
  libraryId: string | null;
  title: string;
  /** The RAW source member count (diagnostics only — never the shown count, ADR-066). */
  itemCount: number;
  /** Whether the SOURCE carries an explicit member order (DESIGN-038 D-09). */
  ordered: boolean;
  /**
   * PROVENANCE (owner directive 2026-07-16) — 'libretto' (the source description carries Libretto's
   * marker) / 'kavita' / 'audiobookshelf' (hand-made in the source app). Always derivable (the
   * description rides the mirror read), so never null.
   */
  createdBy: string;
  /**
   * DESIGN-038 D-13 — the Libretto recipeId parsed from the source description's `[libretto:<id>]`
   * marker (the provenance derive already reads it), or null when the collection carries no marker
   * (hand-made — no recipe, no wanted members). Captured on the mirror so the collection Wanted-tiles
   * pass can call `listMissingMembers(recipeId)` with an exact id. Refreshed every sync from the source
   * description (an absent marker ⇒ null; a re-added marker ⇒ the recipeId), like createdBy. Optional on
   * the input (defaults to null) so callers not driving the wanted pass need not supply it.
   */
  librettoRecipeId?: string | null;
  /**
   * CATEGORY (DESIGN-038 D-12) — the OPEN, free-form owner category from the FORWARD-COMPATIBLE
   * Libretto `cat=` marker derive (`deriveBooksCollectionCategory`); null when the source carries no
   * `cat=` (every row today — the marker is not emitted yet). null PRESERVES the prior category via
   * COALESCE on upsert, so the ratified L2 agent-set category on `books_collections` survives every
   * re-sync; a non-null source value WINS (mirror doctrine — symmetric with `plex_collections`).
   */
  category: string | null;
  /** RAW membership (owner R3 idiom — stored regardless of mirror match), positions per D-09. */
  members: Array<{ externalRef: string; position: number }>;
  /**
   * True when the member read was COMPLETE. Member reconciliation (stale-delete) runs ONLY for
   * fully-read collections — a failed/truncated member read never tombstones members it didn't
   * see (the PLAN-037 D-08 discipline).
   */
  fullyRead: boolean;
}

/** A reconcile-scope FAMILY: one source's one collection-kind listing (DESIGN-038 D-03). */
export interface BooksCollectionFamily {
  source: BooksSource;
  kind: BooksCollectionKind;
}

export interface SyncBooksCollectionsInput {
  db?: DbClient;
  collections: BooksCollectionSyncInput[];
  /**
   * The (source, kind) families whose LISTING was FULLY read this run. Collection reconciliation
   * (stale-delete, members CASCADE along) is scoped to these, so a server outage or a mid-listing
   * error never wrongly drops collections the run couldn't see (the plex-collections scoping rule
   * at family grain).
   */
  scopedFamilies: BooksCollectionFamily[];
  now?: Date;
}

export interface SyncBooksCollectionsReport {
  collectionsUpserted: number;
  membersUpserted: number;
  /** Member refs that resolved to a LIVE books_items row this run. */
  membersResolved: number;
  /** Stale collections removed (present before in a scoped family, absent from this run). */
  collectionsRemoved: number;
  /** Stale members removed from fully-read collections. */
  membersRemoved: number;
}

const CHUNK = 500;

/**
 * ADR-066 — upsert the fresh collection set on `(source, external_id, kind)` (a re-sync advances
 * title/item_count/ordered/library_id/last_seen_at; first_seen_at/created_at keep their originals)
 * and each collection's members on `(collection_id, external_ref)` — resolving each ref to a LIVE
 * books_items row (null when absent/tombstoned; refreshed EVERY run) — then RECONCILE: delete
 * members of FULLY-READ collections whose last_seen_at predates the run, and collections of
 * fully-read (source, kind) families that vanished (their members CASCADE). One transaction; no
 * audit rows (derived cache).
 */
export async function syncBooksCollections(
  input: SyncBooksCollectionsInput,
): Promise<SyncBooksCollectionsReport> {
  const runStart = input.now ?? new Date();
  let collectionsUpserted = 0;
  let membersUpserted = 0;
  let membersResolved = 0;
  let collectionsRemoved = 0;
  let membersRemoved = 0;

  await inTransaction(input.db, async (tx) => {
    // --- Opportunistic member resolution (D-04): (source, external_ref) → live books_items.id ---
    const refsBySource = new Map<BooksSource, Set<string>>();
    for (const collection of input.collections) {
      const set = refsBySource.get(collection.source) ?? new Set<string>();
      for (const m of collection.members) set.add(m.externalRef);
      refsBySource.set(collection.source, set);
    }
    const resolved = new Map<string, string>(); // `${source}\u0000${externalRef}` → books_items.id
    for (const [source, refs] of refsBySource) {
      const refList = [...refs];
      for (let i = 0; i < refList.length; i += CHUNK) {
        const chunk = refList.slice(i, i + CHUNK);
        const rows = await tx
          .select({ id: booksItems.id, externalId: booksItems.externalId })
          .from(booksItems)
          .where(
            and(
              eq(booksItems.source, source),
              inArray(booksItems.externalId, chunk),
              isNull(booksItems.deletedAt), // live rows only — a tombstoned item drops off the count
            ),
          );
        for (const row of rows) resolved.set(`${source}\u0000${row.externalId}`, row.id);
      }
    }

    const fullyReadCollectionIds: string[] = [];

    for (const collection of input.collections) {
      const [row] = await tx
        .insert(booksCollections)
        .values({
          source: collection.source,
          externalId: collection.externalId,
          kind: collection.kind,
          libraryId: collection.libraryId,
          title: collection.title,
          itemCount: collection.itemCount,
          ordered: collection.ordered,
          // Provenance — the software that created it (from the source description, this sync).
          createdBy: collection.createdBy,
          // Recipe id (D-13) — the Libretto recipeId from the marker (null when hand-made / not supplied).
          librettoRecipeId: collection.librettoRecipeId ?? null,
          // Category (D-12) — the forward-compatible Libretto `cat=` derive (null today). On INSERT a
          // fresh collection takes it; on conflict it COALESCE-preserves the prior value (below).
          category: collection.category,
          firstSeenAt: runStart,
          lastSeenAt: runStart,
          updatedAt: runStart,
        })
        .onConflictDoUpdate({
          target: [booksCollections.source, booksCollections.externalId, booksCollections.kind],
          set: {
            libraryId: sql`excluded.library_id`,
            title: sql`excluded.title`,
            itemCount: sql`excluded.item_count`,
            ordered: sql`excluded.ordered`,
            // Provenance re-derives every run from the source description (always available).
            createdBy: sql`excluded.created_by`,
            // Recipe id (D-13) re-derives every run from the source marker (null when the marker is gone).
            librettoRecipeId: sql`excluded.libretto_recipe_id`,
            // Category (D-12) — a source-carried `cat=` marker WINS (mirror doctrine); otherwise the
            // prior value is PRESERVED, so the ratified L2 agent-set category survives every re-sync.
            category: sql`COALESCE(excluded.category, ${booksCollections.category})`,
            lastSeenAt: sql`excluded.last_seen_at`,
            updatedAt: sql`excluded.updated_at`,
            // firstSeenAt / createdAt keep their original values (not in the set).
          },
        })
        .returning({ id: booksCollections.id });
      if (!row) throw new Error('books_collections upsert returned no row');
      collectionsUpserted += 1;
      if (collection.fullyRead) fullyReadCollectionIds.push(row.id);

      const memberValues = collection.members.map((m) => {
        const booksItemId = resolved.get(`${collection.source}\u0000${m.externalRef}`) ?? null;
        if (booksItemId !== null) membersResolved += 1;
        return {
          collectionId: row.id,
          externalRef: m.externalRef,
          booksItemId,
          position: m.position,
          firstSeenAt: runStart,
          lastSeenAt: runStart,
          updatedAt: runStart,
        };
      });
      for (let i = 0; i < memberValues.length; i += CHUNK) {
        const chunk = memberValues.slice(i, i + CHUNK);
        await tx
          .insert(booksCollectionMembers)
          .values(chunk)
          .onConflictDoUpdate({
            target: [booksCollectionMembers.collectionId, booksCollectionMembers.externalRef],
            set: {
              // The resolution refreshes every run (a newly-synced item resolves; a vanished one nulls).
              booksItemId: sql`excluded.books_item_id`,
              position: sql`excluded.position`,
              lastSeenAt: sql`excluded.last_seen_at`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
        membersUpserted += chunk.length;
      }
    }

    // Member reconcile — fully-read collections only (a partial member read never tombstones).
    if (fullyReadCollectionIds.length > 0) {
      const removed = await tx
        .delete(booksCollectionMembers)
        .where(
          and(
            inArray(booksCollectionMembers.collectionId, fullyReadCollectionIds),
            lt(booksCollectionMembers.lastSeenAt, runStart),
          ),
        )
        .returning({ id: booksCollectionMembers.id });
      membersRemoved = removed.length;
    }

    // Collection reconcile — fully-read (source, kind) families only; members CASCADE.
    for (const family of input.scopedFamilies) {
      const leaving = and(
        eq(booksCollections.source, family.source),
        eq(booksCollections.kind, family.kind),
        lt(booksCollections.lastSeenAt, runStart),
      )!;
      // ADR-101 — the collection wants cascade away with their collection: their Request Events first.
      await recordCascadedRequestDeletes(
        tx,
        { writer: 'syncBooksCollections', reason: 'collection_removed' },
        inArray(
          bookRequests.collectionId,
          tx.select({ id: booksCollections.id }).from(booksCollections).where(leaving),
        ),
      );
      const removed = await tx
        .delete(booksCollections)
        .where(leaving)
        .returning({ id: booksCollections.id });
      collectionsRemoved += removed.length;
    }
  });

  return {
    collectionsUpserted,
    membersUpserted,
    membersResolved,
    collectionsRemoved,
    membersRemoved,
  };
}
