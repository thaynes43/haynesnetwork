// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the READ-ONLY snapshot fetcher the `books-sync`
// mode hands to the @hnet/domain syncBooks single-writer. It pages Kavita (Books + Comics libraries) and
// Audiobookshelf (Audio Books) and NORMALIZES each series/item to a BooksItemInput (the wire-shape parsing
// lives here — @hnet/sync knows the servers' shapes; the domain writer only persists). Never a live
// cross-DB read; never a write to the book servers.
import type { AbsItem, KavitaSeries, KavitaSeriesMetadata, KavitaVolume } from '@hnet/books';
import { kavitaLibraryKind, type AudiobookshelfClient, type KavitaClient } from '@hnet/books/read';
import type { BooksSource } from '@hnet/db';
import { isForeignLanguage, type BooksItemInput, type HeldBook } from '@hnet/domain';
import { noopLogger, type SyncLogger } from './logger';

const KAVITA_PAGE_SIZE = 500;
const ABS_PAGE_SIZE = 500;
/** Safety cap on pages per library so a bad `total` header can never loop forever. */
const MAX_PAGES = 200;

/** The read clients + public deep-link bases the books-sync mode needs. */
export interface BooksSyncBundle {
  kavita: KavitaClient;
  audiobookshelf: AudiobookshelfClient;
  kavitaPublicUrl: string;
  audiobookshelfPublicUrl: string;
}

export interface BooksSnapshot {
  rows: BooksItemInput[];
  /** Sources whose snapshot is COMPLETE (all libraries paged without error) — tombstoning scope. */
  syncedSources: BooksSource[];
  counts: { kavitaSeries: number; absItems: number };
}

// ---------------------------------------------------------------------------
// Normalizers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

const basename = (p: string): string => {
  const parts = p.split('/').filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : '';
};

/**
 * Best-effort author from a Kavita series' folder paths. For books the series folder sits UNDER an author
 * folder (`folderPath` = `…/EBooks/Charlaine Harris`, `lowestFolderPath` = `…/Charlaine Harris/<series>`),
 * so folderPath's basename is the author. For comics both paths are equal (no author folder) → null.
 */
export function deriveKavitaAuthor(
  folderPath: string | null | undefined,
  lowestFolderPath: string | null | undefined,
): string | null {
  if (!folderPath || !lowestFolderPath) return null;
  if (lowestFolderPath === folderPath) return null;
  if (!lowestFolderPath.startsWith(`${folderPath}/`)) return null;
  const author = basename(folderPath);
  return author.length > 0 ? author : null;
}

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * DESIGN-024 D-01 amendment (detail-page parity) — reduce Kavita/ABS description HTML to plain text.
 * Kavita `summary` and some ABS `description` values carry light HTML (`<div class="blurb">…</div>`,
 * `<br>`, entities). Strip tags, collapse whitespace, decode the handful of entities that actually
 * appear. Blank → null (an empty summary must collapse the About text, not render an empty block).
 */
