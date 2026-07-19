// DESIGN-044 — the collection BUILDER PAGE search + live-preview orchestrator. Two read-only jobs the
// full-page builder needs and the DESIGN-043 Modal composer never had:
//
//  1. searchCollectionRefs — find a source by TYPING (D-04). Books/Audiobooks proxy the confined
//     @hnet/libretto search client; Movies/TV ride the confined @hnet/arr movie/series lookup (a movie
//     search reads its TMDb franchise for tmdb_collection_details; a hand-picked pick reads the id).
//  2. previewCollectionMembers — resolve a DRAFT ref to its members and split them "In your library" vs
//     "Missing" against the app's OWN mirrors (D-05/D-10), never asking a provider "does this estate hold
//     it". Books match books_items by ISBN with the DESIGN-037 conservative title+author fallback; Movies/TV
//     match media_items by tmdb/tvdb id. Honest edges throughout: a 0-member resolve, a truncated list, a
//     URL-ref type the app cannot resolve without new egress (Q-01) all degrade to an honest note, never a
//     fabricated tile, and never a crash — the preview is an aid, not a save gate (the save re-resolves
//     server-side under the real cap).
//
// Everything here is READ-ONLY and mutates nothing (Libretto /api/search + /api/preview and the *arr lookups
// are pure), so it is safe to call on every debounced ref change. All provider calls go through the confined
// clients (ADR-055) — never a browser call.
import { and, eq, isNull } from 'drizzle-orm';
import { ArrError, type ArrImage } from '@hnet/arr';
import {
  booksItems,
  mediaItems,
  mediaMetadata,
  type BooksSource,
  type DbClient,
} from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { resolveDb } from './db-client';
import { normAuthor, normTitle } from './book-requests';
import type { ArrClientBundle } from './arr-clients';
import type { LibrettoClientBundle } from './libretto-clients';

// ── Search (D-04) ──────────────────────────────────────────────────────────────────────────────

/** One search hit the ref field renders — a name a user picks, never a bare slug/id. */
export interface CollectionRefSearchResult {
  /** The value placed in builder.ref (a Hardcover series id, an NYT list name, a TMDb/TVDb id). */
  ref: string;
  /** The human name (also prefills the collection name on pick). */
  name: string;
  /** A secondary line: the author (books), the year (movies/TV), or the franchise note. */
  subtitle?: string | null;
  /** A tertiary hint: the book count, or "part of the <Franchise> collection". */
  detail?: string | null;
  /** A poster the source exposed (movies/TV remotePoster), for the richer result card. */
  posterUrl?: string | null;
  /** Disabled picks stay visible with an honest reason (e.g. a movie in no franchise). */
  disabled?: boolean;
  disabledReason?: string | null;
}

export interface CollectionRefSearchResponse {
  results: CollectionRefSearchResult[];
  /** True when the source had more matches than were returned. */
  truncated: boolean;
  /** False when the search backend was unreachable — the field degrades to manual entry (D-04). */
  reachable: boolean;
}

const UNREACHABLE_SEARCH: CollectionRefSearchResponse = {
  results: [],
  truncated: false,
  reachable: false,
};

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;

/** The Movies/TV builder types the ref search resolves through @hnet/arr lookup. */
const ARR_SEARCH_BUILDERS = new Set([
  'tmdb_collection_details',
  'tmdb_movie',
  'tmdb_show',
  'tvdb_show',
]);

/** Guard a lookup, mapping an *arr/Libretto outage to an honest unreachable (never a crash). */
async function guardSearch(
  fn: () => Promise<CollectionRefSearchResponse>,
): Promise<CollectionRefSearchResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError || err instanceof LibrettoUnreachableError) return UNREACHABLE_SEARCH;
    throw err;
  }
}

/**
 * DESIGN-044 D-04 — typeahead for a builder's ref. Books/Audiobooks proxy the confined Libretto search;
 * Movies/TV ride the confined @hnet/arr lookup. The caller owns debounce; the limit is clamped here.
 */
