// ADR-047 / DESIGN-025 (PLAN-028 — Library "Watch/Listen/Read here" deep links) — the READ-ONLY resolver
// the `plex-match` mode hands to the @hnet/domain syncPlexMatches single-writer. It reads the ledger's live
// media_items (their tmdb/tvdb/imdb/musicbrainz ids — already synced from the *arrs) + the Plex libraries
// (paged, GUID-carrying), and resolves each item to its exact Plex {library, ratingKey} by SHARED-GUID
// match. No *arr call (the ids live in the DB already); no write to Plex. The domain writer persists the
// result into media_plex_matches (the access gate + deep-link substrate).
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexSectionItem } from '@hnet/plex';
import type { PlexClientBundle } from '@hnet/domain';
import type { ArrKind, PlexMatchGuidSource, PlexMediaType, PlexServerSlug } from '@hnet/db';
import { FITTING_PLEX_MEDIA_TYPE, type PlexMatchInput } from '@hnet/domain';
import {
  selectMatchCandidateItems,
  selectPlexLibraryRefs,
  type MatchCandidateItem,
  type PlexLibraryRef,
} from './db-reads';
import type { DbClient } from '@hnet/db';
import { noopLogger, type SyncLogger } from './logger';

/** How many library items to pull per Plex page (bounded by the client to ≤1000). */
const PLEX_PAGE_SIZE = 1000;
/** Safety cap on pages per section so a bad totalSize can never loop forever. */
const MAX_PAGES = 500;

/** The Plex library `type`s the match sweep enumerates (Movies / TV / Music — never photos). */
const MATCHABLE_TYPES = new Set(['movie', 'show', 'artist']);

export interface ParsedPlexGuids {
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
  musicbrainz?: string;
}

/**
 * Parse a Plex item's external agent GUIDs into `{tmdb, imdb, tvdb, musicbrainz}`. Handles the modern
 * `scheme://id` form (`tmdb://12345`, `imdb://tt…`, `tvdb://…`, `mbid://…`) AND legacy agent prefixes
 * (`com.plexapp.agents.imdb://tt…`). First value per scheme wins.
 */
export function parsePlexGuids(item: { guid?: string; Guid?: { id: string }[] }): ParsedPlexGuids {
  const out: ParsedPlexGuids = {};
  const consider = (raw: string) => {
    const m = /(?:^|\.)(tmdb|imdb|tvdb|mbid|musicbrainz):\/\/([^?/]+)/i.exec(raw);
    if (!m) return;
    const scheme = m[1]!.toLowerCase();
    const value = m[2]!;
    if (scheme === 'tmdb') out.tmdb ??= value;
    else if (scheme === 'imdb') out.imdb ??= value;
    else if (scheme === 'tvdb') out.tvdb ??= value;
    else out.musicbrainz ??= value; // mbid | musicbrainz
  };
  for (const g of item.Guid ?? []) consider(g.id);
  if (item.guid) consider(item.guid);
  return out;
}

/** A resolved Plex title: which library it lives in + its ratingKey (+ its Plex `addedAt`, DESIGN-052 D-26). */
interface PlexHit {
  plexLibraryId: string;
  ratingKey: string;
  addedAt: Date | null;
}

export interface PlexMatchStats {
  byKind: Record<ArrKind, { total: number; matched: number }>;
  /** plex_libraries.id whose section was fully read (reconciliation scope for the writer). */
  scopedLibraryIds: string[];
  /** Plex sections present on a server but absent from the plex_libraries registry (skipped). */
  unmappedSections: number;
  /**
   * Sections skipped because the live type disagrees with the registry. Their library ids are
   * `PlexMatchSnapshot.typeDisagreementLibraryIds` and are left out of the cross-type delete.
   */
  typeDisagreements: number;
  /** Total Plex titles indexed across all matchable libraries. */
  plexTitlesIndexed: number;
}

export interface PlexMatchSnapshot {
  matches: PlexMatchInput[];
  scopedLibraryIds: string[];
  /**
   * plex_libraries.id skipped because the live section type disagrees with the registry.
   * `syncPlexMatches` leaves these out of the cross-type delete.
   */
  typeDisagreementLibraryIds: string[];
  stats: PlexMatchStats;
}

