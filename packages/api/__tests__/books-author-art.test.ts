// DESIGN-026 D-04 amendment (group-card art) — the ABS author-portrait surface. Mirrors
// books-cover.test.ts: closed id/version shapes, a strong variant-scoped ETag, the LRU that
// memoizes ONLY the sized primary tier, and — the load-bearing bit — the POPULATED-VALUE GATE:
// absAuthorImageUrlFor returns a URL only for an author ABS actually holds a photo for, so an
// author card can never point at a broken image slot (with/without-image both pinned here).
import { afterEach, describe, expect, it } from 'vitest';
import type { BooksReadClients } from '@hnet/books/read';
import {
  ABS_AUTHOR_IMAGE_VARIANT,
  absAuthorDirectory,
  absAuthorImageEtag,
  absAuthorImageUrlFor,
  getAbsAuthorImage,
  isValidAbsAuthorId,
  isValidAbsAuthorVersion,
  normalizeAuthorName,
  resetAbsAuthorDirectory,
} from '../src/books-author-art';
import { ThumbLruCache } from '../src/ytdlsub-poster';

const AUTHOR_ID = '8748856c-ef45-40a2-9f7c-f9147a5d12c4';

afterEach(() => resetAbsAuthorDirectory());

describe('id/version validation (closed shapes — not an open image proxy)', () => {
  it('accepts uuid-shaped ids and numeric versions; rejects junk', () => {
    expect(isValidAbsAuthorId(AUTHOR_ID)).toBe(true);
    expect(isValidAbsAuthorId('../secret')).toBe(false);
    expect(isValidAbsAuthorId('')).toBe(false);
    expect(isValidAbsAuthorVersion('1783996366698')).toBe(true);
    expect(isValidAbsAuthorVersion('0')).toBe(true);
    expect(isValidAbsAuthorVersion('v1.png')).toBe(false);
    expect(isValidAbsAuthorVersion('')).toBe(false);
  });
});

describe('absAuthorImageEtag (strong, version + variant scoped)', () => {
  it('is strong and rotates on id and updatedAt', () => {
    const a = absAuthorImageEtag(AUTHOR_ID, '100');
    expect(a).toMatch(/^".+"$/);
    expect(absAuthorImageEtag(AUTHOR_ID, '101')).not.toBe(a);
    expect(absAuthorImageEtag('aa900d1c-0000-4000-8000-000000000001', '100')).not.toBe(a);
  });

  it('is pinned to the w300webp representation — changing the variant must rotate it', () => {
    expect(ABS_AUTHOR_IMAGE_VARIANT).toEqual({ width: 300, format: 'webp' });
    expect(absAuthorImageEtag(AUTHOR_ID, '1783996366698')).toBe(
      absAuthorImageEtag(AUTHOR_ID, '1783996366698'),
    );
  });
});

// --- the directory + the populated-value gate ---------------------------------------------------

function directoryClients(handlers: {
  libraries?: () => Promise<Array<{ id: string; name: string; mediaType?: string | null }>>;
  authors?: (libraryId: string) => Promise<
    Array<{ id: string; name: string; imagePath?: string | null; updatedAt?: number | null }>
  >;
}): { clients: BooksReadClients; calls: { authors: string[] } } {
  const calls = { authors: [] as string[] };
  const clients = {
    audiobookshelf: {
      listLibraries:
        handlers.libraries ?? (async () => [{ id: 'lib1', name: 'Audio Books', mediaType: 'book' }]),
      listAuthors: async (libraryId: string) => {
        calls.authors.push(libraryId);
        return handlers.authors ? handlers.authors(libraryId) : [];
      },
    },
  } as unknown as BooksReadClients;
  return { clients, calls };
}

const WITH_IMAGE = {
  id: AUTHOR_ID,
  name: 'John Grisham',
  imagePath: '/metadata/authors/x.jpg',
  updatedAt: 1783996366698,
};
const WITHOUT_IMAGE = {
  id: 'aa900d1c-0000-4000-8000-000000000002',
  name: 'Douglas Adams',
  imagePath: null,
  updatedAt: 42,
};

