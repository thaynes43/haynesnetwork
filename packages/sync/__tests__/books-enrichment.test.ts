// DESIGN-024 D-01 amendment (detail-page parity) — the About/Details enrichment mapping. Pure,
// fixture-driven unit tests over the REAL wire shapes probed live 2026-07-17 against the deployed
// Kavita 0.9.x (`/api/Series/metadata`, series list) + ABS 2.35.x (library-items list). Covers:
// HTML-strip, the Kavita metadata reduce (title/name entities, releaseYear-0 → null), the ABS inline
// enrichment, and the change-gate that skips unchanged series (carry-forward) but re-fetches changed ones.
import { describe, expect, it } from 'vitest';
import type { AbsItem, KavitaSeries, KavitaSeriesMetadata, KavitaVolume } from '@hnet/books';
import {
  fetchBooksSnapshot,
  kavitaEnrichmentFrom,
  kavitaHeldBooksFrom,
  normalizeAbsItem,
  normalizeKavitaSeries,
  selectMetadataRefresh,
  stripHtml,
  type BooksSyncBundle,
  type ExistingKavitaEnrichment,
} from '../src/books';

describe('stripHtml — Kavita/ABS description → plain text', () => {
  it('strips tags, decodes entities, collapses whitespace, keeps paragraph breaks', () => {
    const html = '<div><div class="blurb">Lily\n Bard is a loner.&nbsp;</div></div><p>She snoops.</p>';
    expect(stripHtml(html)).toBe('Lily Bard is a loner.\n\nShe snoops.');
  });
  it('is null for blank / empty / whitespace-only', () => {
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml('')).toBeNull();
    expect(stripHtml('<div>  </div>')).toBeNull();
  });
});

describe('kavitaEnrichmentFrom — SeriesMetadataDto reduce', () => {
  it('reduces summary/genres(title)/publishers(name)/language/releaseYear', () => {
    const meta: KavitaSeriesMetadata = {
      summary: '<div class="blurb">A murder in a small town.</div>',
      genres: [{ title: 'Mystery' }, { title: 'Crime' }],
      publishers: [{ name: 'Penguin' }],
      language: 'en',
      releaseYear: 1996,
    };
    expect(kavitaEnrichmentFrom(meta)).toEqual({
      summary: 'A murder in a small town.',
      genres: ['Mystery', 'Crime'],
      publisher: 'Penguin',
      language: 'en',
      year: 1996,
      writers: [],
    });
  });
  it('treats releaseYear 0 + empty language/summary as honest null/[]', () => {
    const meta: KavitaSeriesMetadata = { summary: '', genres: [], publishers: [], language: '', releaseYear: 0 };
    expect(kavitaEnrichmentFrom(meta)).toEqual({
      summary: null,
      genres: [],
      publisher: null,
      language: null,
      year: null,
      writers: [],
    });
  });
  it('reduces writers(name) — the flat-folder author fallback source', () => {
    const meta: KavitaSeriesMetadata = {
      summary: '',
      genres: [],
      publishers: [],
      writers: [{ name: 'Diana Gabaldon' }, { name: 'A Co-Writer' }],
      language: '',
      releaseYear: 0,
    };
    expect(kavitaEnrichmentFrom(meta).writers).toEqual(['Diana Gabaldon', 'A Co-Writer']);
  });
});

describe('normalizeAbsItem — inline enrichment (no extra call)', () => {
  it('carries summary(description)/publisher/isbn/file_count from the list item', () => {
    const now = new Date('2026-07-17T00:00:00Z');
    const item = {
      id: 'ab5',
      addedAt: 1783702399325,
      updatedAt: 1783702399325,
      media: {
        metadata: {
          title: 'Oliver Twist',
          description: '<p>An orphan in London.</p>',
          publisher: 'Penguin Audio',
          isbn: '9780141439747',
          language: 'English',
        },
        numAudioFiles: 12,
        size: 210000000,
        duration: 60200,
      },
    } as unknown as AbsItem;
    const row = normalizeAbsItem(item, 'lib', 'Audio Books', 'https://abs.example', now);
    expect(row.summary).toBe('An orphan in London.');
    expect(row.publisher).toBe('Penguin Audio');
    expect(row.isbn).toBe('9780141439747');
    expect(row.fileCount).toBe(12);
    expect(row.sizeBytes).toBe(210000000);
    expect(row.metadataSyncedAt).toBe(now);
  });
});

