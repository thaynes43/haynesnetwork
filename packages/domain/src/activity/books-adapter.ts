// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the BOOKS adapter (LazyLibrarian + SABnzbd). The
// PURE normalizer `buildBooksActivity` folds LL's wanted-table worklist + SAB's queue/history into
// ActivityItem[] — the stage machine from ADR-059 Q-02. The client wiring (constructing the LL/SAB read
// clients) lives in activity/clients.ts; this file is I/O-free so it is exhaustively unit-tested against
// fixtures (incl. the stranded-download scenario — the OPS-013 §11 42-book incident).
import type { LlWantedEntry } from '@hnet/lazylibrarian/read';
import type { SabHistorySlot, SabQueueSlot } from '@hnet/downloads/read';
import type { ActivityFailureKind, ActivityItem, ActivityStage } from './contract';

/** The books adapter's family name (the failure ledger `source` column). */
export const BOOKS_ACTIVITY_SOURCE = 'books';

/** How long a `Snatched` LL row whose SAB job is Completed may sit before it's called STRANDED. */
export const DEFAULT_STRAND_HORIZON_MS = 30 * 60 * 1000; // 30 min — conservative (OPS-013 §11.3 tuning)

export interface BooksActivitySources {
  /** LL `getWanted` worklist. */
  llWanted: LlWantedEntry[];
  /** SAB `mode=queue` (still downloading). */
  sabQueue: SabQueueSlot[];
  /** SAB `mode=history` (Completed/Failed; archive included). */
  sabHistory: SabHistorySlot[];
}

export interface BooksActivityOptions {
  now: Date;
  /** Strand horizon override (tests pin it; default DEFAULT_STRAND_HORIZON_MS). */
  strandHorizonMs?: number;
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

/**
 * Fold the LL wanted worklist + SAB queue/history into normalized ActivityItems. The stage machine (Q-02):
 *   • LL `wanted`                                  → searching
 *   • LL `snatched` + SAB queue slot               → downloading (progress = slot %)
 *   • LL `snatched` + SAB history Completed, fresh  → importing (the LL post-process bridge)
 *   • LL `snatched` + SAB history Completed, STALE  → failed / stranded_import (the incident)
 *   • LL `snatched` + SAB history Failed            → failed / download_failed
 *   • LL `failed`                                   → failed / postprocess_failed (DLResult)
 *   • LL `processed`/`open`/`have`                  → completed (recent)
 * A torrent/DIRECT-sourced grab with no SAB trace can't be strand-checked here (SLICE 1 is the usenet leg);
 * it degrades to `importing` (conservative — never fabricate a failure). `href` is left null (the aggregator
 * fills the failure detail link once the ledger row id is known).
 */
export function buildBooksActivity(
  sources: BooksActivitySources,
  opts: BooksActivityOptions,
): ActivityItem[] {
  const horizon = opts.strandHorizonMs ?? DEFAULT_STRAND_HORIZON_MS;
  const nowMs = opts.now.getTime();
  const queueById = new Map(sources.sabQueue.map((s) => [s.nzoId, s]));
  const historyById = new Map(sources.sabHistory.map((s) => [s.nzoId, s]));

  const items: ActivityItem[] = [];
  for (const row of sources.llWanted) {
    if (!row.bookId) continue;
    const status = row.status.toLowerCase();
    const { kind, wall } = kindAndWall(row.format);
    const id = `books:ll:${row.bookId}:${row.format ?? 'book'}`;
    const title = cleanTitle(row.title) || 'Untitled';
    const base = {
      id,
      kind,
      section: 'books' as const,
      wall,
      title,
      year: null,
      progress: null as number | null,
      failureReason: null as string | null,
      failureKind: null as ActivityFailureKind | null,
      posterUrl: null,
      href: null,
      downstreamUrl: opts.llBaseUrl ?? null,
    };

    let stage: ActivityStage;
    let sourceApp: ActivityItem['sourceApp'] = 'lazylibrarian';
    let progress: number | null = null;
    let failureKind: ActivityFailureKind | null = null;
    let failureReason: string | null = null;
    let downstreamUrl: string | null = opts.llBaseUrl ?? null;
    let updatedAt = new Date(num(row.snatchedAt) ?? nowMs).toISOString();

    if (status === 'wanted') {
      stage = 'searching';
    } else if (status === 'failed') {
      stage = 'failed';
      failureKind = 'postprocess_failed';
      failureReason = row.dlResult ?? 'LazyLibrarian marked this grab failed.';
    } else if (status === 'processed' || status === 'open' || status === 'have') {
      stage = 'completed';
    } else if (status === 'snatched') {
      const queued = row.downloadId ? queueById.get(row.downloadId) : undefined;
      const done = row.downloadId ? historyById.get(row.downloadId) : undefined;
      if (queued) {
        stage = 'downloading';
        sourceApp = 'sabnzbd';
        progress = queued.percentage;
        downstreamUrl = opts.sabBaseUrl ?? downstreamUrl;
        updatedAt = new Date(nowMs).toISOString();
      } else if (done) {
        const dstatus = done.status.toLowerCase();
        if (dstatus === 'failed') {
          stage = 'failed';
          sourceApp = 'sabnzbd';
          failureKind = 'download_failed';
          failureReason = done.failMessage ?? 'The usenet download failed (dead post / par2 repair failed).';
          downstreamUrl = opts.sabBaseUrl ?? downstreamUrl;
        } else {
          // SAB completed — is LL importing it, or is it STRANDED (completed long ago, never imported)?
          const snatchedMs = num(row.snatchedAt) ?? nowMs;
          const stale = nowMs - snatchedMs >= horizon;
          if (stale) {
            stage = 'failed';
            failureKind = 'stranded_import';
            failureReason =
              'The download completed but never imported into the library (stranded). Retry the import.';
          } else {
            stage = 'importing';
          }
        }
      } else {
        // Snatched, no SAB trace (a torrent/DIRECT grab, or SAB not yet reporting) — importing (best-effort).
        stage = 'importing';
      }
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