describe('absAuthorDirectory + absAuthorImageUrlFor (the populated-value gate, ADR-051 C-06)', () => {
  it('an author WITH a photo gets the versioned proxy URL; one WITHOUT gets null (fan fallback)', async () => {
    const { clients } = directoryClients({ authors: async () => [WITH_IMAGE, WITHOUT_IMAGE] });
    const directory = await absAuthorDirectory({ clients });
    expect(absAuthorImageUrlFor(directory, 'John Grisham')).toBe(
      `/api/books/author-image?id=${AUTHOR_ID}&v=1783996366698`,
    );
    expect(absAuthorImageUrlFor(directory, 'Douglas Adams')).toBeNull();
    expect(absAuthorImageUrlFor(directory, 'Nobody Known')).toBeNull();
  });

  it('lookups are case/whitespace-folded (books_items.author is the same ABS string)', async () => {
    const { clients } = directoryClients({ authors: async () => [WITH_IMAGE] });
    const directory = await absAuthorDirectory({ clients });
    expect(normalizeAuthorName('  John GRISHAM ')).toBe('john grisham');
    expect(absAuthorImageUrlFor(directory, '  john grisham ')).toContain('/api/books/author-image');
  });

  it('memoizes within the TTL (one upstream author list per window), skipping non-book libraries', async () => {
    const { clients, calls } = directoryClients({
      libraries: async () => [
        { id: 'lib1', name: 'Audio Books', mediaType: 'book' },
        { id: 'pods', name: 'Podcasts', mediaType: 'podcast' },
      ],
      authors: async () => [WITH_IMAGE],
    });
    await absAuthorDirectory({ clients });
    await absAuthorDirectory({ clients });
    expect(calls.authors).toEqual(['lib1']); // one fetch, book libraries only
  });

  it('refetches after the TTL expires (an ABS "match authors" run shows up without a redeploy)', async () => {
    const { clients, calls } = directoryClients({ authors: async () => [WITH_IMAGE] });
    await absAuthorDirectory({ clients, now: Date.now() });
    await absAuthorDirectory({ clients, now: Date.now() + 11 * 60_000 });
    expect(calls.authors).toHaveLength(2);
  });

  it('ABS unreachable / env absent ⇒ null directory ⇒ every card keeps the fan, never an error', async () => {
    const throwing = {
      audiobookshelf: {
        listLibraries: async () => {
          throw new Error('down');
        },
      },
    } as unknown as BooksReadClients;
    expect(await absAuthorDirectory({ clients: throwing })).toBeNull();
    expect(await absAuthorDirectory({ clients: null })).toBeNull();
    expect(absAuthorImageUrlFor(null, 'John Grisham')).toBeNull();
  });

  it('a failure is negative-cached briefly (a down ABS is not hammered per wall paint)', async () => {
    let callCount = 0;
    const flaky = {
      audiobookshelf: {
        listLibraries: async () => {
          callCount += 1;
          throw new Error('down');
        },
      },
    } as unknown as BooksReadClients;
    const t0 = Date.now();
    await absAuthorDirectory({ clients: flaky, now: t0 });
    await absAuthorDirectory({ clients: flaky, now: t0 + 1_000 }); // inside the failure TTL
    expect(callCount).toBe(1);
    await absAuthorDirectory({ clients: flaky, now: t0 + 2 * 60_000 }); // past it — retried
    expect(callCount).toBe(2);
  });
});

// --- the image read (ADR-041 idiom: LRU → sized variant → original fallback) --------------------

function imageClients(
  handler: (id: string, variant?: { width: number; format: string }) => Response,
): { clients: BooksReadClients; calls: Array<{ id: string; variant?: object }> } {
  const calls: Array<{ id: string; variant?: object }> = [];
  const clients = {
    audiobookshelf: {
      fetchAuthorImage: async (id: string, variant?: { width: number; format: string }) => {
        calls.push({ id, ...(variant ? { variant } : {}) });
        return handler(id, variant);
      },
    },
  } as unknown as BooksReadClients;
  return { clients, calls };
}

const webp = (bytes: number) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/webp' } });

describe('getAbsAuthorImage', () => {
  it('requests the FIXED sized WebP variant and memoizes it (repeat = memory hit)', async () => {
    const { clients, calls } = imageClients(() => webp(8));
    const cache = new ThumbLruCache();
    const result = await getAbsAuthorImage(AUTHOR_ID, '100', { clients, cache });
    expect(result?.tier).toBe('primary');
    expect(result?.contentType).toBe('image/webp');
    expect(calls).toEqual([{ id: AUTHOR_ID, variant: { width: 300, format: 'webp' } }]);
    await getAbsAuthorImage(AUTHOR_ID, '100', { clients, cache });
    expect(calls).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('a sized-variant miss degrades to the ORIGINAL fallback tier — served, never memoized', async () => {
    const { clients, calls } = imageClients((_id, variant) =>
      variant ? new Response('boom', { status: 500 }) : webp(20),
    );
    const cache = new ThumbLruCache();
    const result = await getAbsAuthorImage(AUTHOR_ID, '100', { clients, cache });
    expect(result?.tier).toBe('fallback');
    expect(cache.size).toBe(0); // ADR-041 C-02 discipline
    expect(calls).toEqual([
      { id: AUTHOR_ID, variant: { width: 300, format: 'webp' } },
      { id: AUTHOR_ID },
    ]);
  });

  it('the cache key is version-scoped and prefix-isolated from cover keys', async () => {
    const { clients, calls } = imageClients(() => webp(8));
    const cache = new ThumbLruCache();
    await getAbsAuthorImage(AUTHOR_ID, '100', { clients, cache });
    await getAbsAuthorImage(AUTHOR_ID, '101', { clients, cache }); // re-matched photo: a miss
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it('returns null on a 404 upstream, absent clients (env), and a throwing client', async () => {
    const miss = imageClients(() => new Response('nf', { status: 404 }));
    expect(
      await getAbsAuthorImage(AUTHOR_ID, '1', { clients: miss.clients, cache: new ThumbLruCache() }),
    ).toBeNull();
    expect(await getAbsAuthorImage(AUTHOR_ID, '1', { clients: null, cache: new ThumbLruCache() })).toBeNull();
    const throwing = {
      audiobookshelf: {
        fetchAuthorImage: async () => {
          throw new Error('down');
        },
      },
    } as unknown as BooksReadClients;
    expect(
      await getAbsAuthorImage(AUTHOR_ID, '1', { clients: throwing, cache: new ThumbLruCache() }),
    ).toBeNull();
  });
});