describe('normalizeKavitaSeries — applies enrichment / stays null without it', () => {
  const series = {
    id: 102,
    name: "Shakespeare's Landlord",
    sortName: "Shakespeare's Landlord",
    format: 3,
    libraryId: 1,
    libraryName: 'Books',
    pages: 210,
    folderPath: '/data/EBooks/Charlaine Harris',
    lowestFolderPath: "/data/EBooks/Charlaine Harris/Shakespeare's Landlord",
    lastChapterAddedUtc: '2026-07-09T12:00:00',
  } as unknown as KavitaSeries;

  it('an un-enriched (new) series has null enrichment + empty genres', () => {
    const row = normalizeKavitaSeries(series, 'book', 'Books', 'https://kavita.example', null);
    expect(row.summary).toBeNull();
    expect(row.genres).toEqual([]);
    expect(row.year).toBeNull();
    expect(row.metadataSyncedAt).toBeNull();
    // Kavita size/isbn/file_count are the documented gap (series-detail skipped).
    expect(row.sizeBytes).toBeNull();
    expect(row.isbn).toBeNull();
    expect(row.fileCount).toBeNull();
  });

  it('applies fresh enrichment (summary/genres/publisher/year + language into attrs)', () => {
    const now = new Date('2026-07-17T00:00:00Z');
    const row = normalizeKavitaSeries(series, 'book', 'Books', 'https://kavita.example', {
      data: { summary: 'A murder.', genres: ['Mystery'], publisher: 'Penguin', language: 'en', year: 1996, writers: [] },
      metadataSyncedAt: now,
    });
    expect(row.summary).toBe('A murder.');
    expect(row.genres).toEqual(['Mystery']);
    expect(row.publisher).toBe('Penguin');
    expect(row.year).toBe(1996);
    expect(row.attrs.language).toBe('en');
    expect(row.attrs.format).toBe(3);
    expect(row.metadataSyncedAt).toBe(now);
  });

  it('the folder-derived author stays PRIMARY; metadata writers fill a FLAT layout (the 2026-07-21 pairing-gap fix)', () => {
    const now = new Date('2026-07-21T00:00:00Z');
    const enrichment = {
      data: { summary: null, genres: [], publisher: null, language: null, year: null, writers: ['Diana Gabaldon'] },
      metadataSyncedAt: now,
    };
    // Author folder layout → the folder wins even when writers are present.
    const nested = normalizeKavitaSeries(series, 'book', 'Books', 'https://kavita.example', enrichment);
    expect(nested.author).toBe('Charlaine Harris');
    // Flat layout (folderPath === lowestFolderPath ⇒ no author directory) → the writer fills it.
    const flat = {
      ...(series as unknown as Record<string, unknown>),
      folderPath: '/data/EBooks/Outlander',
      lowestFolderPath: '/data/EBooks/Outlander',
    } as unknown as KavitaSeries;
    const healed = normalizeKavitaSeries(flat, 'book', 'Books', 'https://kavita.example', enrichment);
    expect(healed.author).toBe('Diana Gabaldon');
    // Flat layout with NO writers stays an honest null.
    const bare = normalizeKavitaSeries(flat, 'book', 'Books', 'https://kavita.example', {
      data: { summary: null, genres: [], publisher: null, language: null, year: null, writers: [] },
      metadataSyncedAt: now,
    });
    expect(bare.author).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The change-gate: fetchBooksSnapshot only calls getSeriesMetadata for new/changed series.
// ---------------------------------------------------------------------------

function stubBundle(
  getSeriesMetadata: (id: string) => Promise<KavitaSeriesMetadata>,
  listSeriesVolumes: (id: string) => Promise<KavitaVolume[]> = async () => [],
  libraryType = 2,
): {
  bundle: BooksSyncBundle;
  calls: string[];
  volumeCalls: string[];
} {
  const calls: string[] = [];
  const volumeCalls: string[] = [];
  const series: KavitaSeries[] = [
    { id: 102, name: 'Landlord', sortName: 'Landlord', format: 3, libraryId: 1, libraryName: 'Books', pages: 210, folderPath: '/data/EBooks/CH', lowestFolderPath: '/data/EBooks/CH/Landlord', lastChapterAddedUtc: '2026-07-09T12:00:00' } as unknown as KavitaSeries,
    { id: 103, name: 'Champion', sortName: 'Champion', format: 3, libraryId: 1, libraryName: 'Books', pages: 230, folderPath: '/data/EBooks/CH', lowestFolderPath: '/data/EBooks/CH/Champion', lastChapterAddedUtc: '2026-07-10T12:00:00' } as unknown as KavitaSeries,
  ];
  const bundle = {
    kavitaPublicUrl: 'https://kavita.example',
    audiobookshelfPublicUrl: 'https://abs.example',
    kavita: {
      listLibraries: async () => [{ id: 1, name: 'Books', type: libraryType }],
      listSeriesPage: async () => ({ items: series, total: series.length, hasAuthoritativeTotal: true }),
      getSeriesMetadata: async (id: string) => {
        calls.push(id);
        return getSeriesMetadata(id);
      },
      listSeriesVolumes: async (id: string) => {
        volumeCalls.push(id);
        return listSeriesVolumes(id);
      },
    },
    audiobookshelf: {
      listLibraries: async () => [],
    },
  } as unknown as BooksSyncBundle;
  return { bundle, calls, volumeCalls };
}

describe('fetchBooksSnapshot — Kavita enrichment change-gate', () => {
  const meta = (): KavitaSeriesMetadata => ({ summary: 's', genres: [{ title: 'Mystery' }], publishers: [{ name: 'P' }], language: 'en', releaseYear: 2000 });

  it('enriches EVERY series when no existing map is supplied', async () => {
    const { bundle, calls } = stubBundle(async () => meta());
    const snap = await fetchBooksSnapshot(bundle);
    expect(calls.sort()).toEqual(['102', '103']);
    expect(snap.rows.every((r) => r.summary === 's')).toBe(true);
  });

  it('skips an UNCHANGED series (carry-forward) and re-fetches a CHANGED one', async () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([
      // 102 unchanged (same stamp, already enriched) → skipped, carried forward.
      ['102', { sourceUpdatedAt: new Date('2026-07-09T12:00:00'), metadataSyncedAt: new Date('2026-07-16T00:00:00Z'), data: { summary: 'OLD', genres: ['Kept'], publisher: 'Old Pub', language: 'en', year: 1996, writers: [] } }],
      // 103 stamp differs from the fresh list stamp → re-fetched.
      ['103', { sourceUpdatedAt: new Date('2026-07-01T00:00:00'), metadataSyncedAt: new Date('2026-07-16T00:00:00Z'), data: { summary: 'STALE', genres: [], publisher: null, language: null, year: null, writers: [] } }],
    ]);
    const { bundle, calls } = stubBundle(async () => meta());
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, metadataRefreshCap: 0 });
    expect(calls).toEqual(['103']); // ONLY the changed series hit the metadata endpoint
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(by['102']!.summary).toBe('OLD'); // carried forward, no request
    expect(by['102']!.genres).toEqual(['Kept']);
    expect(by['103']!.summary).toBe('s'); // freshly enriched
  });

  it('a metadata failure carries existing enrichment forward (never wipes it)', async () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([
      ['103', { sourceUpdatedAt: new Date('2026-07-01T00:00:00'), metadataSyncedAt: new Date('2026-07-16T00:00:00Z'), data: { summary: 'KEEP', genres: ['G'], publisher: 'Pub', language: 'en', year: 2001, writers: [] } }],
    ]);
    const { bundle } = stubBundle(async (id) => {
      if (id === '103') throw new Error('kavita 500');
      return meta();
    });
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, metadataRefreshCap: 0 });
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(by['103']!.summary).toBe('KEEP'); // enrichment preserved on failure
  });
});

