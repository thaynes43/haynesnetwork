import { describe, expect, it } from 'vitest';
import { buildBooksActivity, type BooksActivitySources } from '../src/activity/books-adapter';
import type { LlWantedEntry } from '@hnet/lazylibrarian/read';
import type { SabHistorySlot, SabQueueSlot } from '@hnet/downloads/read';

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the pure books normalizer: the LL wanted-table +
// SAB queue/history → the Activity stage machine (Q-02). The KEY case is the STRANDED import (the OPS-013
// §11 42-book incident: LL still Snatched while SAB shows the job Completed) — this test is that incident's
// regression guard.

const NOW = new Date('2026-07-14T12:00:00Z');
const AGED = '2026-07-14T09:00:00Z'; // 3h before NOW → past the 30-min strand horizon

function wanted(overrides: Partial<LlWantedEntry> & { bookId: string; status: string }): LlWantedEntry {
  return {
    title: overrides.title ?? overrides.bookId,
    source: overrides.source ?? null,
    downloadId: overrides.downloadId ?? null,
    format: overrides.format ?? 'ebook',
    dlResult: overrides.dlResult ?? null,
    snatchedAt: overrides.snatchedAt ?? null,
    ...overrides,
  };
}

function queue(nzoId: string, percentage: number): SabQueueSlot {
  return { nzoId, name: nzoId, percentage, status: 'Downloading', category: 'lazylibrarian' };
}

function history(nzoId: string, status: string, failMessage: string | null = null): SabHistorySlot {
  return { nzoId, name: nzoId, status, category: 'lazylibrarian', storage: `/x/${nzoId}`, failMessage };
}

function build(sources: BooksActivitySources) {
  return buildBooksActivity(sources, { now: NOW, strandHorizonMs: 30 * 60 * 1000 });
}

describe('buildBooksActivity — the books stage machine', () => {
  it('maps a Wanted row to `searching`', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b1', status: 'Wanted' })],
      sabQueue: [],
      sabHistory: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'books:ll:b1:ebook', stage: 'searching', kind: 'book', wall: 'books', section: 'books' });
    expect(items[0]!.actions).toEqual([]);
  });

  it('maps a Snatched row with a live SAB queue slot to `downloading` with progress + sabnzbd source', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b2', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-2' })],
      sabQueue: [queue('nzo-2', 61)],
      sabHistory: [],
    });
    expect(items[0]).toMatchObject({ stage: 'downloading', progress: 61, sourceApp: 'sabnzbd' });
  });

  it('maps a Snatched row whose SAB job Completed but is FRESH to `importing`', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b3', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-3', snatchedAt: NOW.toISOString() })],
      sabQueue: [],
      sabHistory: [history('nzo-3', 'Completed')],
    });
    expect(items[0]).toMatchObject({ stage: 'importing' });
    expect(items[0]!.failureKind).toBeNull();
  });

  it('THE INCIDENT: a Snatched row whose SAB job Completed but is STALE → failed / stranded_import', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b4', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-4', snatchedAt: AGED, title: 'The Stranded Import' })],
      sabQueue: [],
      sabHistory: [history('nzo-4', 'Completed')],
    });
    const item = items[0]!;
    expect(item.stage).toBe('failed');
    expect(item.failureKind).toBe('stranded_import');
    expect(item.failureReason).toMatch(/never imported/i);
    // A strand is retry-import-able AND re-searchable.
    expect(item.actions).toEqual(['retry_import', 'force_research']);
  });

  it('maps an LL Failed row to failed / postprocess_failed carrying the DLResult', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b5', status: 'Failed', format: 'audiobook', dlResult: 'Progress: 0%' })],
      sabQueue: [],
      sabHistory: [],
    });
    expect(items[0]).toMatchObject({ stage: 'failed', failureKind: 'postprocess_failed', failureReason: 'Progress: 0%', kind: 'audiobook', wall: 'audiobooks' });
    expect(items[0]!.actions).toEqual(['retry_import', 'force_research']);
  });

  it('maps a Snatched row whose SAB job FAILED to failed / download_failed (re-search only)', () => {
    const items = build({
      llWanted: [wanted({ bookId: 'b6', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-6' })],
      sabQueue: [],
      sabHistory: [history('nzo-6', 'Failed', 'Par2 repair failed')],
    });
    const item = items[0]!;
    expect(item).toMatchObject({ stage: 'failed', failureKind: 'download_failed', sourceApp: 'sabnzbd' });
    expect(item.actions).toEqual(['force_research']); // a dead download can't be retry-imported
  });

  it('produces distinct ids per (book, format) and skips unknown statuses', () => {
    const items = build({
      llWanted: [
        wanted({ bookId: 'b7', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-7', format: 'ebook', snatchedAt: AGED }),
        wanted({ bookId: 'b7', status: 'Snatched', source: 'sabnzbd', downloadId: 'nzo-8', format: 'audiobook', snatchedAt: AGED }),
        wanted({ bookId: 'b8', status: 'Ignored' }),
      ],
      sabQueue: [],
      sabHistory: [history('nzo-7', 'Completed'), history('nzo-8', 'Completed')],
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('books:ll:b7:ebook');
    expect(ids).toContain('books:ll:b7:audiobook');
    expect(ids).not.toContain('books:ll:b8:ebook'); // Ignored → skipped
  });
});