export async function searchCollectionRefs(input: {
  libretto: LibrettoClientBundle;
  arr: ArrClientBundle;
  builderType: string;
  q: string;
  limit?: number;
}): Promise<CollectionRefSearchResponse> {
  const q = input.q.trim();
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT));
  if (q.length === 0) return { results: [], truncated: false, reachable: true };

  if (ARR_SEARCH_BUILDERS.has(input.builderType)) {
    return guardSearch(() => searchArrRefs({ arr: input.arr, builderType: input.builderType, q, limit }));
  }
  // Books/Audiobooks (hardcover_series, nyt_list) — static_ids searches hardcover too (Shape C multi-add).
  return guardSearch(async () => {
    const res = await input.libretto.read.search({ type: input.builderType, q, limit });
    const results: CollectionRefSearchResult[] = (res.results ?? []).map((r) => ({
      ref: r.ref,
      name: r.name ?? r.ref,
      subtitle: r.author ?? null,
      detail: r.workCount != null ? `${r.workCount} book${r.workCount === 1 ? '' : 's'}` : null,
    }));
    return { results, truncated: res.truncated ?? false, reachable: true };
  });
}

/** Movies/TV ref search through the confined @hnet/arr lookup (D-04). */
async function searchArrRefs(input: {
  arr: ArrClientBundle;
  builderType: string;
  q: string;
  limit: number;
}): Promise<CollectionRefSearchResponse> {
  const { builderType, q, limit } = input;
  if (builderType === 'tmdb_collection_details') {
    // Search a MOVIE; read its TMDb franchise (collection) as the ref. A movie with no franchise stays
    // visible but disabled with the honest note (D-04). Dedup franchises by their collection id.
    const movies = await input.arr.read.radarr.lookupMovie(q);
    const seen = new Set<string>();
    const results: CollectionRefSearchResult[] = [];
    for (const m of movies) {
      const collection = m.collection ?? null;
      const franchiseName = collection?.name ?? collection?.title ?? null;
      const franchiseId = collection?.tmdbId ?? null;
      if (collection && franchiseName && franchiseId != null) {
        const ref = String(franchiseId);
        if (seen.has(ref)) continue;
        seen.add(ref);
        results.push({
          ref,
          name: franchiseName,
          subtitle: m.year != null ? `found via ${m.title} (${m.year})` : `found via ${m.title}`,
          detail: `part of the ${franchiseName} collection`,
          posterUrl: m.remotePoster ?? null,
        });
      } else {
        results.push({
          ref: '',
          name: m.title,
          subtitle: m.year != null ? String(m.year) : null,
          posterUrl: m.remotePoster ?? null,
          disabled: true,
          disabledReason: 'this movie is not part of a franchise',
        });
      }
      if (results.length >= limit) break;
    }
    return { results, truncated: movies.length > results.length, reachable: true };
  }

  if (builderType === 'tmdb_movie') {
    const movies = await input.arr.read.radarr.lookupMovie(q);
    const results = movies
      .filter((m) => m.tmdbId != null)
      .slice(0, limit)
      .map((m) => ({
        ref: String(m.tmdbId),
        name: m.title,
        subtitle: m.year != null ? String(m.year) : null,
        posterUrl: m.remotePoster ?? null,
      }));
    return { results, truncated: movies.length > results.length, reachable: true };
  }

  // tmdb_show / tvdb_show — Sonarr series lookup; the ref is the show's tmdbId / tvdbId per builder (D-04).
  const shows = await input.arr.read.sonarr.lookupSeries(q);
  const useTvdb = builderType === 'tvdb_show';
  const results = shows
    .filter((s) => (useTvdb ? s.tvdbId != null : s.tmdbId != null))
    .slice(0, limit)
    .map((s) => ({
      ref: String(useTvdb ? s.tvdbId : s.tmdbId),
      name: s.title,
      subtitle: s.year != null ? String(s.year) : null,
      posterUrl: s.remotePoster ?? null,
    }));
  return { results, truncated: shows.length > results.length, reachable: true };
}

// ── Preview (D-05 / D-10) ────────────────────────────────────────────────────────────────────

