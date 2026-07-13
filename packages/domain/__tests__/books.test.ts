import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { booksItems } from '@hnet/db';
import { and, eq, isNull } from 'drizzle-orm';
import { bootMigratedDb, type TestDb } from './helpers';
import { syncBooks, type BooksItemInput } from '../src/books';

// ADR-046 / DESIGN-024 (PLAN-023) — the books ledger single-writer. Acceptance proof:
//   • syncBooks upserts the snapshot idempotently (re-sync updates in place, never duplicates);
//   • a vanished item is TOMBSTONED (deleted_at set), never hard-deleted;
//   • a re-appeared item is un-tombstoned;
//   • tombstoning is SCOPED to syncedSources (a partial run never tombstones the unsynced source).

const NOW = new Date('2026-07-10T12:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

function row(overrides: Partial<BooksItemInput> & Pick<BooksItemInput, 'source' | 'mediaKind' | 'externalId' | 'title'>): BooksItemInput {
  return {
    libraryId: '1',
    libraryName: 'Books',
    sortTitle: overrides.title,
    author: null,
    narrator: null,
    seriesName: null,
    year: null,
    releasedAt: null,
    genres: [],
    coverRef: null,
    deepLinkUrl: 'https://kavita.haynesnetwork.com/library/1/series/1',
    pageCount: null,
    wordCount: null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.db.delete(booksItems);
});

const liveRows = () =>
  t.db.select().from(booksItems).where(isNull(booksItems.deletedAt));
const allRows = () => t.db.select().from(booksItems);

describe('syncBooks', () => {
  it('upserts the snapshot and reports per-kind counts', async () => {
    const report = await syncBooks({
      db: t.db,
      syncedSources: ['kavita', 'audiobookshelf'],
      now: NOW,
      rows: [
        row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'A Book' }),
        row({ source: 'kavita', mediaKind: 'comic', externalId: 'k2', title: 'A Comic', libraryId: '2', libraryName: 'Comics' }),
        row({ source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a1', title: 'An Audiobook', durationSeconds: 3600 }),
      ],
    });
    expect(report.upserted).toBe(3);
    expect(report.tombstoned).toBe(0);
    expect(report.byKind).toEqual({ book: 1, comic: 1, audiobook: 1 });
    expect(await liveRows()).toHaveLength(3);
  });

  it('is idempotent: a re-sync updates in place, never duplicates', async () => {
    const base = {
      db: t.db,
      syncedSources: ['kavita'] as const,
      rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'Old Title' })],
    };
    await syncBooks({ ...base, now: NOW });
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      now: later(1000),
      rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'New Title' })],
    });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('New Title');
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('tombstones an item that vanished from the fresh snapshot (never hard-deletes)', async () => {
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      now: NOW,
      rows: [
        row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'Kept' }),
        row({ source: 'kavita', mediaKind: 'book', externalId: 'k2', title: 'Gone' }),
      ],
    });
    const report = await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      now: later(1000),
      rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'Kept' })],
    });
    expect(report.tombstoned).toBe(1);
    expect(await allRows()).toHaveLength(2); // still there, tombstoned
    expect(await liveRows()).toHaveLength(1);
    const [gone] = await t.db
      .select()
      .from(booksItems)
      .where(and(eq(booksItems.source, 'kavita'), eq(booksItems.externalId, 'k2')));
    expect(gone?.deletedAt).not.toBeNull();
  });

  it('un-tombstones a re-appeared item', async () => {
    await syncBooks({ db: t.db, syncedSources: ['kavita'], now: NOW, rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'X' })] });
    await syncBooks({ db: t.db, syncedSources: ['kavita'], now: later(1000), rows: [] }); // vanish → tombstone
    expect(await liveRows()).toHaveLength(0);
    await syncBooks({ db: t.db, syncedSources: ['kavita'], now: later(2000), rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'X' })] });
    expect(await liveRows()).toHaveLength(1);
  });

  it('scopes tombstoning to syncedSources (a partial run never tombstones the unsynced source)', async () => {
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita', 'audiobookshelf'],
      now: NOW,
      rows: [
        row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'Book' }),
        row({ source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a1', title: 'Audio' }),
      ],
    });
    // ABS was unreachable this run: only Kavita synced, ABS rows omitted from the snapshot.
    const report = await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      now: later(1000),
      rows: [row({ source: 'kavita', mediaKind: 'book', externalId: 'k1', title: 'Book' })],
    });
    expect(report.tombstoned).toBe(0); // ABS row untouched, NOT tombstoned
    expect(await liveRows()).toHaveLength(2);
  });
});