// ---------------------------------------------------------------------------
// Issue #661 — the held books: what a Kavita BOOK series actually holds (`/api/Series/volumes`).
// ---------------------------------------------------------------------------

/** Live shapes probed 2026-10-04 (trimmed): a numbered volume, a loose special, a two-copy chapter. */
const FIRE_AND_BLOOD: KavitaVolume[] = [
  {
    name: '0.5',
    chapters: [
      { title: '-100000', titleName: 'Fire & Blood', isSpecial: false, isbn: '9781524796280', writers: [{ name: 'George R. R. Martin' }] },
    ],
  },
];
const JACK_RYAN: KavitaVolume[] = [
  { name: '6', chapters: [{ title: '-100000', titleName: 'Without Remorse', isbn: '', writers: [{ name: 'Tom Clancy' }] }] },
  { name: '11', chapters: [{ title: '-100000', titleName: 'Ryan 11: Red Rabbit', isbn: '9780425191187', writers: [{ name: 'Tom Clancy' }] }] },
];

describe('kavitaHeldBooksFrom — one held book per chapter', () => {
  it('takes the chapter epub title, first writer and ISBN (blank ISBN → null)', () => {
    expect(kavitaHeldBooksFrom(FIRE_AND_BLOOD)).toEqual([
      { title: 'Fire & Blood', author: 'George R. R. Martin', isbn: '9781524796280' },
    ]);
    expect(kavitaHeldBooksFrom(JACK_RYAN)).toEqual([
      { title: 'Without Remorse', author: 'Tom Clancy', isbn: null },
      { title: 'Ryan 11: Red Rabbit', author: 'Tom Clancy', isbn: '9780425191187' },
    ]);
  });

  it('falls back to a non-numeric chapter title; a numeric placeholder names no book', () => {
    expect(
      kavitaHeldBooksFrom([
        { name: '-100000', chapters: [{ title: 'Kiss Kiss', titleName: '', isSpecial: true, isbn: '' }] },
        { name: '3', chapters: [{ title: '-100000', titleName: null }] },
        { name: '4', chapters: [{ title: '2.5' }] },
      ]),
    ).toEqual([
      { title: 'Kiss Kiss', author: null, isbn: null },
      { title: null, author: null, isbn: null },
      { title: null, author: null, isbn: null },
    ]);
  });

  it('an empty series holds no books', () => {
    expect(kavitaHeldBooksFrom([])).toEqual([]);
    expect(kavitaHeldBooksFrom([{ name: '0', chapters: null }])).toEqual([]);
  });
});