export function stripHtml(input: string | null | undefined): string | null {
  if (!input) return null;
  const BREAK = '\u0001'; // paragraph-break marker inserted at block ends, split on BEFORE collapse
  const marked = input
    // Block ends -> a paragraph break; a <br> is a soft break -> space. Raw newlines INSIDE a block are
    // SOFT wraps (the live Kavita summaries hard-wrap mid-sentence) - collapsed per-paragraph below.
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\/(p|div|li)\s*>/gi, BREAK)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  const text = marked
    .split(BREAK)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter((para) => para.length > 0)
    .join('\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

/** A named metadata entity as Kavita returns it (GenreTagDto `title` / PersonDto `name` / a bare string). */
type KavitaNamed = string | { name?: string; title?: string };
const kavitaName = (v: KavitaNamed): string =>
  (typeof v === 'string' ? v : (v.title ?? v.name ?? '')).trim();
const kavitaNames = (arr: KavitaNamed[] | null | undefined): string[] =>
  (arr ?? []).map(kavitaName).filter((s) => s.length > 0);

/** The subset of the Kavita metadata call the ledger row consumes (About/Details enrichment). */
export interface KavitaEnrichment {
  summary: string | null;
  genres: string[];
  publisher: string | null;
  language: string | null;
  year: number | null;
  /** Metadata writers — the AUTHOR fallback for flat folder layouts (first entry wins). */
  writers: string[];
}

/** Reduce a Kavita `/api/Series/metadata` response to the ledger enrichment (pure — unit-tested). */
export function kavitaEnrichmentFrom(meta: KavitaSeriesMetadata): KavitaEnrichment {
  const publishers = kavitaNames(meta.publishers as KavitaNamed[] | null | undefined);
  const language = (meta.language ?? '').trim();
  // Kavita returns releaseYear 0 for "unset" — treat 0/negatives as absent (honest null).
  const year = typeof meta.releaseYear === 'number' && meta.releaseYear > 0 ? meta.releaseYear : null;
  return {
    summary: stripHtml(meta.summary),
    genres: kavitaNames(meta.genres as KavitaNamed[] | null | undefined),
    publisher: publishers.length > 0 ? publishers[0]! : null,
    language: language.length > 0 ? language : null,
    year,
    writers: kavitaNames(meta.writers as KavitaNamed[] | null | undefined),
  };
}

/** A Kavita chapter `title` that is only a number ('-100000' on a numbered volume, '3', '0.5') names no book. */
const numericPlaceholder = (v: string): boolean => /^-?\d+(\.\d+)?$/.test(v.trim());

/**
 * Issue #661 (DESIGN-024 D-01 amendment 2026-10-04) — reduce `GET /api/Series/volumes` to the books the
 * series holds: one HeldBook per chapter (in an EBooks library a chapter is one book file), carrying the
 * chapter's own title (`titleName`, else a non-numeric `title`), all Writers and ISBN. Raw values, no
 * cleaning and no de-duplication (the pairing leg does both). Pure — unit-tested.
 */
export function kavitaHeldBooksFrom(volumes: readonly KavitaVolume[]): HeldBook[] {
  const out: HeldBook[] = [];
  for (const v of volumes) {
    for (const ch of v.chapters ?? []) {
      const titleName = (ch.titleName ?? '').trim();
      const title = (ch.title ?? '').trim();
      const writers = kavitaNames(ch.writers as KavitaNamed[] | null | undefined);
      const isbn = (ch.isbn ?? '').trim();
      out.push({
        title: titleName || (title && !numericPlaceholder(title) ? title : null),
        author: writers.length > 0 ? writers[0]! : null,
        authors: writers,
        isbn: isbn.length > 0 ? isbn : null,
      });
    }
  }
  return out;
}

/**
 * ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — Date Released) — parse the ABS `publishedDate` metadata
 * string to a Date (e.g. "2020-05-01" or a full ISO instant). Blank / unparseable ⇒ null (the item
 * keeps only its January-1 `year`). Exported for the ABS normalizer unit tests.
 */
export function absReleasedAt(publishedDate: string | null | undefined): Date | null {
  return toDate(publishedDate);
}

/**
 * DESIGN-024 D-01 amendment (detail-page parity) — the enrichment applied to a Kavita row: either
 * FRESHLY fetched from `/api/Series/metadata` this run, or CARRIED FORWARD from the existing mirror
 * row (the change-gate — an unchanged series is not re-fetched, so its last enrichment rides along
 * and the upsert stays a clean full-replace). `null` ⇒ a new series not yet enriched (all-null).
 */
export interface KavitaEnrichmentApply {
  data: KavitaEnrichment;
  metadataSyncedAt: Date | null;
}

export function normalizeKavitaSeries(
  series: KavitaSeries,
  mediaKind: 'book' | 'comic',
  libraryName: string,
  publicUrl: string,
  enrichment: KavitaEnrichmentApply | null = null,
  /** Issue #661 — the books a BOOK series holds (`attrs.heldBooks`); undefined = not read (omitted). */
  heldBooks?: HeldBook[],
  heldBooksSyncedAt?: Date | null,
): BooksItemInput {
  const libraryId = String(series.libraryId);
  const sort = (series.sortName || series.name || String(series.id)).trim().toLowerCase();
  const e = enrichment?.data ?? null;
  return {
    source: 'kavita',
    mediaKind,
    externalId: String(series.id),
    libraryId,
    libraryName: series.libraryName || libraryName,
    title: series.name,
    sortTitle: sort,
    // Folder-derived author stays PRIMARY (the Calibre-style author directory); the metadata
    // writers fill the FLAT-layout gap (54 live null-author series held their writer in Kavita
    // all along — the 2026-07-21 pairing-gap diagnosis). Comics keep their honest null unless
    // Kavita carries a writer for them too.
    author:
      deriveKavitaAuthor(series.folderPath, series.lowestFolderPath) ?? (e?.writers[0] ?? null),
    narrator: null,
    seriesName: null,
    // The series list carries no year; the metadata call's releaseYear fills it when enriched.
    year: e?.year ?? null,
    // DESIGN-026 D-05 — Kavita carries no precise release date → honest null (only a year).
    releasedAt: null,
    genres: e?.genres ?? [],
    coverRef: series.coverImage ?? null,
    deepLinkUrl: `${publicUrl}/library/${libraryId}/series/${series.id}`,
    pageCount: series.pages ?? null,
    wordCount: series.wordCount ?? null,
    durationSeconds: null,
    // Kavita size/isbn/file_count live in the heavier series-detail call we deliberately skip
    // (the M2 ISBN caveat + one-call-per-series pacing) → honest null for Kavita rows.
    sizeBytes: null,
    summary: e?.summary ?? null,
    publisher: e?.publisher ?? null,
    isbn: null,
    fileCount: null,
    metadataSyncedAt: enrichment?.metadataSyncedAt ?? null,
    // language stays in attrs (the facet reads it there); enrichment fills it for Kavita.
    attrs: {
      format: series.format ?? null,
      language: e?.language ?? null,
      ...(heldBooks !== undefined
        ? {
            heldBooks,
            ...(heldBooksSyncedAt ? { heldBooksSyncedAt: heldBooksSyncedAt.toISOString() } : {}),
          }
        : {}),
    },
    sourceAddedAt: toDate(series.created),
    sourceUpdatedAt: toDate(series.lastChapterAddedUtc),
  };
}

export function normalizeAbsItem(
  item: AbsItem,
  libraryId: string,
  libraryName: string,
  publicUrl: string,
  now: Date = new Date(),
): BooksItemInput {
  const meta = item.media?.metadata ?? undefined;
  const title = meta?.title || item.id;
  const sort = (meta?.titleIgnorePrefix || title).trim().toLowerCase();
  let year: number | null = null;
  if (meta?.publishedYear != null) {
    const y = typeof meta.publishedYear === 'number' ? meta.publishedYear : parseInt(meta.publishedYear, 10);
    if (Number.isFinite(y)) year = y;
  }
  // DESIGN-026 D-05 — the precise ABS publishedDate (a date string, richer than publishedYear). null
  // when absent/unparseable (many ABS items carry only a year → released_at stays null, year still sorts).
  const releasedAt = absReleasedAt(meta?.publishedDate);
  const duration = item.media?.duration;
  return {
    source: 'audiobookshelf',
    mediaKind: 'audiobook',
    externalId: item.id,
    libraryId: item.libraryId || libraryId,
    libraryName,
    title,
    sortTitle: sort,
    author: meta?.authorName || null,
    narrator: meta?.narratorName || null,
    seriesName: meta?.seriesName || null,
    year,
    releasedAt,
    genres: (meta?.genres ?? []).filter((g): g is string => typeof g === 'string'),
    coverRef: item.updatedAt != null ? String(item.updatedAt) : null,
    deepLinkUrl: `${publicUrl}/item/${item.id}`,
    pageCount: null,
    wordCount: null,
    durationSeconds: duration != null ? Math.round(duration) : null,
    sizeBytes: item.media?.size ?? null,
    // DESIGN-024 D-01 amendment (detail-page parity) — enrichment ABS carries INLINE in the list read
    // (no extra call): summary (description, HTML-stripped), publisher, isbn (populated-value-gated),
    // and file_count (numAudioFiles — the audiobook's part count). metadataSyncedAt set every run.
    summary: stripHtml(meta?.description),
    publisher: meta?.publisher?.trim() || null,
    isbn: meta?.isbn?.trim() || null,
    fileCount: item.media?.numAudioFiles ?? null,
    metadataSyncedAt: now,
    attrs: {
      numTracks: item.media?.numTracks ?? null,
      numChapters: item.media?.numChapters ?? null,
      language: meta?.language ?? null,
    },
    sourceAddedAt: item.addedAt != null ? new Date(item.addedAt) : null,
    sourceUpdatedAt: item.updatedAt != null ? new Date(item.updatedAt) : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot fetch
// ---------------------------------------------------------------------------

/**
 * DESIGN-024 D-01 amendment (detail-page parity) — the existing mirror enrichment the change-gate
 * compares against, keyed by Kavita series id (books_items.external_id for kavita rows). The
 * orchestrator SELECTs this once before the run; a series is re-fetched from `/api/Series/metadata`
 * when it is new to the mirror, was never enriched (`metadataSyncedAt` null), or its
 * `source_updated_at` changed since the last run, or (issue #712) it is picked by the bounded rolling
 * refresh (`selectMetadataRefresh`) — so the hourly sync issues at most a capped batch of per-series calls
 * for the ~1,400 unchanged Kavita series.
 */
export interface ExistingKavitaEnrichment {
  /** Detail signals that can change while Kavita retains the series id and chapter-added stamp. */
  title?: string;
  pageCount?: number | null;
  sourceUpdatedAt: Date | null;
  metadataSyncedAt: Date | null;
  data: KavitaEnrichment;
  /**
   * Issue #661 — the held books already on the mirror row (`attrs.heldBooks`); undefined = never read, so
   * the run reads them once (the backfill) even when the series is otherwise unchanged.
   */
  heldBooks?: HeldBook[];
  /** Last successful chapter read, independent of metadata reads (authorless rows re-enrich every run). */
  heldBooksSyncedAt?: Date | null;
}

/**
 * Issue #712 — Kavita exposes NO change signal for a series' metadata: the series list (`all-v2`) carries only
 * `created` / `lastChapterAddedUtc` (neither moves when metadata is edited) and `/api/Series/metadata` has no
 * modified stamp or hash (probed live 2026-10-05; an edit of `language` + `languageLocked` changed nothing the
 * list returns). So the change-gate alone can never see an edit, and the sync re-reads on a bounded ROLLING
 * schedule as well: each run, per library, it re-reads at most `KAVITA_METADATA_REFRESH_CAP` series, the ones
 * whose last read is oldest and at least `KAVITA_METADATA_REFRESH_MIN_AGE_MS` old. About 1,400 series at 150 a
 * run means every series is re-read within ~10 hourly runs, so an edit always lands, at ~150 cheap GETs a run
 * (the one-off backfill read all 1,400 in a run). Series whose stored language is explicitly non-English are
 * re-read EVERY run, ahead of the rotation (a handful of calls, shrinking as items are fixed), so a language
 * correction, the edit that frees a pairing want (DESIGN-036 F10), lands on the very next run.
 */
export const KAVITA_METADATA_REFRESH_CAP = 150;
export const KAVITA_METADATA_REFRESH_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Pick the series (ids) whose metadata is re-read this run beyond the change-gate (pure — unit-tested): every
 * series with a foreign stored language, then the stalest others past the minimum age, at most `cap` in all
 * (foreign ones first and uncapped by age; a series never read is the change-gate's job, not this one's).
 */
export function selectMetadataRefresh(
  series: readonly KavitaSeries[],
  existing: Map<string, ExistingKavitaEnrichment> | undefined,
  options: { now: Date; cap?: number; minAgeMs?: number },
): Set<number> {
  const cap = options.cap ?? KAVITA_METADATA_REFRESH_CAP;
  const minAgeMs = options.minAgeMs ?? KAVITA_METADATA_REFRESH_MIN_AGE_MS;
  if (existing === undefined || cap <= 0) return new Set();
  const foreign: Array<{ id: number; at: number }> = [];
  const rotation: Array<{ id: number; at: number }> = [];
  for (const s of series) {
    const row = existing.get(String(s.id));
    if (row === undefined || row.metadataSyncedAt === null) continue;
    const at = row.metadataSyncedAt.getTime();
    if (isForeignLanguage(row.data.language)) foreign.push({ id: s.id, at });
    else if (options.now.getTime() - at >= minAgeMs) rotation.push({ id: s.id, at });
  }
  const stalestFirst = (a: { id: number; at: number }, b: { id: number; at: number }): number =>
    a.at - b.at || a.id - b.id;
  foreign.sort(stalestFirst);
  rotation.sort(stalestFirst);
  return new Set([...foreign, ...rotation].slice(0, cap).map((x) => x.id));
}

export interface FetchBooksSnapshotOptions {
  /** Re-read every book series' chapters for a staged library regrouping census. */
  forceHeldBooksRefresh?: boolean;
  /** Issue #712 — per-library cap of rolling metadata re-reads per run (default `KAVITA_METADATA_REFRESH_CAP`; 0 = off). */
  metadataRefreshCap?: number;
  /** Issue #712 — a non-foreign series is rolling-re-read only when its last read is at least this old. */
  metadataRefreshMinAgeMs?: number;
  /** Existing Kavita enrichment (external_id → row) for the change-gate. Absent ⇒ enrich every series. */
  existingKavita?: Map<string, ExistingKavitaEnrichment>;
  /** The run instant stamped on ABS rows + freshly-enriched Kavita rows (defaults to now). */
  now?: Date;
  /** How many per-series Kavita metadata calls run at once (paces the backfill). Default 4. */
  metadataConcurrency?: number;
}

/** Same-instant compare tolerant of null on either side (a missing stamp is treated as "changed"). */
function stampChanged(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? null) !== (b?.getTime() ?? null);
}

/** Run `worker` over `items` with a bounded concurrency (a tiny pool — no dependency). */
async function mapPaced<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  });
  await Promise.all(runners);
}

