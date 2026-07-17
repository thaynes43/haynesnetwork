// ADR-064 / DESIGN-035 D-02 (PLAN-037 — mirrored Plex collections) — the READ-ONLY fetcher the
// `collections-sync` mode hands to the @hnet/domain syncPlexCollections single-writer. It reads the
// HOPS server's registered movie/show sections (owner R4 — slug `haynesops` only, v1), pages each
// section's /collections listing to completion, and reads each collection's RAW membership via the
// existing children read (owner R3 — mirror everything, charts included; a member with no ledger
// match still mirrors). No *arr call; no write to Plex — external software is ALWAYS the collections
// source of truth (owner doctrine R1). Sections/servers that error mid-read are NOT scoped, so the
// writer can never reconcile-drop what this run couldn't see (the plex-match discipline).
import type { PlexReadClient } from '@hnet/plex/read';
import { derivePlexCollectionProvenance, deriveCollectionCategory } from '@hnet/domain';
import type { PlexClientBundle, PlexCollectionSyncInput } from '@hnet/domain';
import type { DbClient, PlexServerSlug } from '@hnet/db';
import { selectPlexLibraryRefs } from './db-reads';
import { noopLogger, type SyncLogger } from './logger';

/** Owner R4 — v1 mirrors the HOps server only (where collections + overlays are maintained). */
const COLLECTIONS_SERVER_SLUG: PlexServerSlug = 'haynesops';

/** The section types that carry the Movies/TV collections (owner R2 surface — never photos/music). */
const COLLECTION_SECTION_TYPES = new Set(['movie', 'show']);

/** The children read's container bound (the @hnet/plex client clamps to ≤1000; unpaged — D-08). */
const MEMBERS_LIMIT = 1000;

export interface PlexCollectionsStats {
  /** Sections enumerated (registered, movie/show, on the mirrored server). */
  sectionsRead: number;
  /** Collections fetched across all fully-or-partially read sections. */
  collectionsFetched: number;
  /** Member rows fetched. */
  membersFetched: number;
  /** Collections whose member read was TRUNCATED (totalSize > items — D-08: never member-reconciled). */
  truncatedCollections: number;
  /** Sections whose /collections LISTING was truncated (page cap / totalSize contradiction) —
   *  their collections upsert but the library is NOT scoped, so nothing of theirs reconciles. */
  truncatedSections: number;
  /** Plex sections present on the server but absent from the plex_libraries registry (skipped). */
  unmappedSections: number;
}

export interface PlexCollectionsSnapshot {
  collections: PlexCollectionSyncInput[];
  /** plex_libraries.id whose /collections listing was fully read (the writer's reconcile scope). */
  scopedLibraryIds: string[];
  stats: PlexCollectionsStats;
}

/**
 * Read the mirrored server's registered movie/show sections, page their collections, and read each
 * collection's members. A section whose collections listing fails is skipped entirely (not scoped);
 * a collection whose MEMBER read fails is kept un-fullyRead with no members (its collection row
 * still upserts; its members are never reconciled from this run).
 */