describe('fetchBooksSnapshot — the held-books read (issue #661)', () => {
  const meta = (): KavitaSeriesMetadata => ({ summary: 's', genres: [], publishers: [], language: 'en', releaseYear: 2000 });
  const enriched = { summary: 'OLD', genres: [], publisher: null, language: 'en', year: null, writers: [] };
  const heldOf = (r: { attrs: Record<string, unknown> }) => r.attrs.heldBooks;

  it('reads every new BOOK series and stores attrs.heldBooks', async () => {
    const { bundle, volumeCalls } = stubBundle(async () => meta(), async (id) => (id === '102' ? FIRE_AND_BLOOD : JACK_RYAN));
    const snap = await fetchBooksSnapshot(bundle);
    expect(volumeCalls.sort()).toEqual(['102', '103']);
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(heldOf(by['102']!)).toEqual([{ title: 'Fire & Blood', author: 'George R. R. Martin', isbn: '9781524796280' }]);
    expect(heldOf(by['103']!)).toHaveLength(2);
    expect(by['102']!.attrs).toMatchObject({ format: 3, language: 'en' });
  });

  it('carries an unchanged series forward, and backfills one that was never read', async () => {
    const carried = [{ title: 'Landlord', author: 'CH', isbn: null }];
    const existing = new Map<string, ExistingKavitaEnrichment>([
      // 102 unchanged and already read → no request, carried forward.
      ['102', { sourceUpdatedAt: new Date('2026-07-09T12:00:00'), metadataSyncedAt: new Date('2026-07-16T00:00:00Z'), data: enriched, heldBooks: carried }],
      // 103 unchanged but never read (pre-#661 row) → read once (the backfill), metadata still skipped.
      ['103', { sourceUpdatedAt: new Date('2026-07-10T12:00:00'), metadataSyncedAt: new Date('2026-07-16T00:00:00Z'), data: enriched }],
    ]);
    const { bundle, calls, volumeCalls } = stubBundle(async () => meta(), async () => FIRE_AND_BLOOD);
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, metadataRefreshCap: 0 });
    expect(volumeCalls).toEqual(['103']);
    expect(calls).toEqual([]); // the metadata change-gate is untouched
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(heldOf(by['102']!)).toEqual(carried);
    expect(heldOf(by['103']!)).toHaveLength(1);
  });

  it('a failed read carries the last value forward, or leaves the row unread (retried next run)', async () => {
    const carried = [{ title: 'Champion', author: 'CH', isbn: null }];
    const existing = new Map<string, ExistingKavitaEnrichment>([
      ['102', { sourceUpdatedAt: new Date('2026-07-01T00:00:00'), metadataSyncedAt: null, data: enriched }],
      ['103', { sourceUpdatedAt: new Date('2026-07-01T00:00:00'), metadataSyncedAt: null, data: enriched, heldBooks: carried }],
    ]);
    const { bundle } = stubBundle(async () => meta(), async () => {
      throw new Error('kavita 500');
    });
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, metadataRefreshCap: 0 });
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect('heldBooks' in by['102']!.attrs).toBe(false); // unread, never an empty (= "holds nothing") list
    expect(heldOf(by['103']!)).toEqual(carried);
  });

  it('never reads a comics library (comics are never paired)', async () => {
    const { bundle, volumeCalls } = stubBundle(async () => meta(), async () => FIRE_AND_BLOOD, 1);
    const snap = await fetchBooksSnapshot(bundle);
    expect(volumeCalls).toEqual([]);
    expect(snap.rows.every((r) => !('heldBooks' in r.attrs))).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Issue #712 — Kavita has no metadata change signal, so a metadata-only edit lands via the rolling refresh.
// ---------------------------------------------------------------------------

describe('fetchBooksSnapshot — a metadata-only Kavita edit is picked up (issue #712)', () => {
  const NOW = new Date('2026-10-05T20:00:00Z');
  const edited = (): KavitaSeriesMetadata => ({ summary: 'NEW', genres: [], publishers: [], language: 'en', releaseYear: 2000 });
  const row = (language: string | null, syncedAt: Date, stamp = '2026-07-09T12:00:00'): ExistingKavitaEnrichment => ({
    // The list stamp (lastChapterAddedUtc) is UNCHANGED: Kavita does not move it when metadata is edited.
    sourceUpdatedAt: new Date(stamp),
    metadataSyncedAt: syncedAt,
    data: { summary: 'OLD', genres: [], publisher: null, language, year: null, writers: [] },
  });

  it('re-reads an unchanged series whose stored language is foreign, EVERY run, even if read a minute ago', async () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([
      ['102', row('nl', new Date(NOW.getTime() - 60_000))],
      ['103', row('en', new Date(NOW.getTime() - 60_000), '2026-07-10T12:00:00')],
    ]);
    const { bundle, calls } = stubBundle(async () => edited());
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, now: NOW });
    expect(calls).toEqual(['102']); // the foreign one only; the recently-read English one is gated out
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(by['102']!.attrs).toMatchObject({ language: 'en' });
    expect(by['102']!.summary).toBe('NEW');
    expect(by['102']!.metadataSyncedAt).toEqual(NOW);
    expect(by['103']!.summary).toBe('OLD');
  });

  it('re-reads an unchanged English series once its last read is past the minimum age (any edit lands eventually)', async () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([
      ['102', row('en', new Date(NOW.getTime() - 7 * 3600_000))],
      ['103', row('en', new Date(NOW.getTime() - 5 * 3600_000), '2026-07-10T12:00:00')],
    ]);
    const { bundle, calls } = stubBundle(async () => edited());
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, now: NOW });
    expect(calls).toEqual(['102']);
    expect(Object.fromEntries(snap.rows.map((r) => [r.externalId, r]))['102']!.summary).toBe('NEW');
  });

  it('metadataRefreshCap: 0 turns the rolling refresh off (the bare change-gate)', async () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([['102', row('nl', new Date('2026-07-17T00:00:00Z'))]]);
    const { bundle, calls } = stubBundle(async () => edited());
    await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing, now: NOW, metadataRefreshCap: 0 });
    expect(calls).toEqual(['103']); // 103 is new to the mirror; 102 is gated out
  });
});

