import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LazyLibrarianHttpError } from '../src/index';
import { LazyLibrarianReadClient, sanitizeLlResult } from '../src/read';
import { LazyLibrarianWriteClient } from '../src/write';

const OPTS = { baseUrl: 'http://ll:5299', apiKey: 'secret-key', backoffMs: 1, sleepImpl: async () => {} };

describe('LazyLibrarianReadClient.getAllBookStatuses', () => {
  it('parses the array and {data} shapes into a BookID-keyed map, skipping id-less rows', async () => {
    const rows = [
      { BookID: 'b1', BookName: ' Book One ', Status: 'Wanted', AudioStatus: 'Open', AudioLibrary: '2026-07-11T23:38:10Z' },
      { BookID: 'b2', Status: 'Skipped' },
      { Status: 'Orphan' }, // no BookID — unaddressable, dropped
    ];
    const arr = new Response(JSON.stringify(rows), { status: 200 });
    const client = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => arr) as unknown as typeof fetch });
    const map = await client.getAllBookStatuses();
    expect(map.size).toBe(2);
    // ADR-055 amend (2026-09-22) — the per-format library/file fields ride through for the push guard.
    // ADR-095 / DESIGN-046 D-18 — the title rides through for the queue janitor's fail-loop rows (trimmed).
    expect(map.get('b1')).toEqual({
      bookId: 'b1',
      title: 'Book One',
      ebookStatus: 'Wanted',
      audioStatus: 'Open',
      ebookLibrary: null,
      audioLibrary: '2026-07-11T23:38:10Z',
      ebookFile: null,
      audioFile: null,
    });
    expect(map.get('b2')).toEqual({
      bookId: 'b2',
      title: null,
      ebookStatus: 'Skipped',
      audioStatus: null,
      ebookLibrary: null,
      audioLibrary: null,
      ebookFile: null,
      audioFile: null,
    });

    const wrapped = new Response(JSON.stringify({ data: rows.slice(0, 1) }), { status: 200 });
    const c2 = new LazyLibrarianReadClient({ ...OPTS, fetchImpl: (async () => wrapped) as unknown as typeof fetch });
    expect((await c2.getAllBookStatuses()).size).toBe(1);
  });

  // The 2026-09-22 push guard reads these fields to decide whether LL already holds a format, so their
  // blank spellings matter: LL serves an absent per-format file/library as null, '' or the literal 'None'
  // depending on the row's age, and all three must normalize to null (a `''` would read as "held").
  it('normalizes blank / whitespace / "None" library+file fields to null', async () => {
    const rows = [
      {
        BookID: 'b3',
        Status: 'Wanted',
        AudioStatus: 'Wanted',
        BookLibrary: '',
        AudioLibrary: '   ',
        BookFile: 'None',
        AudioFile: '  /audiobooks/x.m4b  ',
      },
    ];
    const res = new Response(JSON.stringify(rows), { status: 200 });
    const client = new LazyLibrarianReadClient({
      ...OPTS,
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect((await client.getAllBookStatuses()).get('b3')).toEqual({
      bookId: 'b3',
      title: null,
      ebookStatus: 'Wanted',
      audioStatus: 'Wanted',
      ebookLibrary: null,
      audioLibrary: null,
      ebookFile: null,
      audioFile: '/audiobooks/x.m4b', // a real path survives, trimmed
    });
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

// ADR-059 / DESIGN-030 D-11 (issue #615) — the Activity reads. The fixtures are REAL responses captured from
// the live service 2026-09-29 by read-only GETs (indexer apikey zeroed, everything else verbatim).
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const serving = (body: string): typeof fetch => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

describe('LazyLibrarianReadClient.getHistory (cmd=getHistory — the snatch table)', () => {
  it('normalizes real Snatched / Failed / Processed / Seeding rows', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      return new Response(fixture('get-history.json'), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await new LazyLibrarianReadClient({ ...OPTS, fetchImpl }).getHistory();
    expect(urls[0]).toContain('cmd=getHistory');
    expect(rows).toHaveLength(10);

    const stranded = rows.find((r) => r.title.startsWith('Heroes of Olympus'))!;
    expect(stranded).toMatchObject({
      bookId: '-IP5t5CoUcYC',
      status: 'Snatched',
      source: 'sabnzbd', // lowercased
      downloadId: 'f33e9819-747c-4502-b314-c22819174d7c',
      format: 'audiobook', // AuxInfo 'AudioBook'
      dlResult: null,
      snatchedAt: '2026-09-09 09:22:19',
      completedAt: '2026-09-09T13:36:57.000Z', // Completed epoch 1788961017 → ISO
    });

    const torrent = rows.find((r) => r.source === 'qbittorrent' && r.status === 'Snatched')!;
    expect(torrent.completedAt).toBeNull(); // Completed: 0 → unfinished
    expect(torrent.downloadId).toBe('a443a5712c264367d91165bb44bc0416955bb0e4');

    expect(rows.filter((r) => r.status === 'Failed')).toHaveLength(5);
    expect(rows.find((r) => r.status === 'Processed')).toMatchObject({ format: 'ebook', source: 'direct' });
    expect(rows.find((r) => r.status === 'Seeding')).toMatchObject({ source: 'qbittorrent' });
    // NZBurl (which embeds the indexer apikey) is never surfaced.
    expect(JSON.stringify(rows)).not.toMatch(/NZBurl|apikey/i);
  });

  it('strips the anchor markup and the apikey from a real Failed DLResult', async () => {
    const rows = await new LazyLibrarianReadClient({ ...OPTS, fetchImpl: serving(fixture('get-history.json')) }).getHistory();
    const failed = rows.find((r) => r.dlResult?.startsWith('Failed to send nzb'))!;
    expect(failed.dlResult).toBe('Failed to send nzb to @ SABNZBD');
  });

  // ADR-095 / DESIGN-046 D-18 — the queue janitor checks a Processed row's recorded destination on disk, so it gets
  // the RAW path (the sanitized dlResult collapses whitespace and cuts long values); never a failure text.
  it('carries the raw recorded destination of a Processed / Seeding row only', async () => {
    const path = '/data/cephfs-hdd/data/media/books/AudioBooks/A  B/Title/01  Title.mp3';
    const rows = await new LazyLibrarianReadClient({
      ...OPTS,
      fetchImpl: serving(
        JSON.stringify([
          { BookID: 'p', Status: 'Processed', DLResult: `  ${path}  ` },
          { BookID: 's', Status: 'Seeding', DLResult: '/data/cephfs-hdd/data/media/books/EBooks/x.epub' },
          { BookID: 'f', Status: 'Failed', DLResult: '/data/whatever' },
          { BookID: 'q', Status: 'Processed', DLResult: 'not a path' },
        ]),
      ),
    }).getHistory();
    expect(rows.map((r) => [r.bookId, r.destination])).toEqual([
      ['p', path],
      ['s', '/data/cephfs-hdd/data/media/books/EBooks/x.epub'],
      ['f', null],
      ['q', null],
    ]);
  });

  it('tolerates the {data} wrapper, drops id-less rows, and reads an error string as empty', async () => {
    const wrapped = JSON.stringify({ data: [{ BookID: 7, Status: 'Snatched', Completed: '1788961017' }, { Status: 'Failed' }] });
    const rows = await new LazyLibrarianReadClient({ ...OPTS, fetchImpl: serving(wrapped) }).getHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookId: '7', status: 'Snatched', completedAt: '2026-09-09T13:36:57.000Z' });
    expect(await new LazyLibrarianReadClient({ ...OPTS, fetchImpl: serving('"Unknown command"') }).getHistory()).toEqual([]);
  });
});

describe('LazyLibrarianReadClient.getWanted (cmd=getWanted — the wanted BOOK list)', () => {
  it('normalizes real book rows (not grab rows)', async () => {
    const rows = await new LazyLibrarianReadClient({ ...OPTS, fetchImpl: serving(fixture('get-wanted.json')) }).getWanted();
    expect(rows).toEqual([
      { bookId: 'cMwAEAAAQBAJ', title: 'Kingdom of Ash', ebookStatus: 'Wanted', audioStatus: 'Open', addedAt: '2026-07-12T00:00:00Z' },
      { bookId: 'AQk_EAAAQBAJ', title: 'Dune (Movie Tie-In)', ebookStatus: 'Wanted', audioStatus: 'Skipped', addedAt: expect.any(String) },
      { bookId: '7O9P486Lcb8C', title: 'Wild Cards II. Aces High', ebookStatus: 'Wanted', audioStatus: 'Wanted', addedAt: '2026-07-13T00:00:00Z' },
    ]);
  });
});

describe('sanitizeLlResult', () => {
  it('strips markup, redacts key-shaped params, collapses whitespace and bounds the length', () => {
    expect(sanitizeLlResult('sent to <a href="http://p/dl?apikey=abc123&link=zz">SAB</a>  now')).toBe('sent to SAB now');
    expect(sanitizeLlResult('GET http://p/dl?apikey=abc123&file=x failed')).toBe('GET http://p/dl?apikey=REDACTED&file=x failed');
    expect(sanitizeLlResult('   ')).toBeNull();
    expect(sanitizeLlResult(null)).toBeNull();
    expect(sanitizeLlResult('x'.repeat(500))).toHaveLength(300);
  });
});
