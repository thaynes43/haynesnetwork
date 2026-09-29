// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the BOOKS adapter (LazyLibrarian + SABnzbd). The
// PURE normalizer `buildBooksActivity` folds LL's grab HISTORY (`cmd=getHistory` — Snatched / Failed /
// Processed / Seeding rows), LL's wanted books (`cmd=getWanted` — the `searching` stage) and SAB's
// queue/history into ActivityItem[] — the stage machine from ADR-059 Q-02 as corrected by DESIGN-030 D-11.
// The client wiring (constructing the LL/SAB read clients) lives in activity/clients.ts; this file is I/O-free
// so it is exhaustively unit-tested against fixtures (incl. the stranded-download scenario — the OPS-013 §11
// 42-book incident — and real getHistory samples).
import type { LlHistoryEntry, LlWantedBook } from '@hnet/lazylibrarian/read';
import type { SabHistorySlot, SabQueueSlot } from '@hnet/downloads/read';
import type { ActivityFailureKind, ActivityItem, ActivityStage } from './contract';

/** The books adapter's family name (the failure ledger `source` column). */
export const BOOKS_ACTIVITY_SOURCE = 'books';

/** How long a `Snatched` LL row whose download finished may sit before it's called STRANDED. */
export const DEFAULT_STRAND_HORIZON_MS = 30 * 60 * 1000; // 30 min — conservative (OPS-013 §11.3 tuning)

/** How recently a grab must have landed to still read as `completed` ("Just added"); mirrors the *arr adapter. */
export const DEFAULT_BOOKS_COMPLETED_HORIZON_MS = 15 * 60 * 1000; // 15 min

/**
 * How long a `Failed` grab stays on the Activity tab. LL's history is never pruned (4.5k Failed rows live,
 * 2026-09-29), so a failure that nobody acted on ages out; the book returns to `searching` while it is still
 * wanted. A Snatched strand never ages out — it stays until it is imported or re-searched.
 */
export const DEFAULT_BOOKS_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BooksActivitySources {
  /** LL `getHistory` — one row per grab attempt (the whole log; the normalizer reduces it). */
  llHistory: LlHistoryEntry[];
  /** LL `getWanted` — the books LL is still looking for (the `searching` stage). */
  llWanted: LlWantedBook[];
  /** SAB `mode=queue` (still downloading). */
  sabQueue: SabQueueSlot[];
  /** SAB `mode=history` (Completed/Failed; archive included). */
  sabHistory: SabHistorySlot[];
}

export interface BooksActivityOptions {
  now: Date;
  /** Strand horizon override (tests pin it; default DEFAULT_STRAND_HORIZON_MS). */
  strandHorizonMs?: number;
  /** Completed-recent horizon override (default DEFAULT_BOOKS_COMPLETED_HORIZON_MS). */
  completedHorizonMs?: number;
  /** Failed-grab window override (default DEFAULT_BOOKS_FAILED_WINDOW_MS). */
  failedWindowMs?: number;
  /** LazyLibrarian base URL for the downstream deep link (Admin-only in the UI). */
  llBaseUrl?: string | null;
  /** SABnzbd base URL for the downstream deep link. */
  sabBaseUrl?: string | null;
}

const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

/** Map an LL format to the ActivityItem kind + wall. */
function kindAndWall(format: 'ebook' | 'audiobook' | null): {
  kind: ActivityItem['kind'];
  wall: ActivityItem['wall'];
} {
  if (format === 'audiobook') return { kind: 'audiobook', wall: 'audiobooks' };
  return { kind: 'book', wall: 'books' };
}

/** The stable per-(book, format) item id (also the failure ledger's `source_ref` and the wall-badge join). */
const itemId = (bookId: string, format: 'ebook' | 'audiobook' | null): string =>
  `books:ll:${bookId}:${format ?? 'book'}`;

/** LL history statuses that mean the book LANDED (a copy exists / is seeding). */
const LANDED = new Set(['processed', 'seeding', 'open', 'have']);

/**
 * LL's own dedupe rejection ("Duplicate NZB" — SAB dupe mode refused a re-send). It is not a grab outcome:
 * the earlier attempt on that book decides its state, so these rows are dropped before the per-book reduce.
 */
const isDuplicateRejection = (row: LlHistoryEntry): boolean =>
  row.status.toLowerCase() === 'failed' && /^duplicate nzb/i.test(row.dlResult ?? '');