/** One resolved member tile, already split held vs missing against the app's mirrors (D-10). */
export interface PreviewMemberTile {
  /** A stable key for React lists (ISBN / id / a title fallback). */
  key: string;
  title: string;
  /** Author (books) or year (movies/TV). */
  subtitle?: string | null;
  /** True when the estate holds this member (the "In your library" group). */
  held: boolean;
  /** Books honesty flag (D-05/Q-03): held via the title+author fallback, not an ISBN match. */
  matchedByTitle?: boolean;
  /** Series position / list rank, when the source is ordered. */
  position?: number | null;
  posterUrl?: string | null;
}

export interface CollectionPreview {
  /** False when the app cannot resolve this ref type without new egress (Q-01) — an honest note, not a tile. */
  available: boolean;
  /** The honest reason when available=false. */
  unavailableReason?: string | null;
  /** The full resolved membership count (before the per-user cap). */
  total: number;
  /** True when the provider truncated the member list (Libretto caps at 100). */
  truncated: boolean;
  heldCount: number;
  missingCount: number;
  /** Held tiles then missing tiles (each group already counted above). */
  members: PreviewMemberTile[];
}

const PREVIEW_UNAVAILABLE = (reason: string): CollectionPreview => ({
  available: false,
  unavailableReason: reason,
  total: 0,
  truncated: false,
  heldCount: 0,
  missingCount: 0,
  members: [],
});

// ── Poster resolution (DESIGN-044 D-05 poster polish, owner ruling 2026-07-18) ──────────────────
// A HELD member renders the wall's OWN artwork idiom against the app's mirror — the authed poster/cover
// proxy, exactly as the Library and Books walls build it (ADR-019 / ADR-046). A MISSING member has no mirror
// row (nothing to proxy), so it falls back to the artwork the provider lookup already returned (the *arr
// remotePoster / collection-member image). Books missing keep the honest placeholder (Libretto exposes no
// cover). These builders live in @hnet/domain (below @hnet/api), so the proxy paths are constructed here to
// the same contract the api-side helpers (posterUrlFor / booksCoverUrlFor) emit — a trivial path string, not
// a re-export, to respect the package layering.

/** The authed poster-proxy URL for a held Movies/TV mirror row (ADR-019) — null when the row has no poster. */
function heldPosterProxyUrl(mediaItemId: string, posterSource: string | null): string | null {
  return posterSource === null ? null : `/api/posters/${mediaItemId}`;
}

/** The authed cover-proxy URL for a held Books/Audiobooks mirror row (ADR-046) — null when it has no cover. */
function heldCoverProxyUrl(source: string, externalId: string, coverRef: string | null): string | null {
  if (!coverRef) return null;
  return `/api/books/cover?source=${encodeURIComponent(source)}&id=${encodeURIComponent(externalId)}&v=${encodeURIComponent(coverRef)}`;
}

/** Pick a provider poster image URL from an *arr image array (the collection-member `images[]`, D-05). */
function posterFromArrImages(images: ArrImage[] | null | undefined): string | null {
  if (!images) return null;
  const poster = images.find((i) => i.coverType === 'poster') ?? images[0];
  return poster?.remoteUrl ?? null;
}

/** The Movies/TV builder types whose members cannot be resolved without new egress (D-05 / Q-01). */
const URL_REF_BUILDERS = new Set(['imdb_list', 'tvdb_list_details']);
/** The Movies/TV id-list builders whose exact members the app knows and can resolve (D-05). */
const ARR_ID_LIST_BUILDERS = new Set(['tmdb_movie', 'tmdb_show', 'tvdb_show']);

/** Bound the number of ids a single preview resolves (a hand-picked list is small; guard a pathological one). */
const MAX_PREVIEW_IDS = 60;

/**
 * DESIGN-044 D-05/D-10 — resolve a DRAFT builder to its members split held vs missing against the app's
 * mirrors. Books/Audiobooks resolve through Libretto preview; Movies/TV resolve id-lists through @hnet/arr
 * lookup and franchises through the Radarr collection read. A URL-ref builder (or an outage) returns the
 * honest unavailable state. Mutates nothing.
 */
