// ADR-093 / DESIGN-052 D-02 (PLAN-072) — a Seerr user's watchlist, CLASSIFIED BY CONTENT, never by status.
//
// Seerr 3.4.1's `PlexTvAPI.getWatchlist` wraps the discover call and the page's per-item metadata fetches in one
// try/catch and, on ANY error (a revoked stored token, a plex.tv 5xx/429/timeout, one failed metadata fetch), answers
// HTTP 200 `{page, totalPages: 0, totalResults: 0, results: []}` — the same body as an empty list, on any page. So:
//
// 1. page 1 fixes `totalResults` / `totalPages`; pages 2..totalPages are read in order (at most 50);
// 2. the read is INCONSISTENT when a later page reports other totals (`totalPages: 0` included), a page before the
//    last returns no results, or a page repeats a ratingKey of an earlier page (Seerr's per-token ETag cache answering
//    one page with another's body, Q-03). An inconsistent read is repeated once from page 1 after 2 s; a second
//    inconsistent read is FAILED;
// 3. `totalResults: 0` is EMPTY (repeated once after 2 s first); the registry decides whether empty is ok (D-04);
// 4. non-200, non-JSON, a ratingKey that is not 24-hex or a mediaType other than movie/tv is FAILED;
// 5. the results are NOT summed against totalResults: Seerr legitimately drops items with no tmdb guid or a 404.
import { ArrHttpError, ArrParseError, ArrTimeoutError } from './errors';
import type { SeerrWatchlistPage } from './schemas/seerr';

/** D-02 — at most this many pages per user. */
export const SEERR_MAX_WATCHLIST_PAGES = 50;
/** D-02 — the wait before repeating an inconsistent (or empty) read. */
export const SEERR_REREAD_DELAY_MS = 2_000;

/** One watchlist title as the registry keys it (D-03): the discover id, the kind, and Seerr's tmdb id. */
export interface SeerrWatchlistItem {
  discoverId: string;
  kind: 'movie' | 'show';
  tmdbId: number | null;
}

/** A classified Seerr watchlist read (D-02). */
export type SeerrWatchlistAnswer =
  | { kind: 'ok'; items: SeerrWatchlistItem[]; totalResults: number }
  | { kind: 'empty' }
  | { kind: 'failed'; errorClass: string };

export interface ReadSeerrWatchlistOptions {
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}

const DISCOVER_ID = /^[0-9a-f]{24}$/;

const defaultSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** A stable error class for a failed Seerr call (never the body). */
export function seerrErrorClass(error: unknown): string {
  if (error instanceof ArrHttpError) return `http_${error.status}`;
  if (error instanceof ArrTimeoutError) return 'timeout';
  if (error instanceof ArrParseError) return 'parse';
  return 'network';
}

type OnePass =
  | { kind: 'ok'; items: SeerrWatchlistItem[]; totalResults: number }
  | { kind: 'empty' }
  | { kind: 'inconsistent' }
  | { kind: 'failed'; errorClass: string };

function mapItems(page: SeerrWatchlistPage): SeerrWatchlistItem[] | { errorClass: string } {
  const out: SeerrWatchlistItem[] = [];
  for (const r of page.results) {
    const key = typeof r.ratingKey === 'string' ? r.ratingKey.trim().toLowerCase() : '';
    if (!DISCOVER_ID.test(key)) return { errorClass: 'bad_rating_key' };
    const kind = r.mediaType === 'movie' ? 'movie' : r.mediaType === 'tv' ? 'show' : null;
    if (kind === null) return { errorClass: 'bad_media_type' };
    const tmdb =
      typeof r.tmdbId === 'number' && Number.isSafeInteger(r.tmdbId) && r.tmdbId > 0
        ? r.tmdbId
        : null;
    out.push({ discoverId: key, kind, tmdbId: tmdb });
  }
  return out;
}

async function onePass(
  readPage: (page: number) => Promise<SeerrWatchlistPage>,
  maxPages: number,
): Promise<OnePass> {
  let first: SeerrWatchlistPage;
  try {
    first = await readPage(1);
  } catch (error) {
    return { kind: 'failed', errorClass: seerrErrorClass(error) };
  }
  const firstItems = mapItems(first);
  if (!Array.isArray(firstItems)) return { kind: 'failed', errorClass: firstItems.errorClass };
  const { totalResults, totalPages } = first;
  if (totalResults <= 0)
    return firstItems.length === 0 ? { kind: 'empty' } : { kind: 'inconsistent' };
  if (totalPages > maxPages) return { kind: 'failed', errorClass: 'too_many_pages' };
  if (totalPages < 1) return { kind: 'inconsistent' };
  if (firstItems.length === 0 && totalPages > 1) return { kind: 'inconsistent' }; // an empty page before the last

  const items: SeerrWatchlistItem[] = [];
  const seenEarlier = new Set<string>();
  const addPage = (pageItems: SeerrWatchlistItem[]): boolean => {
    const thisPage = new Set<string>();
    for (const item of pageItems) {
      if (seenEarlier.has(item.discoverId)) return false; // a page repeating an earlier page's ratingKey
      if (thisPage.has(item.discoverId)) continue; // a duplicate inside one page: kept once, never an abort
      thisPage.add(item.discoverId);
      items.push(item);
    }
    for (const id of thisPage) seenEarlier.add(id);
    return true;
  };
  addPage(firstItems);

  for (let p = 2; p <= totalPages; p += 1) {
    let page: SeerrWatchlistPage;
    try {
      page = await readPage(p);
    } catch (error) {
      return { kind: 'failed', errorClass: seerrErrorClass(error) };
    }
    if (page.totalResults !== totalResults || page.totalPages !== totalPages)
      return { kind: 'inconsistent' };
    const pageItems = mapItems(page);
    if (!Array.isArray(pageItems)) return { kind: 'failed', errorClass: pageItems.errorClass };
    if (pageItems.length === 0 && p < totalPages) return { kind: 'inconsistent' };
    if (!addPage(pageItems)) return { kind: 'inconsistent' };
  }
  return { kind: 'ok', items, totalResults };
}

/**
 * Read one Seerr user's whole watchlist and classify it (D-02 rules 1..5). `readPage` is
 * `SeerrClient.getUserWatchlistPage` bound to the user; pages are read strictly in order (Q-03).
 */
export async function readSeerrUserWatchlist(
  readPage: (page: number) => Promise<SeerrWatchlistPage>,
  options: ReadSeerrWatchlistOptions = {},
): Promise<SeerrWatchlistAnswer> {
  const sleep = options.sleep ?? defaultSleep;
  const maxPages = options.maxPages ?? SEERR_MAX_WATCHLIST_PAGES;
  const first = await onePass(readPage, maxPages);
  if (first.kind === 'ok' || first.kind === 'failed') return first;
  // Inconsistent, or empty: repeat once from page 1 after 2 s before classing it.
  await sleep(SEERR_REREAD_DELAY_MS);
  const second = await onePass(readPage, maxPages);
  if (second.kind === 'inconsistent') return { kind: 'failed', errorClass: 'inconsistent' };
  return second;
}
