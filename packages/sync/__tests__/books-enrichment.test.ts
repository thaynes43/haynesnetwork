// DESIGN-024 D-01 amendment (detail-page parity) — the About/Details enrichment mapping. Pure,
// fixture-driven unit tests over the REAL wire shapes probed live 2026-07-17 against the deployed
// Kavita 0.9.x (`/api/Series/metadata`, series list) + ABS 2.35.x (library-items list). Covers:
// HTML-strip, the Kavita metadata reduce (title/name entities, releaseYear-0 → null), the ABS inline
// enrichment, and the change-gate that skips unchanged series (carry-forward) but re-fetches changed ones.
import { describe, expect, it } from 'vitest';
import type { AbsItem, KavitaSeries, KavitaSeriesMetadata } from '@hnet/books';
import {
  fetchBooksSnapshot,
  kavitaEnrichmentFrom,
  normalizeAbsItem,
  normalizeKavitaSeries,
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

function stubBundle(getSeriesMetadata: (id: string) => Promise<KavitaSeriesMetadata>): {
  bundle: BooksSyncBundle;
  calls: string[];
} {
  const calls: string[] = [];
  const series: KavitaSeries[] = [
    { id: 102, name: 'Landlord', sortName: 'Landlord', format: 3, libraryId: 1, libraryName: 'Books', pages: 210, folderPath: '/data/EBooks/CH', lowestFolderPath: '/data/EBooks/CH/Landlord', lastChapterAddedUtc: '2026-07-09T12:00:00' } as unknown as KavitaSeries,
    { id: 103, name: 'Champion', sortName: 'Champion', format: 3, libraryId: 1, libraryName: 'Books', pages: 230, folderPath: '/data/EBooks/CH', lowestFolderPath: '/data/EBooks/CH/Champion', lastChapterAddedUtc: '2026-07-10T12:00:00' } as unknown as KavitaSeries,
  ];
  const bundle = {
    kavitaPublicUrl: 'https://kavita.example',
    audiobookshelfPublicUrl: 'https://abs.example',
    kavita: {
      listLibraries: async () => [{ id: 1, name: 'Books', type: 2 }],
      listSeriesPage: async () => ({ items: series, total: series.length, hasAuthoritativeTotal: true }),
      getSeriesMetadata: async (id: string) => {
        calls.push(id);
        return getSeriesMetadata(id);
      },
    },
    audiobookshelf: {
      listLibraries: async () => [],
    },
  } as unknown as BooksSyncBundle;
  return { bundle, calls };
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
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing });
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
    const snap = await fetchBooksSnapshot(bundle, undefined, { existingKavita: existing });
    const by = Object.fromEntries(snap.rows.map((r) => [r.externalId, r]));
    expect(by['103']!.summary).toBe('KEEP'); // enrichment preserved on failure
  });
});