describe('selectMetadataRefresh (issue #712)', () => {
  const NOW = new Date('2026-10-05T20:00:00Z');
  const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600_000);
  const series = (ids: number[]) => ids.map((id) => ({ id }) as unknown as KavitaSeries);
  const row = (language: string | null, syncedAt: Date | null): ExistingKavitaEnrichment => ({
    sourceUpdatedAt: null,
    metadataSyncedAt: syncedAt,
    data: { summary: null, genres: [], publisher: null, language, year: null, writers: [] },
  });

  it('puts foreign-language series first, then the stalest past the minimum age, within the cap', () => {
    const existing = new Map<string, ExistingKavitaEnrichment>([
      ['1', row('en', hoursAgo(10))],
      ['2', row('en', hoursAgo(30))],
      ['3', row('de', hoursAgo(1))],
      ['4', row('en', hoursAgo(2))], // younger than the minimum age: never rotated in
      ['5', row(null, hoursAgo(20))], // blank is unknown, not foreign: ordinary rotation
      ['6', row('en', null)], // never read: the change-gate's job, not this one's
    ]);
    const pick = selectMetadataRefresh(series([1, 2, 3, 4, 5, 6, 7]), existing, { now: NOW, cap: 3 });
    expect([...pick]).toEqual([3, 2, 5]);
    expect([...selectMetadataRefresh(series([1, 2, 3, 4, 5, 6, 7]), existing, { now: NOW, cap: 10 })].sort()).toEqual([1, 2, 3, 5]);
  });

  it('selects nothing without an existing map or with cap 0', () => {
    expect(selectMetadataRefresh(series([1]), undefined, { now: NOW }).size).toBe(0);
    expect(selectMetadataRefresh(series([1]), new Map([['1', row('de', hoursAgo(99))]]), { now: NOW, cap: 0 }).size).toBe(0);
  });
});
