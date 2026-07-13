// ADR-046 / DESIGN-024 D-05 (F-06 — the ADR-041 idiom ported to the books cover proxy). Mirrors
// ytdlsub-poster.test.ts: the id validation stays closed per source, the ETag is strong and
// version-rotating (ABS bakes in the sized-variant token; Kavita keeps the pre-F-06 formula so
// existing browser caches stay valid), and getBooksCover memoizes ONLY the primary tier in the
// byte-capped ThumbLruCache — the ABS original fallback tier is served, never cached.
import { describe, expect, it } from 'vitest';
import type { BooksReadClients } from '@hnet/books/read';
import {
  ABS_COVER_VARIANT,
  booksCoverEtag,
  getBooksCover,
  isBooksSource,
  isValidBooksExternalId,
} from '../src/books-cover';
import { ThumbLruCache } from '../src/ytdlsub-poster';

const ABS_ID = '56ff4e21-ec45-47b6-b719-8ae4ec0d2253';

describe('isBooksSource / isValidBooksExternalId (closed enum + per-source id shape)', () => {
  it('accepts only the two sources', () => {
    expect(isBooksSource('kavita')).toBe(true);
    expect(isBooksSource('audiobookshelf')).toBe(true);
    expect(isBooksSource('plex')).toBe(false);
    expect(isBooksSource('')).toBe(false);
  });

  it('kavita ids are numeric; abs ids are uuid-shaped; junk is rejected', () => {
    expect(isValidBooksExternalId('kavita', '1169')).toBe(true);
    expect(isValidBooksExternalId('kavita', '../secret')).toBe(false);
    expect(isValidBooksExternalId('kavita', ABS_ID)).toBe(false);
    expect(isValidBooksExternalId('audiobookshelf', ABS_ID)).toBe(true);
    expect(isValidBooksExternalId('audiobookshelf', 'not a uuid !')).toBe(false);
    expect(isValidBooksExternalId('audiobookshelf', '')).toBe(false);
  });
});

describe('booksCoverEtag (strong, version-rotating; ABS variant-scoped)', () => {
  it('is strong and rotates on source, id, and coverVersion', () => {
    const a = booksCoverEtag('kavita', '1169', 'v1');
    expect(a).toMatch(/^".+"$/);
    expect(booksCoverEtag('kavita', '1169', 'v2')).not.toBe(a);
    expect(booksCoverEtag('kavita', '171', 'v1')).not.toBe(a);
    expect(booksCoverEtag('audiobookshelf', '1169', 'v1')).not.toBe(a);
  });

  it('the kavita formula is the pre-F-06 (source:id:version) hash — existing caches stay valid', () => {
    // Pinned: rotating this forces every browser to re-pull ~300 KB per tile for identical bytes.
    expect(booksCoverEtag('kavita', '1169', 'series_1169.png')).toBe(
      '"EM-H2vzyuNfZ5r9eQiW-6pvW2VQ"',
    );
  });

  it('the abs etag bakes in the sized-variant token (pre-variant JPEG caches revalidate into WebP)', () => {
    // Pinned to the w300webp representation: changing ABS_COVER_VARIANT must rotate this.
    expect(ABS_COVER_VARIANT).toEqual({ width: 300, format: 'webp' });
    expect(booksCoverEtag('audiobookshelf', ABS_ID, '1783702399325')).toBe(
      '"8kHWDn1BdNT0ZSRI_kNmEWqxzIU"',
    );
  });
});

// --- getBooksCover orchestration (fake clients + a fresh LRU per test) -------------------------

interface FakeCalls {
  kavita: string[];
  abs: { id: string; variant?: { width: number; format: string } }[];
}

function fakeClients(handlers: {
  kavita?: (id: string) => Response;
  abs?: (id: string, variant?: { width: number; format: string }) => Response;
}): { clients: BooksReadClients; calls: FakeCalls } {
  const calls: FakeCalls = { kavita: [], abs: [] };
  const clients = {
    kavita: {
      fetchSeriesCover: async (id: string) => {
        calls.kavita.push(id);
        return handlers.kavita ? handlers.kavita(id) : new Response('nope', { status: 404 });
      },
    },
    audiobookshelf: {
      fetchItemCover: async (id: string, variant?: { width: number; format: string }) => {
        calls.abs.push({ id, ...(variant ? { variant } : {}) });
        return handlers.abs ? handlers.abs(id, variant) : new Response('nope', { status: 404 });
      },
    },
  } as unknown as BooksReadClients;
  return { clients, calls };
}