/** A Failed row whose text says nothing was ever downloaded/importable → re-search only, not retry-import. */
const DOWNLOAD_FAILURE_RE =
  /failed to send|rejecting torrent|url fetching failed|got a \d{3} response|aborted|not on your server|repair failed|repair blocks|unpacking failed|failed to verify|not-complete/i;

/**
 * Fold LL's grab history + wanted books + SAB queue/history into normalized ActivityItems. The history is
 * reduced to the LATEST row per (book, format) (it is a log — every retry adds a row), then the stage machine
 * (Q-02, corrected by D-11):
 *   • latest `Snatched` + SAB queue slot              → downloading (progress = slot %)
 *   • latest `Snatched` + SAB history Failed           → failed / download_failed
 *   • latest `Snatched` + SAB history Completed        → importing (fresh) / failed stranded_import (stale)
 *   • latest `Snatched`, SAB source, NO SAB trace      → LL's own `Completed` epoch (else `NZBdate`) decides:
 *                                                        importing (fresh) / failed stranded_import (stale) —
 *                                                        the job left SAB's history (issue #562 class)
 *   • latest `Snatched`, torrent/direct source          → downloading (LL has no finish time yet) / importing
 *                                                        (finished) — never a fabricated failure
 *   • latest `Failed`, never landed, within the window → failed / download_failed | postprocess_failed
 *   • latest `Processed`/`Seeding`, within the horizon → completed
 *   • a wanted book with no live/failed grab            → searching
 * `href` is left null (the aggregator fills the failure detail link once the ledger row id is known).
 */
