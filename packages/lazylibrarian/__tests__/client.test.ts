import { describe, expect, it, vi } from 'vitest';
import { LazyLibrarianHttpError } from '../src/index';
import { LazyLibrarianReadClient } from '../src/read';
import { LazyLibrarianWriteClient } from '../src/write';

const OPTS = { baseUrl: 'http://ll:5299', apiKey: 'secret-key', backoffMs: 1, sleepImpl: async () => {} };

describe('LazyLibrarianReadClient.getBook', () => {
  it('parses the flat, {data}, and array shapes and returns null for an unknown book', async () => {
    const flat = new Response(JSON.stringify({ BookID: 'b1', Status: 'Wanted', AudioStatus: 'Open' }), {
      status: 200,
    });
    const client = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => flat) as unknown as typeof fetch });
    expect(await client.getBook('b1')).toEqual({ bookId: 'b1', ebookStatus: 'Wanted', audioStatus: 'Open' });

    const arr = new Response(JSON.stringify([{ BookID: 'b2', Status: 'Skipped' }]), { status: 200 });
    const c2 = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => arr) as unknown as typeof fetch });
    expect((await c2.getBook('b2'))?.ebookStatus).toBe('Skipped');

    const empty = new Response('null', { status: 200 });
    const c3 = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => empty) as unknown as typeof fetch });
    expect(await c3.getBook('nope')).toBeNull();
  });
});

describe('LazyLibrarianWriteClient', () => {
  it('sends addBook / queueBook / searchBook with cmd + id + type + apikey', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;
    const w = new LazyLibrarianWriteClient({ ...OPTS, fetchImpl });
    await w.addBook('gb-1');
    await w.queueBook('gb-1', 'ebook');
    await w.queueBook('gb-1', 'audiobook');
    await w.searchBook('gb-1', 'audiobook');
    expect(urls[0]).toContain('cmd=addBook');
    expect(urls[0]).toContain('id=gb-1');
    expect(urls[0]).toContain('apikey=secret-key');
    expect(urls[1]).toContain('cmd=queueBook');
    expect(urls[1]).toContain('type=eBook');
    expect(urls[2]).toContain('type=AudioBook');
    expect(urls[3]).toContain('cmd=searchBook');
  });

  it('retries transient 5xx with backoff, then surfaces a REDACTED apikey in errors', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n < 2) return new Response('busy', { status: 503 });
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;
    const w = new LazyLibrarianWriteClient({ ...OPTS, fetchImpl });
    await w.addBook('gb-1');
    expect(n).toBe(2);

    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const w2 = new LazyLibrarianWriteClient({ ...OPTS, fetchImpl: failing, retries: 0 });
    await expect(w2.addBook('gb-1')).rejects.toBeInstanceOf(LazyLibrarianHttpError);
    try {
      await w2.addBook('gb-1');
    } catch (e) {
      expect((e as LazyLibrarianHttpError).url).toContain('apikey=REDACTED');
      expect((e as LazyLibrarianHttpError).url).not.toContain('secret-key');
    }
  });
});
