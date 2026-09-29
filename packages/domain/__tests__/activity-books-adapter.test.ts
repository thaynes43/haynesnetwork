import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBooksActivity, type BooksActivitySources } from '../src/activity/books-adapter';
import { LazyLibrarianReadClient, type LlHistoryEntry, type LlWantedBook } from '@hnet/lazylibrarian/read';
import type { SabHistorySlot, SabQueueSlot } from '@hnet/downloads/read';

// ADR-059 / DESIGN-030 D-11 (PLAN-048 — Activity / In-Flight) — the pure books normalizer: LL's grab HISTORY
// (`getHistory`) + wanted books (`getWanted`) + SAB queue/history → the Activity stage machine (Q-02, as
// corrected by D-11). The KEY case is the STRANDED import (the OPS-013 §11 42-book incident: LL still
// Snatched while the download finished long ago) — this test is that incident's regression guard, and the
// last describe block replays REAL getHistory/getWanted samples (issue #615: the adapter had been reading
// `getWanted`, a book list, so it never saw a Snatched or Failed row).

const NOW = new Date('2026-07-14T12:00:00Z');
const AGED = '2026-07-14T09:00:00Z'; // 3h before NOW → past the 30-min strand horizon
const RECENT = '2026-07-14T11:50:00Z'; // 10 min before NOW → inside the strand + completed horizons

function hist(overrides: Partial<LlHistoryEntry> & { bookId: string; status: string }): LlHistoryEntry {
  return {
    title: overrides.title ?? overrides.bookId,
    source: overrides.source ?? null,
    downloadId: overrides.downloadId ?? null,
    format: overrides.format === undefined ? 'ebook' : overrides.format,
    dlResult: overrides.dlResult ?? null,
    snatchedAt: overrides.snatchedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    ...overrides,
  };
}

function wantedBook(overrides: Partial<LlWantedBook> & { bookId: string }): LlWantedBook {
  return {
    title: overrides.bookId,
    ebookStatus: 'Wanted',
    audioStatus: null,
    addedAt: null,
    ...overrides,
  };
}

function queue(nzoId: string, percentage: number): SabQueueSlot {
  return { nzoId, name: nzoId, percentage, status: 'Downloading', category: 'lazylibrarian' };
}

function sabHistory(nzoId: string, status: string, failMessage: string | null = null): SabHistorySlot {
  return { nzoId, name: nzoId, status, category: 'lazylibrarian', storage: `/x/${nzoId}`, failMessage };
}

function build(sources: Partial<BooksActivitySources>, opts: { now?: Date; failedWindowMs?: number } = {}) {
  return buildBooksActivity(
    { llHistory: [], llWanted: [], sabQueue: [], sabHistory: [], ...sources },
    { now: opts.now ?? NOW, strandHorizonMs: 30 * 60 * 1000, ...(opts.failedWindowMs ? { failedWindowMs: opts.failedWindowMs } : {}) },
  );
}