export function buildBooksActivity(
  sources: BooksActivitySources,
  opts: BooksActivityOptions,
): ActivityItem[] {
  const horizon = opts.strandHorizonMs ?? DEFAULT_STRAND_HORIZON_MS;
  const completedHorizon = opts.completedHorizonMs ?? DEFAULT_BOOKS_COMPLETED_HORIZON_MS;
  const failedWindow = opts.failedWindowMs ?? DEFAULT_BOOKS_FAILED_WINDOW_MS;
  const nowMs = opts.now.getTime();
  const queueById = new Map(sources.sabQueue.map((s) => [s.nzoId, s]));
  const historyById = new Map(sources.sabHistory.map((s) => [s.nzoId, s]));

  const baseFor = (id: string, format: 'ebook' | 'audiobook' | null, title: string, isRelease: boolean) => {
    const { kind, wall } = kindAndWall(format);
    return {
      id,
      kind,
      section: 'books' as const,
      wall,
      // A history title is a scene/NZB release name (cleaned); a wanted book's `BookName` is already a title.
      title: (isRelease ? cleanTitle(title) : title.trim()) || 'Untitled',
      year: null,
      posterUrl: null,
      href: null,
    };
  };

  // ---- reduce the history log: latest row per (book, format); remember which keys ever landed ----
  const latest = new Map<string, { row: LlHistoryEntry; at: number; order: number }>();
  const landed = new Set<string>();
  sources.llHistory.forEach((row, order) => {
    if (!row.bookId) return;
    const key = itemId(row.bookId, row.format);
    const status = row.status.toLowerCase();
    if (LANDED.has(status)) landed.add(key);
    if (isDuplicateRejection(row)) return;
    const at = num(row.snatchedAt) ?? 0;
    const cur = latest.get(key);
    // Newest grab wins; on a tie (same-second retries) the later row in LL's log wins.
    if (!cur || at > cur.at || (at === cur.at && order > cur.order)) latest.set(key, { row, at, order });
  });

  const items: ActivityItem[] = [];
  const emitted = new Set<string>();

  for (const [id, { row }] of latest) {
    const status = row.status.toLowerCase();
    const base = baseFor(id, row.format, row.title, true);
    const snatchedMs = num(row.snatchedAt);
    const completedMs = num(row.completedAt);

    let stage: ActivityStage;
    let sourceApp: ActivityItem['sourceApp'] = 'lazylibrarian';
    let progress: number | null = null;
    let failureKind: ActivityFailureKind | null = null;
    let failureReason: string | null = null;
    let downstreamUrl: string | null = opts.llBaseUrl ?? null;
    let updatedAt = new Date(completedMs ?? snatchedMs ?? nowMs).toISOString();

    if (status === 'snatched') {
      // When the download finished, if LL knows it (its `Completed` epoch) — else when it was snatched.
      const finishedMs = completedMs ?? snatchedMs ?? nowMs;
      const strandedNow = nowMs - finishedMs >= horizon;
      const queued = row.downloadId ? queueById.get(row.downloadId) : undefined;
      const done = row.downloadId ? historyById.get(row.downloadId) : undefined;
      const strandedReason =
        'The download completed but never imported into the library (stranded). Retry the import.';
      if (queued) {
        stage = 'downloading';
        sourceApp = 'sabnzbd';
        progress = queued.percentage;
        downstreamUrl = opts.sabBaseUrl ?? downstreamUrl;
        updatedAt = new Date(nowMs).toISOString();
      } else if (done) {
        if (done.status.toLowerCase() === 'failed') {
          stage = 'failed';
          sourceApp = 'sabnzbd';
          failureKind = 'download_failed';
          failureReason = done.failMessage ?? 'The usenet download failed (dead post / par2 repair failed).';
          downstreamUrl = opts.sabBaseUrl ?? downstreamUrl;
        } else if (strandedNow) {
          stage = 'failed';
          failureKind = 'stranded_import';
          failureReason = strandedReason;
        } else {
          stage = 'importing';
        }
      } else if (row.source === 'sabnzbd') {
        // A usenet grab SAB no longer reports (its history slot aged out / was purged) — LL's own finish
        // time decides, so a strand never silently reads `importing` (issue #562 class).
        if (strandedNow) {
          stage = 'failed';
          failureKind = 'stranded_import';
          failureReason = strandedReason;
        } else {
          stage = 'importing';
        }
      } else {
        // Torrent / DIRECT grab — no SAB trace to check. LL records a finish time once it sees the download
        // done: none yet ⇒ still downloading (no percentage), a finish time ⇒ awaiting its import. Never a
        // fabricated failure.
        stage = completedMs != null ? 'importing' : 'downloading';
        if (row.source === 'qbittorrent') sourceApp = 'qbittorrent';
      }
    } else if (status === 'failed') {
      if (landed.has(id)) continue; // a copy exists — a stale failed retry is not an incident
      if (nowMs - (snatchedMs ?? 0) > failedWindow) continue;
      stage = 'failed';
      const text = row.dlResult;
      failureKind = text && DOWNLOAD_FAILURE_RE.test(text) ? 'download_failed' : 'postprocess_failed';
      failureReason = text ?? 'LazyLibrarian marked this grab failed.';
    } else if (LANDED.has(status)) {
      if (nowMs - (completedMs ?? snatchedMs ?? 0) > completedHorizon) continue;
      stage = 'completed';
    } else {
      continue; // unknown status — not an activity item
    }

    // A failed download can't be retried-imported (there's nothing to import) — only re-searched. A
    // stranded/postprocess failure offers both retry-import and re-search.
    const actions: ActivityItem['actions'] =
      stage !== 'failed'
        ? []
        : failureKind === 'download_failed'
          ? ['force_research']
          : ['retry_import', 'force_research'];

    emitted.add(id);
    items.push({
      ...base,
      stage,
      sourceApp,
      progress,
      failureKind,
      failureReason,
      updatedAt,
      downstreamUrl,
      actions,
    });
  }

  // ---- wanted books → `searching`, one per wanted format, unless the history already produced an item ----
  for (const book of sources.llWanted) {
    const formats: Array<'ebook' | 'audiobook'> = [];
    if (book.ebookStatus?.trim().toLowerCase() === 'wanted') formats.push('ebook');
    if (book.audioStatus?.trim().toLowerCase() === 'wanted') formats.push('audiobook');
    for (const format of formats) {
      const id = itemId(book.bookId, format);
      if (emitted.has(id)) continue;
      emitted.add(id);
      items.push({
        ...baseFor(id, format, book.title, false),
        stage: 'searching',
        sourceApp: 'lazylibrarian',
        progress: null,
        failureKind: null,
        failureReason: null,
        updatedAt: new Date(num(book.addedAt) ?? nowMs).toISOString(),
        downstreamUrl: opts.llBaseUrl ?? null,
        actions: [],
      });
    }
  }

  // Newest first (recency), failures naturally surfaced by the chip default.
  items.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
  return items;
}

/** Trim a scene/NZB release name to something presentable (dots→spaces, drop trailing scene junk). */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\.(epub|mobi|azw3|m4b|mp3|nzb)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
