import { describe, expect, it, vi } from 'vitest';
import { LazyLibrarianHttpError } from '../src/index';
import { LazyLibrarianReadClient } from '../src/read';
import { LazyLibrarianWriteClient } from '../src/write';

const OPTS = { baseUrl: 'http://ll:5299', apiKey: 'secret-key', backoffMs: 1, sleepImpl: async () => {} };

describe('LazyLibrarianReadClient.getAllBookStatuses', () => {
  it('parses the array and {data} shapes into a BookID-keyed map, skipping id-less rows', async () => {
    const rows = [
      { BookID: 'b1', Status: 'Wanted', AudioStatus: 'Open' },
      { BookID: 'b2', Status: 'Skipped' },
      { Status: 'Orphan' }, // no BookID — unaddressable, dropped
    ];
    const arr = new Response(JSON.stringify(rows), { status: 200 });
    const client = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => arr) as unknown as typeof fetch });
    const map = await client.getAllBookStatuses();
    expect(map.size).toBe(2);
    expect(map.get('b1')).toEqual({ bookId: 'b1', ebookStatus: 'Wanted', audioStatus: 'Open' });
    expect(map.get('b2')).toEqual({ bookId: 'b2', ebookStatus: 'Skipped', audioStatus: null });

    const wrapped = new Response(JSON.stringify({ data: rows.slice(0, 1) }), { status: 200 });
    const c2 = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => wrapped) as unknown as typeof fetch });
    expect((await c2.getAllBookStatuses()).size).toBe(1);
  });

  it('returns an empty map on the unknown-command error shape (the real-build getBook lesson)', async () => {
    const err = new Response(
      JSON.stringify({ Success: false, Data: '', Error: { Code: 405, Message: 'Unknown command' } }),
      { status: 200 },
    );
    const client = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => err) as unknown as typeof fetch });
    expect((await client.getAllBookStatuses()).size).toBe(0);
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