export async function previewCollectionMembers(input: {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  arr: ArrClientBundle;
  mediaType: 'movies' | 'tv' | 'books' | 'audiobooks';
  builderType: string;
  /** A string for a single ref; a string array for an id-list builder. */
  ref: string | string[];
}): Promise<CollectionPreview> {
  const { mediaType, builderType } = input;
  if (mediaType === 'books' || mediaType === 'audiobooks') {
    return previewBooksMembers({ ...input, mediaType });
  }
  const movieTvMedia = mediaType; // narrowed to 'movies' | 'tv'
  // Movies / TV.
  if (URL_REF_BUILDERS.has(builderType)) {
    return PREVIEW_UNAVAILABLE(
      'Preview is unavailable for a list link. The full list resolves on the next collection run.',
    );
  }
  try {
    if (builderType === 'tmdb_collection_details') {
      return await previewMovieFranchise(input);
    }
    if (ARR_ID_LIST_BUILDERS.has(builderType)) {
      return await previewArrIdList({ ...input, mediaType: movieTvMedia });
    }
  } catch (err) {
    if (err instanceof ArrError) {
      return PREVIEW_UNAVAILABLE('The catalog service was unreachable, so a preview is not available right now.');
    }
    throw err;
  }
  return PREVIEW_UNAVAILABLE('Preview is unavailable for this reference type.');
}

/** Extract an ISBN-13/10 from a raw string (strip formatting; keep digits + a trailing X). */
function normIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9xX]/g, '').toUpperCase();
  return cleaned.length >= 10 ? cleaned : null;
}

/** Pull the ISBNs a member carries (its `isbn` plus any `isbn:` identifier ref). */
function memberIsbns(member: { isbn?: string | null; identifiers?: string[] | null }): string[] {
  const out = new Set<string>();
  const primary = normIsbn(member.isbn);
  if (primary) out.add(primary);
  for (const id of member.identifiers ?? []) {
    const m = /^isbn:(.+)$/i.exec(id.trim());
    const isbn = normIsbn(m?.[1] ?? id);
    if (isbn) out.add(isbn);
  }
  return [...out];
}

/** Books/Audiobooks preview: Libretto members + the D-10 held-match against books_items for the tab source. */
async function previewBooksMembers(input: {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  mediaType: 'books' | 'audiobooks';
  builderType: string;
  ref: string | string[];
}): Promise<CollectionPreview> {
  let res;
  try {
    res = await input.libretto.read.preview({ builder: { type: input.builderType, ref: input.ref } });
  } catch (err) {
    if (err instanceof LibrettoUnreachableError) {
      return PREVIEW_UNAVAILABLE('The collections service was unreachable, so a preview is not available right now.');
    }
    throw err;
  }
  const members = res.members ?? [];
  const total = res.total ?? members.length;

  // The tab's source: books ⇐ kavita, audiobooks ⇐ audiobookshelf (D-10 source→media map).
  const source: BooksSource = input.mediaType === 'audiobooks' ? 'audiobookshelf' : 'kavita';
  const rows = await resolveDb(input.db)
    .select({
      title: booksItems.title,
      author: booksItems.author,
      isbn: booksItems.isbn,
      externalId: booksItems.externalId,
      coverRef: booksItems.coverRef,
    })
    .from(booksItems)
    .where(and(eq(booksItems.source, source), isNull(booksItems.deletedAt)));

  // The mirror row a held member resolves to — carries its cover reference so a held tile renders the Books
  // wall's OWN cover proxy (ADR-046), never the placeholder. Author rides along for the title-fallback check.
  type HeldBookRow = { author: string | null; externalId: string; coverRef: string | null };
  // Two indices: an exact ISBN → row map, and the DESIGN-037 conservative normalized title → rows fallback for
  // the many Kavita rows whose ISBN is null.
  const isbnMap = new Map<string, HeldBookRow>();
  const titleIndex = new Map<string, HeldBookRow[]>(); // normTitle → rows
  for (const r of rows) {
    const row: HeldBookRow = { author: r.author, externalId: r.externalId, coverRef: r.coverRef };
    const isbn = normIsbn(r.isbn);
    if (isbn && !isbnMap.has(isbn)) isbnMap.set(isbn, row);
    const key = normTitle(r.title);
    if (!key) continue;
    const bucket = titleIndex.get(key) ?? [];
    bucket.push(row);
    titleIndex.set(key, bucket);
  }

  const held: PreviewMemberTile[] = [];
  const missing: PreviewMemberTile[] = [];
  members.forEach((m, i) => {
    const title = m.title ?? m.label ?? `Book ${i + 1}`;
    let matched: HeldBookRow | undefined;
    for (const isbn of memberIsbns(m)) {
      matched = isbnMap.get(isbn);
      if (matched) break;
    }
    const isbnHit = matched !== undefined;
    let titleHit = false;
    if (!isbnHit) {
      const bucket = titleIndex.get(normTitle(title));
      if (bucket && bucket.length > 0) {
        const wantAuthor = normAuthor(m.author ?? null);
        matched = wantAuthor
          ? bucket.find(
              (r) =>
                normAuthor(r.author) &&
                (normAuthor(r.author).includes(wantAuthor) ||
                  wantAuthor.includes(normAuthor(r.author))),
            )
          : bucket[0];
        titleHit = matched !== undefined;
      }
    }
    const heldMember = isbnHit || titleHit;
    const tile: PreviewMemberTile = {
      key: memberIsbns(m)[0] ?? `t:${normTitle(title)}:${i}`,
      title,
      subtitle: m.author ?? null,
      held: heldMember,
      matchedByTitle: !isbnHit && titleHit,
      position: m.position ?? null,
      // Held ⇒ the app's own Books cover proxy (the wall idiom); missing ⇒ null (Libretto has no cover art).
      posterUrl:
        heldMember && matched ? heldCoverProxyUrl(source, matched.externalId, matched.coverRef) : null,
    };
    (tile.held ? held : missing).push(tile);
  });

  return {
    available: true,
    total,
    truncated: res.truncated ?? false,
    heldCount: held.length,
    missingCount: missing.length,
    members: [...held, ...missing],
  };
}