export async function fetchPlexCollectionsSnapshot(input: {
  db: DbClient;
  plex: Pick<PlexClientBundle, 'read'>;
  logger?: SyncLogger;
}): Promise<PlexCollectionsSnapshot> {
  const logger = input.logger ?? noopLogger;
  const read: PlexReadClient | undefined = input.plex.read[COLLECTIONS_SERVER_SLUG];
  if (read === undefined) {
    throw new Error(`collections-sync: no Plex read client for slug "${COLLECTIONS_SERVER_SLUG}"`);
  }

  const libRefs = await selectPlexLibraryRefs(input.db);
  // (sectionKey → plex_libraries.id) for the mirrored server's registered sections.
  const libBySection = new Map(
    libRefs
      .filter((l) => l.serverSlug === COLLECTIONS_SERVER_SLUG)
      .map((l) => [l.sectionKey, l] as const),
  );

  const collections: PlexCollectionSyncInput[] = [];
  const scopedLibraryIds = new Set<string>();
  const stats: PlexCollectionsStats = {
    sectionsRead: 0,
    collectionsFetched: 0,
    membersFetched: 0,
    truncatedCollections: 0,
    truncatedSections: 0,
    unmappedSections: 0,
  };

  let sections;
  try {
    sections = await read.listSections();
  } catch (error) {
    logger.error('collections-sync: listSections failed', {
      server: COLLECTIONS_SERVER_SLUG,
      error: error instanceof Error ? error.message : String(error),
    });
    return { collections: [], scopedLibraryIds: [], stats };
  }

  for (const section of sections) {
    if (!COLLECTION_SECTION_TYPES.has(section.type)) continue;
    const lib = libBySection.get(section.key);
    if (lib === undefined) {
      stats.unmappedSections += 1;
      logger.info('collections-sync: section not in registry (skipped)', {
        server: COLLECTIONS_SERVER_SLUG,
        section: section.key,
        title: section.title,
      });
      continue; // no plex_libraries row — cannot FK a collection; run a registry refresh first
    }
    try {
      const { collections: sectionCollections, truncated: listingTruncated } =
        await read.listCollections(section.key);
      stats.sectionsRead += 1;
      for (const collection of sectionCollections) {
        stats.collectionsFetched += 1;
        // Provenance + CATEGORY (owner directives 2026-07-16 / 2026-07-17) — read the collection's
        // LABELS once (Kometa stamps `Kometa` on what it manages, plus the owner's category label
        // and Kometa's section labels). The listing carries no labels, so this is one per-collection
        // read that feeds BOTH `createdBy` (provenance) and `category` (D-10'). A read FAILURE leaves
        // labels null → both derive null → the writer preserves the prior values (a transient
        // failure never re-tags a collection or wipes its category). Zero extra Plex I/O.
        let labels: string[] | null = null;
        try {
          labels = await read.readCollectionLabels(collection.ratingKey);
        } catch (error) {
          logger.warn('collections-sync: label read failed (provenance preserved)', {
            section: section.key,
            collection: collection.ratingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        let members: Array<{ ratingKey: string; sortOrder: number }> = [];
        let fullyRead = false;
        try {
          const children = await read.listMetadataChildren(collection.ratingKey, {
            limit: MEMBERS_LIMIT,
          });
          members = children.items.map((item, i) => ({ ratingKey: item.ratingKey, sortOrder: i }));
          fullyRead = children.totalSize === null || children.totalSize <= members.length;
          if (!fullyRead) {
            stats.truncatedCollections += 1;
            logger.warn('collections-sync: member read truncated (never member-reconciled)', {
              section: section.key,
              collection: collection.ratingKey,
              title: collection.title,
              fetched: members.length,
              totalSize: children.totalSize,
            });
          }
          stats.membersFetched += members.length;
        } catch (error) {
          // Member read failed — keep the collection row (title/count advance) but never
          // reconcile its members from a read we don't have.
          logger.error('collections-sync: member read failed (collection kept, un-reconciled)', {
            section: section.key,
            collection: collection.ratingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        collections.push({
          plexLibraryId: lib.libraryId,
          ratingKey: collection.ratingKey,
          title: collection.title,
          childCount: collection.childCount ?? 0,
          createdBy: derivePlexCollectionProvenance(labels),
          category: deriveCollectionCategory(labels),
          members,
          fullyRead,
        });
      }
      if (listingTruncated) {
        // Adversarial-review fix — a truncated LISTING (page cap / totalSize contradiction) is the
        // section-level fullyRead discipline: upsert everything we saw, but the library is NOT
        // scoped, so no collection of it can be reconcile-deleted from a partial read.
        stats.truncatedSections += 1;
        logger.warn('collections-sync: collections listing truncated (library not scoped)', {
          server: COLLECTIONS_SERVER_SLUG,
          section: section.key,
          fetched: sectionCollections.length,
        });
      } else {
        scopedLibraryIds.add(lib.libraryId); // listing fully read → in collection-reconcile scope
      }
    } catch (error) {
      logger.error('collections-sync: section collections read failed', {
        server: COLLECTIONS_SERVER_SLUG,
        section: section.key,
        error: error instanceof Error ? error.message : String(error),
      });
      // listing failed — do NOT scope this library (avoid dropping collections we didn't see)
    }
  }

  return { collections, scopedLibraryIds: [...scopedLibraryIds], stats };
}