const png = (bytes: number) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } });
const webp = (bytes: number) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/webp' } });
const jpeg = (bytes: number) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });

describe('getBooksCover (F-06 — LRU memoization + upstream-sized ABS variant)', () => {
  it('kavita: fetches once, memoizes, and serves the repeat from memory (no second upstream hit)', async () => {
    const { clients, calls } = fakeClients({ kavita: () => png(10) });
    const cache = new ThumbLruCache();
    const first = await getBooksCover('kavita', '1169', 'v1', { clients, cache });
    expect(first?.tier).toBe('primary');
    expect(first?.contentType).toBe('image/png');
    expect(first?.body.byteLength).toBe(10);
    const second = await getBooksCover('kavita', '1169', 'v1', { clients, cache });
    expect(second?.tier).toBe('primary');
    expect(calls.kavita).toEqual(['1169']); // exactly one upstream fetch
    expect(cache.size).toBe(1);
  });

  it('abs: requests the FIXED sized WebP variant upstream and memoizes it', async () => {
    const { clients, calls } = fakeClients({ abs: () => webp(8) });
    const cache = new ThumbLruCache();
    const result = await getBooksCover('audiobookshelf', ABS_ID, 'v1', { clients, cache });
    expect(result?.tier).toBe('primary');
    expect(result?.contentType).toBe('image/webp');
    expect(calls.abs).toEqual([{ id: ABS_ID, variant: { width: 300, format: 'webp' } }]);
    await getBooksCover('audiobookshelf', ABS_ID, 'v1', { clients, cache });
    expect(calls.abs).toHaveLength(1); // repeat = memory hit
  });

  it('abs: a sized-variant miss degrades to the ORIGINAL fallback tier — served, never memoized', async () => {
    const { clients, calls } = fakeClients({
      abs: (_id, variant) => (variant ? new Response('boom', { status: 500 }) : jpeg(20)),
    });
    const cache = new ThumbLruCache();
    const result = await getBooksCover('audiobookshelf', ABS_ID, 'v1', { clients, cache });
    expect(result?.tier).toBe('fallback');
    expect(result?.contentType).toBe('image/jpeg');
    expect(cache.size).toBe(0); // ADR-041 C-02 discipline: originals never stick in the LRU
    // Both tiers were tried, in order: sized first, then the original.
    expect(calls.abs).toEqual([
      { id: ABS_ID, variant: { width: 300, format: 'webp' } },
      { id: ABS_ID },
    ]);
    // A second request retries the sized variant (recovery swaps the small bytes back in).
    await getBooksCover('audiobookshelf', ABS_ID, 'v1', { clients, cache });
    expect(calls.abs).toHaveLength(4);
  });

  it('the cache key is version-scoped — replaced art misses and refetches', async () => {
    const { clients, calls } = fakeClients({ kavita: () => png(10) });
    const cache = new ThumbLruCache();
    await getBooksCover('kavita', '1169', 'v1', { clients, cache });
    await getBooksCover('kavita', '1169', 'v2', { clients, cache });
    expect(calls.kavita).toEqual(['1169', '1169']);
    expect(cache.size).toBe(2);
  });

  it('returns null for a missing upstream (404), absent clients (env), and a throwing client', async () => {
    const miss = fakeClients({});
    expect(await getBooksCover('kavita', '1', 'v', { clients: miss.clients, cache: new ThumbLruCache() })).toBeNull();
    expect(await getBooksCover('kavita', '1', 'v', { clients: null, cache: new ThumbLruCache() })).toBeNull();
    const throwing = {
      kavita: { fetchSeriesCover: async () => { throw new Error('down'); } },
      audiobookshelf: { fetchItemCover: async () => { throw new Error('down'); } },
    } as unknown as BooksReadClients;
    expect(await getBooksCover('kavita', '1', 'v', { clients: throwing, cache: new ThumbLruCache() })).toBeNull();
    expect(await getBooksCover('audiobookshelf', ABS_ID, 'v', { clients: throwing, cache: new ThumbLruCache() })).toBeNull();
  });

  it('an over-cap body is served but NOT cached (the LRU byte guard holds)', async () => {
    const { clients, calls } = fakeClients({ kavita: () => png(50) });
    const cache = new ThumbLruCache(100, 40); // per-entry cap below the body size
    const result = await getBooksCover('kavita', '1169', 'v1', { clients, cache });
    expect(result?.body.byteLength).toBe(50);
    expect(cache.size).toBe(0);
    await getBooksCover('kavita', '1169', 'v1', { clients, cache });
    expect(calls.kavita).toHaveLength(2); // no memoization for over-cap bodies
  });
});