/** Movies/TV id-list preview: resolve each id through @hnet/arr lookup + held-match against media_items. */
async function previewArrIdList(input: {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaType: 'movies' | 'tv';
  builderType: string;
  ref: string | string[];
}): Promise<CollectionPreview> {
  const rawIds = (Array.isArray(input.ref) ? input.ref : String(input.ref).split(','))
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  const ids = [...new Set(rawIds)].slice(0, MAX_PREVIEW_IDS);
  if (ids.length === 0) return PREVIEW_UNAVAILABLE('Add a title to see what this collection will hold.');

  const isMovie = input.builderType === 'tmdb_movie';
  const useTvdb = input.builderType === 'tvdb_show';

  // The mirror held-map for the id kind (movies ⇐ radarr.tmdb_id; tv ⇐ sonarr.tvdb_id/tmdb_id).
  const heldMap = await loadMediaHeldMap(input.db, isMovie ? 'radarr' : 'sonarr', useTvdb ? 'tvdb' : 'tmdb');

  const held: PreviewMemberTile[] = [];
  const missing: PreviewMemberTile[] = [];
  for (const id of ids) {
    let title = `${isMovie ? 'Movie' : 'Show'} #${id}`;
    let year: number | null = null;
    let remotePoster: string | null = null;
    try {
      if (isMovie) {
        const [m] = await input.arr.read.radarr.lookupMovie(`tmdb:${id}`);
        if (m) {
          title = m.title;
          year = m.year ?? null;
          remotePoster = m.remotePoster ?? posterFromArrImages(m.images);
        }
      } else {
        const term = useTvdb ? `tvdb:${id}` : `tmdb:${id}`;
        const [s] = await input.arr.read.sonarr.lookupSeries(term);
        if (s) {
          title = s.title;
          year = s.year ?? null;
          remotePoster = s.remotePoster ?? posterFromArrImages(s.images);
        }
      }
    } catch (err) {
      if (!(err instanceof ArrError)) throw err;
      // A single lookup miss keeps the id honest as a bare tile — never drops the member.
    }
    const heldRow = heldMap.get(Number(id));
    const tile: PreviewMemberTile = {
      key: id,
      title,
      subtitle: year != null ? String(year) : null,
      held: heldRow !== undefined,
      // Held ⇒ the app's own poster proxy (the wall idiom); missing ⇒ the provider's remotePoster.
      posterUrl: heldRow
        ? heldPosterProxyUrl(heldRow.mediaItemId, heldRow.posterSource)
        : remotePoster,
    };
    (tile.held ? held : missing).push(tile);
  }
  return {
    available: true,
    total: ids.length,
    truncated: rawIds.length > ids.length,
    heldCount: held.length,
    missingCount: missing.length,
    members: [...held, ...missing],
  };
}