/**
 * DESIGN-052 D-26 — Plex's `addedAt` (epoch SECONDS) as a Date; null when absent or not a positive finite number. The
 * Trash Age Guard reads a null as "cannot tell", never as "old".
 */
export function plexAddedAt(epochSeconds: number | undefined): Date | null {
  if (epochSeconds === undefined || !Number.isFinite(epochSeconds) || epochSeconds <= 0)
    return null;
  return new Date(epochSeconds * 1000);
}

/** The per-kind GUID lookup order (matched_via preference). */
const MATCH_ORDER: Record<ArrKind, PlexMatchGuidSource[]> = {
  radarr: ['tmdb', 'imdb'],
  sonarr: ['tvdb', 'imdb'],
  lidarr: ['musicbrainz'],
};

/** The media_items field a given GUID source reads, normalized to the Plex index's string key. */
function itemGuidValue(item: MatchCandidateItem, source: PlexMatchGuidSource): string | null {
  switch (source) {
    case 'tmdb':
      return item.tmdbId === null ? null : String(item.tmdbId);
    case 'tvdb':
      return item.tvdbId === null ? null : String(item.tvdbId);
    case 'imdb':
      return item.imdbId ?? null;
    case 'musicbrainz':
      return item.musicbrainzArtistId ?? null;
  }
}

/**
 * ADR-123 / DESIGN-025 D-10 — the index key is library type plus GUID. The same tmdb or tvdb number on a
 * movie and a show is two titles; a lookup uses only the ledger kind's fitting type.
 */
function indexKey(mediaType: PlexMediaType, source: PlexMatchGuidSource, value: string): string {
  return `${mediaType}\u0000${source}\u0000${value}`;
}

/**
 * Read every matchable Plex library across the bundle's servers, page their titles, index them by GUID,
 * then match each live ledger item. Servers/sections that error or are absent from the registry are
 * skipped (not scoped) — a partial read never lets the writer reconcile-drop what it couldn't see.
 */