/**
 * Page both book servers and normalize every series/item. A source is added to `syncedSources` ONLY when
 * ALL its libraries paged without error — so a partial run (a library or the whole server throwing) still
 * upserts what it read (idempotent, refreshes last_seen) but never lets syncBooks tombstone the source it
 * couldn't fully read (ADR-046 — tombstoning is scoped to syncedSources).
 *
 * DESIGN-024 D-01 amendment — Kavita rows are ENRICHED with `/api/Series/metadata` (summary, genres,
 * publisher, language, year), change-gated against `options.existingKavita` (only new/changed series
 * are fetched; the rest carry their last enrichment forward so the upsert stays a full-replace). ABS
 * enrichment is inline in the list read (no extra call). A per-series metadata failure never fails the
 * run — it carries the existing enrichment forward (or leaves the new row un-enriched, retried next run).
 */
export async function fetchBooksSnapshot(
  bundle: BooksSyncBundle,
  logger: SyncLogger = noopLogger,
  options: FetchBooksSnapshotOptions = {},
): Promise<BooksSnapshot> {
  const rows: BooksItemInput[] = [];
  const syncedSources: BooksSource[] = [];
  const now = options.now ?? new Date();
  const existingKavita = options.existingKavita;
  let kavitaSeries = 0;
  let kavitaEnriched = 0;
  let kavitaRefreshed = 0;
  let kavitaHeldRead = 0;
  let absItems = 0;

  // --- Kavita (Books + Comics) ---
  let kavitaComplete = true;
  try {
    const libs = await bundle.kavita.listLibraries();
    for (const lib of libs) {
      const kind = kavitaLibraryKind(lib.type);
      if (!kind) continue;
      try {
        const pageSeries: KavitaSeries[] = [];
        let page = 1;
        for (;;) {
          const { items, total } = await bundle.kavita.listSeriesPage(lib.id, page, KAVITA_PAGE_SIZE);
          pageSeries.push(...items);
          if (items.length === 0 || page * KAVITA_PAGE_SIZE >= total || page >= MAX_PAGES) break;
          page += 1;
        }
        // Resolve enrichment per series (change-gated), then normalize. The metadata calls are paced.
        const refreshIds = selectMetadataRefresh(pageSeries, existingKavita, {
          now,
          cap: options.metadataRefreshCap,
          minAgeMs: options.metadataRefreshMinAgeMs,
        });
        const heldRefreshIds = selectMetadataRefresh(
          pageSeries,
          existingKavita &&
            new Map(
              [...existingKavita].map(([key, row]) => [
                key,
                { ...row, metadataSyncedAt: row.heldBooksSyncedAt ?? row.metadataSyncedAt },
              ]),
            ),
          { now, cap: options.metadataRefreshCap, minAgeMs: options.metadataRefreshMinAgeMs },
        );
        const applied = new Map<number, KavitaEnrichmentApply | null>();
        const held = new Map<number, HeldBook[] | undefined>();
        const heldReadAt = new Map<number, Date | null | undefined>();
        await mapPaced(pageSeries, options.metadataConcurrency ?? 4, async (s) => {
          const key = String(s.id);
          const existing = existingKavita?.get(key);
          const freshUpdated = toDate(s.lastChapterAddedUtc);
          const changed =
            existingKavita === undefined ||
            existing === undefined ||
            stampChanged(freshUpdated, existing.sourceUpdatedAt) ||
            (existing.title !== undefined && existing.title !== s.name) ||
            (existing.pageCount !== undefined && existing.pageCount !== (s.pages ?? null));
          // Issue #661 — a BOOK series' held books (`/api/Series/volumes`): read when the series is new or
          // changed, never read, force-refreshed, or due in the bounded rotation; otherwise carried forward.
          // A changed/forced read failure leaves identity unread for retry. Comics are never paired.
          const refresh = refreshIds.has(s.id);
          if (kind === 'book') {
            if (
              changed ||
              heldRefreshIds.has(s.id) ||
              options.forceHeldBooksRefresh ||
              existing?.heldBooks === undefined
            ) {
              try {
                held.set(s.id, kavitaHeldBooksFrom(await bundle.kavita.listSeriesVolumes(key)));
                heldReadAt.set(s.id, now);
                kavitaHeldRead += 1;
              } catch (error) {
                logger.error('books-sync: kavita held-books read failed', {
                  seriesId: key,
                  error: error instanceof Error ? error.message : String(error),
                });
                // A changed series' old identity is no longer trustworthy. Leave it unread so pairing waits
                // and the next run retries, even after the mirror advances the scanner stamp.
                held.set(
                  s.id,
                  changed || options.forceHeldBooksRefresh ? undefined : existing?.heldBooks,
                );
                heldReadAt.set(
                  s.id,
                  changed || options.forceHeldBooksRefresh
                    ? undefined
                    : existing?.heldBooksSyncedAt,
                );
              }
            } else {
              held.set(s.id, existing?.heldBooks);
              heldReadAt.set(s.id, existing?.heldBooksSyncedAt);
            }
          }
          // Issue #712 — Kavita gives no metadata change signal, so the rolling refresh re-reads on top of the gate.
          const needsEnrich =
            changed || existing === undefined || existing.metadataSyncedAt === null || refresh;
          if (!needsEnrich && existing !== undefined) {
            // Unchanged — carry the existing enrichment forward (no request).
            applied.set(s.id, { data: existing.data, metadataSyncedAt: existing.metadataSyncedAt });
            return;
          }
          try {
            const meta = await bundle.kavita.getSeriesMetadata(key);
            applied.set(s.id, { data: kavitaEnrichmentFrom(meta), metadataSyncedAt: now });
            kavitaEnriched += 1;
            if (refresh && !changed) kavitaRefreshed += 1;
          } catch (error) {
            // A per-series enrichment failure is non-fatal: carry the existing enrichment forward
            // (never wipe it) and leave metadataSyncedAt as-was so the next run retries this series.
            logger.error('books-sync: kavita metadata enrichment failed', {
              seriesId: key,
              error: error instanceof Error ? error.message : String(error),
            });
            applied.set(
              s.id,
              existing !== undefined
                ? { data: existing.data, metadataSyncedAt: existing.metadataSyncedAt }
                : null,
            );
          }
        });
        for (const s of pageSeries) {
          rows.push(
            normalizeKavitaSeries(
              s,
              kind,
              lib.name,
              bundle.kavitaPublicUrl,
              applied.get(s.id) ?? null,
              held.get(s.id),
              heldReadAt.get(s.id),
            ),
          );
          kavitaSeries += 1;
        }
      } catch (error) {
        kavitaComplete = false;
        logger.error('books-sync: kavita library failed', {
          library: lib.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    kavitaComplete = false;
    logger.error('books-sync: kavita listLibraries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (kavitaComplete) syncedSources.push('kavita');

  // --- Audiobookshelf (Audio Books) ---
  let absComplete = true;
  try {
    const libs = await bundle.audiobookshelf.listLibraries();
    for (const lib of libs) {
      if (lib.mediaType && lib.mediaType !== 'book') continue; // skip podcast libraries
      try {
        let page = 0;
        for (;;) {
          const { items, total } = await bundle.audiobookshelf.listItemsPage(
            lib.id,
            page,
            ABS_PAGE_SIZE,
          );
          for (const it of items) {
            rows.push(normalizeAbsItem(it, lib.id, lib.name, bundle.audiobookshelfPublicUrl, now));
            absItems += 1;
          }
          if (items.length === 0 || (page + 1) * ABS_PAGE_SIZE >= total || page >= MAX_PAGES) break;
          page += 1;
        }
      } catch (error) {
        absComplete = false;
        logger.error('books-sync: audiobookshelf library failed', {
          library: lib.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    absComplete = false;
    logger.error('books-sync: audiobookshelf listLibraries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (absComplete) syncedSources.push('audiobookshelf');

  logger.info('books-sync: snapshot fetched', {
    kavitaSeries,
    kavitaEnriched,
    kavitaRefreshed,
    kavitaHeldRead,
    absItems,
  });
  return { rows, syncedSources, counts: { kavitaSeries, absItems } };
}