/** Movie-franchise preview: the Radarr collection whose TMDb id is the ref, split held vs missing. */
async function previewMovieFranchise(input: {
  db?: DbClient;
  arr: ArrClientBundle;
  ref: string | string[];
}): Promise<CollectionPreview> {
  const ref = Array.isArray(input.ref) ? input.ref[0] : input.ref;
  const tmdbId = Number(String(ref).trim());
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    return PREVIEW_UNAVAILABLE('Preview is unavailable for this reference. Pick a franchise from the search.');
  }
  // Radarr tracks TMDb Collections with their full member set; find the one whose id is the ref. A franchise
  // Radarr does not track yet cannot be previewed without new egress — the honest note (D-05).
  const collections = await input.arr.read.radarr.listCollections();
  const collection = collections.find((c) => c.tmdbId === tmdbId);
  if (!collection || !collection.movies || collection.movies.length === 0) {
    return PREVIEW_UNAVAILABLE(
      'A preview for this franchise is not available yet. Its films resolve on the next collection run.',
    );
  }
  const heldMap = await loadMediaHeldMap(input.db, 'radarr', 'tmdb');
  const held: PreviewMemberTile[] = [];
  const missing: PreviewMemberTile[] = [];
  for (const m of collection.movies) {
    const heldRow = heldMap.get(m.tmdbId);
    const tile: PreviewMemberTile = {
      key: String(m.tmdbId),
      title: m.title ?? `Movie #${m.tmdbId}`,
      held: heldRow !== undefined,
      // Held ⇒ the app's own poster proxy (the wall idiom); missing ⇒ the collection member's provider art
      // (the D-05 franchise-poster fix — the collection endpoint already carries each film's images[]).
      posterUrl: heldRow
        ? heldPosterProxyUrl(heldRow.mediaItemId, heldRow.posterSource)
        : posterFromArrImages(m.images),
    };
    (tile.held ? held : missing).push(tile);
  }
  return {
    available: true,
    total: collection.movies.length,
    truncated: false,
    heldCount: held.length,
    missingCount: missing.length,
    members: [...held, ...missing],
  };
}

/** One held mirror row: its external id plus what a held tile needs to render the wall's poster proxy. */
interface HeldMediaRow {
  mediaItemId: string;
  posterSource: string | null;
}

/**
 * Load the mirror's held external-id → row map for a kind (radarr ⇒ tmdb; sonarr ⇒ tvdb or tmdb). Left-joins
 * media_metadata for the poster source so a held tile can build the authed poster proxy (ADR-019) — the same
 * artwork idiom the Library wall uses, never the provider hotlink. First row per external id wins.
 */
async function loadMediaHeldMap(
  db: DbClient | undefined,
  arrKind: 'radarr' | 'sonarr',
  idKind: 'tmdb' | 'tvdb',
): Promise<Map<number, HeldMediaRow>> {
  const col = idKind === 'tvdb' ? mediaItems.tvdbId : mediaItems.tmdbId;
  const rows = await resolveDb(db)
    .select({ v: col, id: mediaItems.id, posterSource: mediaMetadata.posterSource })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(eq(mediaItems.arrKind, arrKind), isNull(mediaItems.deletedFromArrAt)));
  const map = new Map<number, HeldMediaRow>();
  for (const r of rows) {
    if (r.v == null || map.has(r.v)) continue;
    map.set(r.v, { mediaItemId: r.id, posterSource: r.posterSource ?? null });
  }
  return map;
}