describe('buildBooksActivity — the books stage machine', () => {
  it('maps a wanted book to `searching`, one item per wanted format', () => {
    const items = build({
      llWanted: [
        wantedBook({ bookId: 'b1', title: 'Kingdom of Ash', ebookStatus: 'Wanted', audioStatus: 'Wanted' }),
        wantedBook({ bookId: 'b1b', ebookStatus: 'Wanted', audioStatus: 'Skipped' }),
      ],
    });
    expect(items.map((i) => i.id).sort()).toEqual([
      'books:ll:b1:audiobook',
      'books:ll:b1:ebook',
      'books:ll:b1b:ebook',
    ]);
    const ebook = items.find((i) => i.id === 'books:ll:b1:ebook')!;
    expect(ebook).toMatchObject({ stage: 'searching', kind: 'book', wall: 'books', section: 'books', title: 'Kingdom of Ash' });
    expect(items.find((i) => i.id === 'books:ll:b1:audiobook')).toMatchObject({ kind: 'audiobook', wall: 'audiobooks' });
    expect(ebook.actions).toEqual([]);
  });

  it('maps a Snatched row with a live SAB queue slot to `downloading` with progress + sabnzbd source', () => {
    const items = build({
      llHistory: [hist({ bookId: 'b2', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-2' })],
      sabQueue: [queue('nzo-2', 61)],
    });
    expect(items[0]).toMatchObject({ stage: 'downloading', progress: 61, sourceApp: 'sabnzbd' });
  });

  it('maps a Snatched row whose SAB job Completed but is FRESH to `importing`', () => {
    const items = build({
      llHistory: [hist({ bookId: 'b3', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-3', snatchedAt: RECENT })],
      sabHistory: [sabHistory('nzo-3', 'Completed')],
    });
    expect(items[0]).toMatchObject({ stage: 'importing' });
    expect(items[0]!.failureKind).toBeNull();
  });

  it('THE INCIDENT: a Snatched row whose SAB job Completed but is STALE → failed / stranded_import', () => {
    const items = build({
      llHistory: [
        hist({ bookId: 'b4', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-4', snatchedAt: AGED, title: 'The Stranded Import' }),
      ],
      sabHistory: [sabHistory('nzo-4', 'Completed')],
    });
    const item = items[0]!;
    expect(item.stage).toBe('failed');
    expect(item.failureKind).toBe('stranded_import');
    expect(item.failureReason).toMatch(/never imported/i);
    // A strand is retry-import-able AND re-searchable.
    expect(item.actions).toEqual(['retry_import', 'force_research']);
  });

  it('issue #562 class: a usenet Snatched row SAB no longer reports is stranded by LL\'s own finish time, not `importing`', () => {
    const items = build({
      llHistory: [
        hist({
          bookId: 'b4b',
          status: 'Snatched',
          source: 'sabnzbd',
          downloadId: 'nzo-gone',
          snatchedAt: '2026-07-01T00:00:00Z',
          completedAt: '2026-07-01T00:20:00Z',
        }),
      ],
      // The SAB job is in NEITHER the queue nor the recent history page.
      sabHistory: [sabHistory('nzo-other', 'Completed')],
    });
    expect(items[0]).toMatchObject({ stage: 'failed', failureKind: 'stranded_import' });
  });

  it('measures staleness from the download FINISH time when LL has it (a long download is not a strand)', () => {
    const items = build({
      llHistory: [
        hist({
          bookId: 'b4c',
          status: 'Snatched',
          source: 'sabnzbd',
          downloadId: 'nzo-slow',
          snatchedAt: '2026-07-14T02:00:00Z', // snatched 10h ago...
          completedAt: RECENT, // ...but only just finished
        }),
      ],
    });
    expect(items[0]).toMatchObject({ stage: 'importing' });
  });

  it('a usenet Snatched row with no SAB trace and no finish time falls back to the snatch age', () => {
    const fresh = build({ llHistory: [hist({ bookId: 'b4d', status: 'Snatched', source: 'sabnzbd', downloadId: 'x', snatchedAt: RECENT })] });
    expect(fresh[0]).toMatchObject({ stage: 'importing' });
    const aged = build({ llHistory: [hist({ bookId: 'b4d', status: 'Snatched', source: 'sabnzbd', downloadId: 'x', snatchedAt: AGED })] });
    expect(aged[0]).toMatchObject({ stage: 'failed', failureKind: 'stranded_import' });
  });

  it('a torrent Snatched row is `downloading` until LL records a finish time, then `importing` — never a failure', () => {
    const dl = build({
      llHistory: [hist({ bookId: 't1', status: 'Snatched', source: 'qbittorrent', downloadId: 'abc', snatchedAt: AGED })],
    });
    expect(dl[0]).toMatchObject({ stage: 'downloading', progress: null, sourceApp: 'qbittorrent', failureKind: null });
    const done = build({
      llHistory: [
        hist({ bookId: 't2', status: 'Snatched', source: 'qbittorrent', downloadId: 'def', snatchedAt: AGED, completedAt: AGED }),
      ],
    });
    expect(done[0]).toMatchObject({ stage: 'importing', failureKind: null });
  });

  it('maps a recent LL Failed row to failed / postprocess_failed carrying the DLResult', () => {
    const items = build({
      llHistory: [hist({ bookId: 'b5', status: 'Failed', format: 'audiobook', dlResult: 'Progress: 0%', snatchedAt: RECENT })],
    });
    expect(items[0]).toMatchObject({
      stage: 'failed',
      failureKind: 'postprocess_failed',
      failureReason: 'Progress: 0%',
      kind: 'audiobook',
      wall: 'audiobooks',
    });
    expect(items[0]!.actions).toEqual(['retry_import', 'force_research']);
  });

  it('classifies a Failed row that never downloaded (send / fetch / abort / reject) as download_failed, re-search only', () => {
    for (const dlResult of [
      'Failed to send nzb to @ SABNZBD',
      'Failed to send torrent to QBITTORRENT',
      'URL Fetching failed; timeout',
      'Aborted, cannot be completed - https://sabnzbd.org/not-complete',
      'Rejecting torrent name Anthology, contains undesired word',
      'Repair failed, not enough repair blocks (12 short)',
    ]) {
      const items = build({ llHistory: [hist({ bookId: 'b5d', status: 'Failed', dlResult, snatchedAt: RECENT })] });
      expect(items[0], dlResult).toMatchObject({ stage: 'failed', failureKind: 'download_failed' });
      expect(items[0]!.actions).toEqual(['force_research']);
    }
  });

  it('maps a Snatched row whose SAB job FAILED to failed / download_failed (re-search only)', () => {
    const items = build({
      llHistory: [hist({ bookId: 'b6', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-6' })],
      sabHistory: [sabHistory('nzo-6', 'Failed', 'Par2 repair failed')],
    });
    const item = items[0]!;
    expect(item).toMatchObject({ stage: 'failed', failureKind: 'download_failed', sourceApp: 'sabnzbd' });
    expect(item.actions).toEqual(['force_research']); // a dead download can't be retry-imported
  });

  it('produces distinct ids per (book, format) and skips unknown statuses', () => {
    const items = build({
      llHistory: [
        hist({ bookId: 'b7', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-7', format: 'ebook', snatchedAt: AGED }),
        hist({ bookId: 'b7', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-8', format: 'audiobook', snatchedAt: AGED }),
        hist({ bookId: 'b8', status: 'Ignored' }),
      ],
      sabHistory: [sabHistory('nzo-7', 'Completed'), sabHistory('nzo-8', 'Completed')],
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('books:ll:b7:ebook');
    expect(ids).toContain('books:ll:b7:audiobook');
    expect(ids).not.toContain('books:ll:b8:ebook'); // Ignored → skipped
  });
});

describe('buildBooksActivity — history is a log: reduce to the latest grab per book+format', () => {
  it('a later Processed grab supersedes an earlier Failed one (no ghost failure); a later Failed supersedes an earlier Snatched', () => {
    const items = build({
      llHistory: [
        hist({ bookId: 'r1', status: 'Failed', dlResult: 'Failed to send nzb', snatchedAt: '2026-07-14T08:00:00Z' }),
        hist({ bookId: 'r1', status: 'Processed', snatchedAt: '2026-07-14T09:00:00Z', completedAt: '2026-07-14T09:10:00Z' }),
        hist({ bookId: 'r2', status: 'Snatched', source: 'sabnzbd', downloadId: 'old', snatchedAt: '2026-07-13T08:00:00Z' }),
        hist({ bookId: 'r2', status: 'Failed', dlResult: 'Aborted, cannot be completed', snatchedAt: '2026-07-14T08:00:00Z' }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'books:ll:r2:ebook', stage: 'failed', failureKind: 'download_failed' });
  });

  it('a Failed retry after a copy already landed is not an incident', () => {
    const items = build({
      llHistory: [
        hist({ bookId: 'r3', status: 'Processed', snatchedAt: '2026-07-10T08:00:00Z', completedAt: '2026-07-10T08:10:00Z' }),
        hist({ bookId: 'r3', status: 'Failed', dlResult: 'Failed to send nzb', snatchedAt: RECENT }),
      ],
    });
    expect(items).toEqual([]);
  });

  it('drops LL\'s own "Duplicate NZB" rejections: the earlier attempt decides the state', () => {
    const items = build({
      llHistory: [
        hist({ bookId: 'r4', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-r4', snatchedAt: AGED }),
        hist({ bookId: 'r4', status: 'Failed', dlResult: 'Duplicate NZB', snatchedAt: RECENT }),
      ],
      sabQueue: [queue('nzo-r4', 90)],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ stage: 'downloading', progress: 90 });
    expect(build({ llHistory: [hist({ bookId: 'r5', status: 'Failed', dlResult: 'Duplicate NZB', snatchedAt: RECENT })] })).toEqual([]);
  });

  it('a Failed grab ages out of the window (the log is never pruned); a Snatched strand never does', () => {
    const old = '2026-06-01T00:00:00Z';
    expect(build({ llHistory: [hist({ bookId: 'w1', status: 'Failed', dlResult: 'Failed to send nzb', snatchedAt: old })] })).toEqual([]);
    const strand = build({
      llHistory: [hist({ bookId: 'w2', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-w2', snatchedAt: old, completedAt: old })],
    });
    expect(strand[0]).toMatchObject({ stage: 'failed', failureKind: 'stranded_import' });
  });

  it('Processed / Seeding read `completed` only inside the completed horizon', () => {
    const recent = build({
      llHistory: [hist({ bookId: 'c1', status: 'Processed', snatchedAt: AGED, completedAt: RECENT })],
    });
    expect(recent[0]).toMatchObject({ stage: 'completed', actions: [] });
    const stale = build({
      llHistory: [
        hist({ bookId: 'c2', status: 'Processed', snatchedAt: AGED, completedAt: AGED }),
        hist({ bookId: 'c3', status: 'Seeding', snatchedAt: AGED }),
      ],
    });
    expect(stale).toEqual([]);
  });

  it('a wanted book with a live/failed grab shows that grab, not a second `searching` tile; an aged-out failure returns to searching', () => {
    const wanted = [wantedBook({ bookId: 'x1', title: 'Held' }), wantedBook({ bookId: 'x2', title: 'Old failure' })];
    const items = build({
      llWanted: wanted,
      llHistory: [
        hist({ bookId: 'x1', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-x1' }),
        hist({ bookId: 'x2', status: 'Failed', dlResult: 'Failed to send nzb', snatchedAt: '2026-06-01T00:00:00Z' }),
      ],
      sabQueue: [queue('nzo-x1', 10)],
    });
    expect(items.find((i) => i.id === 'books:ll:x1:ebook')).toMatchObject({ stage: 'downloading' });
    expect(items.find((i) => i.id === 'books:ll:x2:ebook')).toMatchObject({ stage: 'searching' });
    expect(items).toHaveLength(2);
  });
});

// ---- REAL samples (anonymized: the indexer apikey is zeroed) captured from the live LazyLibrarian ----
// 2026-09-29 by read-only GETs. They pin the wire shape the adapter must survive.
const FIXTURES = new URL('../../lazylibrarian/__tests__/fixtures/', import.meta.url);
const realJson = (name: string): string => readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8');

async function realSources(): Promise<Pick<BooksActivitySources, 'llHistory' | 'llWanted'>> {
  const client = new LazyLibrarianReadClient({
    baseUrl: 'http://ll:5299',
    apiKey: 'k',
    fetchImpl: (async (url: string) =>
      new Response(realJson(String(url).includes('cmd=getHistory') ? 'get-history.json' : 'get-wanted.json'))) as unknown as typeof fetch,
  });
  return { llHistory: await client.getHistory(), llWanted: await client.getWanted() };
}

describe('buildBooksActivity — real getHistory / getWanted samples', () => {
  const SEP_29 = new Date('2026-09-29T02:00:00Z');

  it('surfaces the live stranded audiobooks and the torrent in flight, and keeps the wanted book list as searching', async () => {
    const { llHistory, llWanted } = await realSources();
    const items = build({ llHistory, llWanted }, { now: SEP_29 });
    const byTitle = (needle: string) => items.find((i) => i.title.includes(needle))!;
    // A usenet audiobook SAB no longer reports: stranded by LL's own `Completed` epoch (issue #562 class).
    expect(byTitle('Demigod Diaries')).toMatchObject({ stage: 'failed', failureKind: 'stranded_import', kind: 'audiobook' });
    expect(byTitle('Expanse 02')).toMatchObject({ stage: 'failed', failureKind: 'stranded_import' });
    // A qBittorrent grab LL has no finish time for yet: downloading, no fabricated failure.
    expect(byTitle('Witch')).toMatchObject({ stage: 'downloading', sourceApp: 'qbittorrent', failureKind: null });
    // The wanted BOOK rows: titles come from BookName (not "Untitled"), one tile per wanted format.
    expect(byTitle('Kingdom of Ash')).toMatchObject({ stage: 'searching', kind: 'book' });
    expect(byTitle('Wild Cards II. Aces High')).toMatchObject({ stage: 'searching', kind: 'book' });
    expect(items.filter((i) => i.title.includes('Wild Cards'))).toHaveLength(2); // ebook + audiobook wanted
    expect(items.some((i) => i.title === 'Untitled')).toBe(false);
  });

  it('carries no indexer key or markup into a failure reason, and drops the July failures outside the window', async () => {
    const { llHistory } = await realSources();
    const wide = build({ llHistory }, { now: new Date('2026-07-13T00:00:00Z'), failedWindowMs: 3650 * 24 * 3600 * 1000 });
    const sendFailure = wide.find((i) => i.title.startsWith('Sarah J Maas - Throne of Glass 01'))!;
    expect(sendFailure).toMatchObject({ stage: 'failed', failureKind: 'download_failed', failureReason: 'Failed to send nzb to @ SABNZBD' });
    for (const i of wide) {
      expect(i.failureReason ?? '').not.toMatch(/apikey|<a /i);
    }
    // "Duplicate NZB" is LL's dedupe, never a tile.
    expect(wide.some((i) => i.title.includes('00.5'))).toBe(false);
    // With the default 7-day window every July failure is gone from a late-September read.
    const late = build({ llHistory }, { now: SEP_29 });
    expect(late.filter((i) => i.stage === 'failed' && i.failureKind !== 'stranded_import')).toEqual([]);
  });
});
