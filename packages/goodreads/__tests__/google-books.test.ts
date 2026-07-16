import { describe, expect, it, vi } from 'vitest';
import { GoogleBooksClient, classifyComic, isComicCategory, isComicText } from '../src/index';

function volResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ totalItems: items.length, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function volumeResponse(volume: unknown): Response {
  return new Response(JSON.stringify(volume), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isComicCategory', () => {
  it('detects the GB comics category', () => {
    expect(isComicCategory(['Comics & Graphic Novels'])).toBe(true);
    expect(isComicCategory(['Comics'])).toBe(true);
    // The /volumes GET returns suffixed BISAC forms — still a comic (the Scott Pilgrim full-record shape).
    expect(isComicCategory(['Comics & Graphic Novels / Literary'])).toBe(true);
    expect(isComicCategory(['Fiction', 'Science Fiction'])).toBe(false);
    expect(isComicCategory(undefined)).toBe(false);
  });
});

describe('isComicText (PLAN-044 live-leak fix — signals GB categories miss)', () => {
  it('detects a comic publisher / imprint / format marker in shelved text', () => {
    // The Batman leak: GB resolved a category-less volume; the shelved title carries "DC Comics".
    expect(isComicText('Zero Year: Part 1 (DC Comics - The Legend of Batman #1)')).toBe(true);
    expect(isComicText('Saga, Volume 1', 'Brian K. Vaughan', 'Image Comics')).toBe(true);
    expect(isComicText('Watchmen (graphic novel)')).toBe(true);
    expect(isComicText('Berserk, Vol. 1', null, 'Dark Horse Comics')).toBe(true);
  });

  it('does not false-positive on prose novels', () => {
    expect(isComicText('Dune (Dune, #1)', 'Frank Herbert')).toBe(false);
    expect(isComicText('Project Hail Mary', 'Andy Weir')).toBe(false);
    expect(isComicText('Hooked: How to Build Habit-Forming Products', 'Nir Eyal')).toBe(false);
    expect(isComicText(null, undefined)).toBe(false);
  });

  it('classifyComic unions the category + text signals', () => {
    expect(classifyComic({ categories: ['Fiction'], title: 'Batman: Year One (DC Comics)' })).toBe(true);
    expect(classifyComic({ categories: ['Comics & Graphic Novels'], title: 'anything' })).toBe(true);
    expect(classifyComic({ categories: ['Fiction'], title: 'Dune', author: 'Frank Herbert' })).toBe(false);
  });
});

describe('GoogleBooksClient.resolveVolume', () => {
  it('resolves by ISBN first and flags comics', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('isbn')) {
        return volResponse([
          {
            id: 'gb-sp',
            volumeInfo: {
              title: 'Scott Pilgrim',
              categories: ['Comics & Graphic Novels'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781932664089' }],
            },
          },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ isbn: '9781932664089', title: 'Scott Pilgrim' });
    expect(res).toEqual({
      volumeId: 'gb-sp',
      isbn13: '9781932664089',
      categories: ['Comics & Graphic Novels'],
      isComic: true,
    });
  });

  it('falls back to a title+author query when no ISBN', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        return volResponse([{ id: 'gb-x', volumeInfo: { title: 'X', categories: ['Fiction'] } }]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ title: 'X', author: 'Y' });
    expect(res?.volumeId).toBe('gb-x');
    expect(res?.isComic).toBe(false);
  });

  it('retries transient 503s with backoff (mandatory GB retry/backoff)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response('backendFailed', { status: 503 });
      return volResponse([{ id: 'gb-ok', volumeInfo: {} }]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'Z' });
    expect(res?.volumeId).toBe('gb-ok');
    expect(calls).toBe(3);
  });

  // ADR-067 (PLAN-055) — a DAILY-quota 429 cannot succeed before the reset: retrying it is
  // pointless by definition, so it throws IMMEDIATELY (one call, body preserved for the
  // domain-side breaker classification). A per-minute 429 keeps the backoff loop above.
  it('does NOT retry a daily-quota 429 (throws immediately with the body snippet)', async () => {
    let calls = 0;
    const dailyBody = `Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com'`;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(dailyBody, { status: 429 });
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    await expect(gb.resolveVolume({ isbn: '123', title: 'Z' })).rejects.toMatchObject({
      status: 429,
      bodySnippet: expect.stringContaining('Queries per day') as unknown,
    });
    expect(calls).toBe(1);
  });

  it('still retries a PER-MINUTE 429 with backoff (transient burst quota)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response(`limit 'Queries per minute' exceeded`, { status: 429 });
      return volResponse([{ id: 'gb-ok', volumeInfo: {} }]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'Z' });
    expect(res?.volumeId).toBe('gb-ok');
    expect(calls).toBe(2);
  });

  // Regression — PLAN-044 v0.49.0 live acceptance leaked BOTH of the owner's comics into LazyLibrarian.
  it('flags a comic from a "DC Comics" title marker when the resolved GB volume has NO categories', async () => {
    // The Batman Zero Year leak: the intitle match was a sparse Eaglemoss catalog volume with no categories.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        return volResponse([
          { id: 'gb-batman', volumeInfo: { title: 'Zero Year', publisher: 'Eaglemoss Collections' } },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      title: 'Zero Year: Part 1 (DC Comics - The Legend of Batman #1)',
      author: 'Scott Snyder',
    });
    expect(res?.volumeId).toBe('gb-batman');
    expect(res?.isComic).toBe(true);
  });

  it('confirms a comic via the full-volume GET when the search category is truncated to "Fiction"', async () => {
    // The Scott Pilgrim leak: `isbn:` search returned ["Fiction"]; the /volumes GET carries the full BISAC.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/volumes/gb-sp2')) {
        return volumeResponse({
          id: 'gb-sp2',
          volumeInfo: {
            title: 'Scott Pilgrim’s Precious Little Life: Volume 1',
            publisher: 'HarperCollins UK',
            categories: ['Fiction / Humorous / General', 'Comics & Graphic Novels / Literary'],
          },
        });
      }
      if (url.includes('isbn')) {
        return volResponse([
          {
            id: 'gb-sp2',
            volumeInfo: {
              title: 'Scott Pilgrim',
              categories: ['Fiction'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780007362998' }],
            },
          },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      isbn: '9780007362998',
      title: "Scott Pilgrim's Precious Little Life (Scott Pilgrim, #1)",
      author: "Bryan Lee O'Malley",
    });
    expect(res?.volumeId).toBe('gb-sp2');
    expect(res?.isComic).toBe(true);
    expect(res?.categories).toContain('Comics & Graphic Novels / Literary');
  });
});
