import { describe, expect, it, vi } from 'vitest';
import { GoogleBooksClient, isComicCategory } from '../src/index';

function volResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ totalItems: items.length, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isComicCategory', () => {
  it('detects the GB comics category', () => {
    expect(isComicCategory(['Comics & Graphic Novels'])).toBe(true);
    expect(isComicCategory(['Comics'])).toBe(true);
    expect(isComicCategory(['Fiction', 'Science Fiction'])).toBe(false);
    expect(isComicCategory(undefined)).toBe(false);
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
});