export async function fetchPlexMatchSnapshot(input: {
  db: DbClient;
  plex: Pick<PlexClientBundle, 'read'>;
  logger?: SyncLogger;
}): Promise<PlexMatchSnapshot> {
  const logger = input.logger ?? noopLogger;
  const items = await selectMatchCandidateItems(input.db);
  const libRefs = await selectPlexLibraryRefs(input.db);

  // (slug, sectionKey) → plex_libraries.id
  const libByKey = new Map<string, PlexLibraryRef>();
  for (const l of libRefs) libByKey.set(`${l.serverSlug}\u0000${l.sectionKey}`, l);

  // The GUID index: `${mediaType}\u0000${source}\u0000${value}` → hits in libraries of that type only.
  // A title mirrored across libraries of its own type yields several hits.
  const guidIndex = new Map<string, PlexHit[]>();
  const scopedLibraryIds = new Set<string>();
  const typeDisagreementLibraryIds = new Set<string>();
  let unmappedSections = 0;
  let typeDisagreements = 0;
  let plexTitlesIndexed = 0;

  const slugs = Object.keys(input.plex.read) as PlexServerSlug[];
  for (const slug of slugs) {
    const read: PlexReadClient = input.plex.read[slug];
    let sections;
    try {
      sections = await read.listSections();
    } catch (error) {
      logger.error('plex-match: listSections failed', {
        server: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      continue; // server unreachable — its libraries stay unscoped (never reconcile-dropped)
    }
    for (const section of sections) {
      if (!MATCHABLE_TYPES.has(section.type)) continue;
      const lib = libByKey.get(`${slug}\u0000${section.key}`);
      if (lib === undefined) {
        unmappedSections += 1;
        logger.info('plex-match: section not in registry (skipped)', {
          server: slug,
          section: section.key,
          title: section.title,
        });
        continue; // no plex_libraries row — cannot FK a match; run a registry refresh first
      }
      if (section.type !== lib.mediaType) {
        // The registry and the live section disagree. Do not index it and do not scope it, and leave
        // the library out of the cross-type delete: the registry type would remove rows that fit the
        // live type, and this skip would not put them back.
        typeDisagreements += 1;
        typeDisagreementLibraryIds.add(lib.libraryId);
        logger.error('plex-match: section type disagrees with the registry (skipped, not scoped)', {
          server: slug,
          section: section.key,
          sectionType: section.type,
          registryType: lib.mediaType,
          libraryId: lib.libraryId,
        });
        continue;
      }
      try {
        let start = 0;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const { items: pageItems, totalSize } = await read.listSectionContentsPage(section.key, {
            start,
            size: PLEX_PAGE_SIZE,
          });
          for (const it of pageItems) indexPlexItem(it, lib.libraryId, lib.mediaType);
          plexTitlesIndexed += pageItems.length;
          start += pageItems.length;
          if (pageItems.length === 0 || (totalSize !== null && start >= totalSize)) break;
        }
        scopedLibraryIds.add(lib.libraryId); // fully read → in reconciliation scope
      } catch (error) {
        logger.error('plex-match: section read failed', {
          server: slug,
          section: section.key,
          error: error instanceof Error ? error.message : String(error),
        });
        // read failed mid-way — do NOT scope this library (avoid dropping matches we didn't fully see)
      }
    }
  }

  function indexPlexItem(
    it: PlexSectionItem,
    plexLibraryId: string,
    mediaType: PlexMediaType,
  ): void {
    const guids = parsePlexGuids(it);
    const add = (source: PlexMatchGuidSource, value: string | undefined) => {
      if (value === undefined) return;
      const key = indexKey(mediaType, source, value);
      const hits = guidIndex.get(key) ?? guidIndex.set(key, []).get(key)!;
      // One hit per library — a section is listed once, so a duplicate library here would be a Plex dupe.
      if (!hits.some((h) => h.plexLibraryId === plexLibraryId)) {
        hits.push({ plexLibraryId, ratingKey: it.ratingKey, addedAt: plexAddedAt(it.addedAt) });
      }
    };
    add('tmdb', guids.tmdb);
    add('imdb', guids.imdb);
    add('tvdb', guids.tvdb);
    add('musicbrainz', guids.musicbrainz);
  }

  // Match each ledger item to ALL libraries any of its GUIDs appear in (dedupe by library; the first GUID
  // source that resolves a given library wins that library's matched_via).
  const matches: PlexMatchInput[] = [];
  const byKind: Record<ArrKind, { total: number; matched: number }> = {
    radarr: { total: 0, matched: 0 },
    sonarr: { total: 0, matched: 0 },
    lidarr: { total: 0, matched: 0 },
  };
  for (const item of items) {
    byKind[item.arrKind].total += 1;
    const perLibrary = new Map<
      string,
      { ratingKey: string; matchedVia: PlexMatchGuidSource; addedAt: Date | null }
    >();
    const mediaType = FITTING_PLEX_MEDIA_TYPE[item.arrKind];
    for (const source of MATCH_ORDER[item.arrKind]) {
      const value = itemGuidValue(item, source);
      if (value === null) continue;
      for (const hit of guidIndex.get(indexKey(mediaType, source, value)) ?? []) {
        if (!perLibrary.has(hit.plexLibraryId)) {
          perLibrary.set(hit.plexLibraryId, {
            ratingKey: hit.ratingKey,
            matchedVia: source,
            addedAt: hit.addedAt,
          });
        }
      }
    }
    for (const [plexLibraryId, { ratingKey, matchedVia, addedAt }] of perLibrary) {
      matches.push({
        mediaItemId: item.id,
        plexLibraryId,
        ratingKey,
        matchedVia,
        plexAddedAt: addedAt,
      });
    }
    if (perLibrary.size > 0) byKind[item.arrKind].matched += 1;
  }

  const scoped = [...scopedLibraryIds];
  const disagreed = [...typeDisagreementLibraryIds];
  return {
    matches,
    scopedLibraryIds: scoped,
    typeDisagreementLibraryIds: disagreed,
    stats: {
      byKind,
      scopedLibraryIds: scoped,
      unmappedSections,
      typeDisagreements,
      plexTitlesIndexed,
    },
  };
}
