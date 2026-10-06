// DESIGN-028 amendment 2026-10-06 — the Books Census (issues #744 and #781). The file readers on files built here byte
// by byte (EPUB, MOBI, ID3 v2.3 and v2.4, MP4); the language guess; the census on the live shapes of #781 and the first
// live pass; Census Holds; a whole pass over a real SQLite file and real files, and the app reads on the embedded
// Postgres 16 through a read-only session.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBooksCensus, type CensusLlBook } from '../src/books-census/census';
import { readFileMeta, type FileMeta } from '../src/books-census/file-meta';
import { matchHold, parseHolds, type CensusHold } from '../src/books-census/holds';
import { classifyDeclaredLanguage, guessTextLanguage } from '../src/books-census/language';
import { runCensusPass } from '../src/books-census/run';
import type { SyncLogger } from '../src/logger';
import { parseBooksCensusArgs } from '../src/scripts/books-census';
import { syncBooks } from '@hnet/domain';
import { bootMigratedDb, type TestDb } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------------------------------------------------

/** A zip with the given entries; `deflate` names the entries stored compressed (method 8). CRCs are not checked. */
function zip(entries: Record<string, string>, deflate: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const method = deflate.includes(name) ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const ENGLISH =
  'It was the best of times and it was the worst of times. He said that they had been there when she came, and that ' +
  'the house would be theirs for the winter. They were not sure what it was, but it was there, and it was waiting for ' +
  'them with all the patience of the sea. ';
const GERMAN =
  'Es war einmal ein König, der hatte eine Tochter, und sie war schön. Er ist nicht hier, und ich weiß nicht, wie es ' +
  'dem Mann auf dem Berg geht, aber sie wird auch noch kommen, wenn der Winter vorbei ist. Das ist nur eine Geschichte. ';

function epub(opts: { title: string; language?: string; series?: string; text?: string }): Buffer {
  const meta = [
    `<dc:title>${opts.title}</dc:title>`,
    opts.language ? `<dc:language>${opts.language}</dc:language>` : '',
    opts.series ? `<meta name="calibre:series" content="${opts.series}"/>` : '',
  ].join('');
  const opf =
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta}</metadata>` +
    '<manifest><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/ch%202.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>';
  const page = (body: string) =>
    `<html><head><style>p{}</style></head><body><p>${body}</p></body></html>`;
  return zip(
    {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml':
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'OEBPS/content.opf': opf,
      'OEBPS/Text/ch1.xhtml': page((opts.text ?? ENGLISH).repeat(3)),
      'OEBPS/Text/ch 2.xhtml': page((opts.text ?? ENGLISH).repeat(3)),
    },
    ['OEBPS/content.opf', 'OEBPS/Text/ch1.xhtml'],
  );
}

function mobi(opts: {
  fullName: string;
  exthTitle?: string;
  exthLanguage?: string;
  locale?: number;
}): Buffer {
  const exthRecords: Buffer[] = [];
  const rec = (type: number, value: string) => {
    const v = Buffer.from(value, 'utf8');
    const b = Buffer.alloc(8);
    b.writeUInt32BE(type, 0);
    b.writeUInt32BE(8 + v.length, 4);
    exthRecords.push(b, v);
  };
  if (opts.exthTitle) rec(503, opts.exthTitle);
  if (opts.exthLanguage) rec(524, opts.exthLanguage);
  const exthBody = Buffer.concat(exthRecords);
  const exth = Buffer.alloc(12);
  exth.write('EXTH', 0, 'latin1');
  exth.writeUInt32BE(12 + exthBody.length, 4);
  exth.writeUInt32BE(exthRecords.length / 2, 8);
  const mobiLength = 232;
  const record0 = Buffer.alloc(16 + mobiLength);
  record0.write('MOBI', 16, 'latin1');
  record0.writeUInt32BE(mobiLength, 20);
  record0.writeUInt32BE(65001, 28);
  const name = Buffer.from(opts.fullName, 'utf8');
  const nameOffset = 16 + mobiLength + 12 + exthBody.length;
  record0.writeUInt32BE(nameOffset, 84);
  record0.writeUInt32BE(name.length, 88);
  record0.writeUInt32BE(opts.locale ?? 9, 92);
  record0.writeUInt32BE(0x40, 128);
  const body = Buffer.concat([record0, exth, exthBody, name, Buffer.alloc(8)]);
  const header = Buffer.alloc(78 + 16);
  header.write('BOOKMOBI', 60, 'latin1');
  header.writeUInt16BE(2, 76);
  header.writeUInt32BE(94, 78);
  header.writeUInt32BE(94 + body.length, 86);
  return Buffer.concat([header, body, Buffer.from('text record')]);
}

function id3(version: 3 | 4, frames: [string, Buffer][]): Buffer {
  const syncsafe = (n: number) =>
    Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  const body = Buffer.concat(
    frames.map(([id, data]) => {
      const h = Buffer.alloc(10);
      h.write(id, 0, 'latin1');
      if (version === 4) syncsafe(data.length).copy(h, 4);
      else h.writeUInt32BE(data.length, 4);
      return Buffer.concat([h, data]);
    }),
  );
  const head = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, 0]),
    syncsafe(body.length + 64),
  ]);
  return Buffer.concat([head, body, Buffer.alloc(64), Buffer.from('audio frames')]);
}
const latin1Text = (s: string) => Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
const utf16Text = (s: string) =>
  Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf8Text = (s: string) =>
  Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8'), Buffer.from([0])]);

function atom(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
function mp4(album: string, name: string): Buffer {
  const data = (s: string) =>
    atom('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(s, 'utf8'));
  const ilst = atom('ilst', atom('©nam', data(name)), atom('©alb', data(album)));
  const meta = atom('meta', Buffer.alloc(4), atom('hdlr', Buffer.alloc(25)), ilst);
  return Buffer.concat([
    atom('ftyp', Buffer.from('M4B ')),
    atom('mdat', Buffer.alloc(4096)),
    atom('moov', atom('mvhd', Buffer.alloc(100)), atom('udta', meta)),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'books-census-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, data: Buffer | string): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
  return path;
};

describe('readFileMeta', () => {
  it('reads an EPUB: title (entities), language, series and a text sample, stored and deflated entries', async () => {
    const meta = await readFileMeta(
      put(
        'a/Four. The Traitor - Veronica Roth.epub',
        epub({
          title: 'Four Divergent Stories: The Transfer &amp; More',
          language: 'en',
          series: 'Divergent',
        }),
      ),
    );
    expect(meta).toMatchObject({
      status: 'read',
      title: 'Four Divergent Stories: The Transfer & More',
      language: 'en',
      series: 'Divergent',
    });
    expect(meta.textSample?.split(' ').length).toBeGreaterThan(100);
    expect(meta.textSample).not.toContain('<');
  });
  it('reads a MOBI / AZW3: the EXTH title and language, else the full name and the locale', async () => {
    expect(
      await readFileMeta(
        put(
          'b/x.azw3',
          mobi({
            fullName: 'Hugh Howey - Sand',
            exthTitle: 'The Best American Science Fiction and Fantasy 2024',
            exthLanguage: 'en',
          }),
        ),
      ),
    ).toMatchObject({
      status: 'read',
      title: 'The Best American Science Fiction and Fantasy 2024',
      language: 'en',
      altTitles: ['Hugh Howey - Sand'],
    });
    expect(
      await readFileMeta(put('b/y.mobi', mobi({ fullName: 'Der Schattenjäger-Codex', locale: 7 }))),
    ).toMatchObject({
      title: 'Der Schattenjäger-Codex',
      language: 'de',
    });
  });
  it('reads ID3 v2.3 (Latin-1, UTF-16 with a BOM, a frame it skips) and v2.4 (syncsafe, UTF-8)', async () => {
    const v3 = id3(3, [
      ['APIC', Buffer.alloc(5000, 7)],
      ['TALB', latin1Text('Shadowhunter Academy')],
      ['TIT2', utf16Text('07 Bitter of Tongue')],
      ['TLAN', latin1Text('eng')],
    ]);
    expect(await readFileMeta(put('c/Cassandra Clare - Bitter of Tongue.mp3', v3))).toMatchObject({
      status: 'read',
      title: 'Shadowhunter Academy',
      altTitles: ['07 Bitter of Tongue'],
      language: 'eng',
    });
    const v4 = id3(4, [
      ['TALB', utf8Text("Winter's Heart")],
      ['TIT2', utf8Text('01: High Chasaline')],
    ]);
    expect(await readFileMeta(put('c/A Crown of Swords 01.mp3', v4))).toMatchObject({
      title: "Winter's Heart",
      altTitles: ['01: High Chasaline'],
      language: null,
    });
  });
  it('reads an MP4 / M4B: walks past mdat to moov and reads ©alb and ©nam', async () => {
    expect(
      await readFileMeta(put('d/Kingdom of Ash.m4b', mp4('Throne of Glass', 'Kingdom of Ash'))),
    ).toMatchObject({
      status: 'read',
      title: 'Throne of Glass',
      altTitles: ['Kingdom of Ash'],
    });
  });
  it('a missing file, a PDF and a broken EPUB', async () => {
    expect((await readFileMeta(join(dir, 'nope/none.epub'))).status).toBe('missing');
    expect((await readFileMeta(put('e/x.pdf', '%PDF-1.4'))).status).toBe('unsupported');
    const broken = await readFileMeta(put('e/x.epub', 'not a zip at all'));
    expect(broken.status).toBe('unreadable');
    expect(broken.error).toMatch(/zip/);
  });
});

describe('the language guess', () => {
  it('reads English, German and a non-Latin script; a short sample says nothing', () => {
    expect(guessTextLanguage(ENGLISH.repeat(3)).language).toBe('en');
    expect(guessTextLanguage(GERMAN.repeat(4)).language).toBe('de');
    expect(
      guessTextLanguage('בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ '.repeat(20))
        .language,
    ).toBe('script');
    expect(guessTextLanguage('The end.').language).toBeNull();
  });
  it('classes a declared language like the library tags', () => {
    expect(classifyDeclaredLanguage('eng')).toBe('english');
    expect(classifyDeclaredLanguage('en-GB')).toBe('english');
    expect(classifyDeclaredLanguage('ger')).toBe('foreign');
    expect(classifyDeclaredLanguage('und')).toBe('unknown');
    expect(classifyDeclaredLanguage('mul')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The census on fakes
// ---------------------------------------------------------------------------------------------------------------------

const ROOT = '/data/cephfs-hdd/data/media/books';
const E = `${ROOT}/EBooks`;
const A = `${ROOT}/AudioBooks`;
const read = (title: string | null, extra: Partial<FileMeta> = {}): FileMeta => ({
  status: 'read',
  title,
  altTitles: [],
  language: null,
  series: null,
  textSample: null,
  ...extra,
});
const ll = (row: Partial<CensusLlBook> & { BookID: string; BookName: string }): CensusLlBook => ({
  BookSub: null,
  BookLang: 'en',
  Status: 'Open',
  AudioStatus: 'Skipped',
  BookFile: null,
  AudioFile: null,
  AuthorName: 'Veronica Roth',
  ...row,
});

const SNAPSHOT: CensusLlBook[] = [
  ll({
    BookID: 'RZZRAQAAQBAJ',
    BookName: 'Four. The Traitor',
    BookFile: `${E}/Veronica Roth/Four. The Traitor/Four. The Traitor - Veronica Roth.epub`,
  }),
  ll({
    BookID: 'Qw30DwAAQBAJ',
    BookName: 'Shift',
    AuthorName: 'Hugh Howey',
    BookFile: `${E}/Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub`,
  }),
  ll({
    BookID: 'TYETAQAAQBAJ',
    BookName: 'The Traitor. A Divergent Story',
    BookFile: `${E}/Veronica Roth/The Traitor/Veronica Roth - The Traitor.epub`,
  }),
  ll({
    BookID: 'bitter',
    BookName: 'Bitter of Tongue',
    AuthorName: 'Cassandra Clare',
    Status: 'Skipped',
    AudioStatus: 'Open',
    AudioFile: `${A}/Cassandra Clare/Bitter of Tongue/Cassandra Clare - Bitter of Tongue.mp3`,
  }),
  ll({
    BookID: 'crown',
    BookName: 'A Crown of Swords',
    AuthorName: 'Robert Jordan',
    Status: 'Skipped',
    AudioStatus: 'Open',
    AudioFile: `${A}/Robert Jordan/A Crown of Swords/A Crown of Swords 01.mp3`,
  }),
  ll({
    BookID: 'divergent',
    BookName: 'Divergent',
    BookFile: `${E}/Veronica Roth/Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.pdf`,
  }),
  ll({
    BookID: 'catwings',
    BookName: 'Wonderful Alexander and the Catwings',
    AuthorName: 'Ursula K. Le Guin',
    Status: 'Skipped',
    AudioStatus: 'Open',
    AudioFile: `${A}/Ursula K. Le Guin/Catwings/Part 1 of 5.mp3`,
  }),
  ll({
    BookID: 'dead-or-alive',
    BookName: 'Dead or Alive',
    AuthorName: 'Tom Clancy',
    BookFile: `${E}/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.epub`,
  }),
  ll({
    BookID: 'grey',
    BookName: 'Grey',
    AuthorName: 'E.L. James',
    BookLang: 'de',
    AudioStatus: 'Open',
    BookFile: `${E}/E.L. James/Grey/Grey - E.L. James.mobi`,
    AudioFile: `${A}/E.L. James/Grey/01 Grey - Part 01.mp3`,
  }),
  ll({
    BookID: 'got',
    BookName: 'Game of Thrones',
    AuthorName: 'George R.R. Martin',
    BookLang: 'fr',
    Status: 'Skipped',
    AudioStatus: 'Open',
    AudioFile: `${A}/George R.R. Martin/Game of Thrones/Part 01 of 75.mp3`,
  }),
  ll({
    BookID: 'crescent-it',
    BookName: 'Crescent City - La casa di terra e sangue',
    AuthorName: 'Sarah J. Maas',
    BookLang: 'it',
    Status: 'Wanted',
  }),
  ll({
    BookID: 'azazel-es',
    BookName: 'Azazel',
    AuthorName: 'Boris Akunin',
    BookLang: 'es',
    Status: 'Skipped',
  }),
];
const METAS: Record<string, FileMeta> = {
  [`${E}/Veronica Roth/Four. The Traitor/Four. The Traitor - Veronica Roth.epub`]: read(
    'Four Divergent Stories: The Transfer, The Initiate, The Son, and The Traitor (Divergent Series)',
    { language: 'en', textSample: ENGLISH.repeat(3) },
  ),
  [`${E}/Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub`]: read(
    'First Shift - Legacy',
    { series: 'Wool' },
  ),
  [`${E}/Veronica Roth/The Traitor/Veronica Roth - The Traitor.epub`]: read(
    'Four: The Traitor (Kindle Single) (Divergent Trilogy Book 4)',
  ),
  [`${A}/Cassandra Clare/Bitter of Tongue/Cassandra Clare - Bitter of Tongue.mp3`]: read(
    'Shadowhunter Academy',
    { altTitles: ['07 Bitter of Tongue'] },
  ),
  [`${A}/Robert Jordan/A Crown of Swords/A Crown of Swords 01.mp3`]: read("Winter's Heart", {
    altTitles: ['01: High Chasaline'],
  }),
  [`${E}/Veronica Roth/Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.pdf`]:
    { ...read(null), status: 'unsupported' },
  [`${E}/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.epub`]: read('Dead or Alive', {
    language: 'en',
    textSample: GERMAN.repeat(4),
  }),
  [`${E}/E.L. James/Grey/Grey - E.L. James.mobi`]: read('Grey', { language: 'en' }),
  [`${A}/E.L. James/Grey/01 Grey - Part 01.mp3`]: read(
    'Grey • Fifty Shades of Grey as Told by Christian',
  ),
  [`${A}/George R.R. Martin/Game of Thrones/Part 01 of 75.mp3`]: read('A Game of Thrones'),
};
const fakeRead = async (path: string): Promise<FileMeta> =>
  METAS[path] ?? { ...read(null), status: 'missing' };
const WANTS = [
  {
    id: '76848581-bc78',
    origin: 'collection',
    ll_book_id: 'crescent-it',
    ebook_status: 'requested',
    audio_status: 'landed',
    unroutable_reason: null,
  },
  {
    id: 'aaaaaaaa-park',
    origin: 'pairing',
    ll_book_id: 'azazel-es',
    ebook_status: 'requested',
    audio_status: 'landed',
    unroutable_reason: 'no_english_edition',
  },
  {
    id: '1912c0f3-shif',
    origin: 'pairing',
    ll_book_id: 'Qw30DwAAQBAJ',
    ebook_status: 'landed',
    audio_status: 'landed',
    unroutable_reason: null,
  },
];
const ITEMS = [
  {
    source: 'kavita',
    external_id: '18',
    title: 'De Silmarillion',
    author: 'J.R.R. Tolkien',
    language: 'nl',
  },
  {
    source: 'kavita',
    external_id: '19',
    title: 'The Silmarillion',
    author: 'J.R.R. Tolkien',
    language: 'en-US',
  },
  {
    source: 'audiobookshelf',
    external_id: 'u-1',
    title: 'Shift',
    author: 'Hugh Howey',
    language: 'English',
  },
  {
    source: 'audiobookshelf',
    external_id: 'u-2',
    title: 'Der Ritt',
    author: null,
    language: 'German',
  },
];
const NOW = new Date('2026-10-07T10:15:00Z');

describe('runBooksCensus', () => {
  it('finds the #781 wrong files, by content and by name, and leaves the right ones alone', async () => {
    const { findings, summary } = await runBooksCensus({
      llBooks: SNAPSHOT,
      wants: WANTS,
      items: ITEMS,
      holds: [],
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    const wrong = findings.filter((f) => f.kind === 'wrong_file');
    expect(wrong.map((f) => [f.llBookId, f.format, f.basis])).toEqual([
      ['RZZRAQAAQBAJ', 'ebook', 'content'],
      ['Qw30DwAAQBAJ', 'ebook', 'content'],
      ['crown', 'audiobook', 'content'],
      ['divergent', 'ebook', 'name'],
    ]);
    expect(wrong[1]).toMatchObject({
      path: 'EBooks/Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub',
      fileTitle: 'First Shift - Legacy',
      wants: ['1912c0f3'],
      held: false,
    });
    expect(summary).toMatchObject({ wrongFile: 4, unsupported: 1, judgedName: 1 });
  });
  it('a stale pointer is a missing file', async () => {
    const { findings } = await runBooksCensus({
      llBooks: SNAPSHOT,
      wants: [],
      items: [],
      holds: [],
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === 'missing_file')).toEqual([
      expect.objectContaining({ llBookId: 'catwings', format: 'audiobook', llStatus: 'open' }),
    ]);
  });
  it('F10: a German text under an English label; a label-only audiobook only when no file of its book reads English', async () => {
    const { findings, summary } = await runBooksCensus({
      llBooks: SNAPSHOT,
      wants: WANTS,
      items: ITEMS,
      holds: [],
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    const foreign = findings.filter((f) => f.kind === 'foreign_held');
    expect(foreign.map((f) => [f.llBookId, f.format, f.language])).toEqual([
      ['dead-or-alive', 'ebook', 'de'],
      ['got', 'audiobook', 'fr'],
    ]);
    expect(foreign[0]!.signals).toEqual({ label: 'en', declared: 'en', text: 'de' });
    expect(summary.foreignHeld).toBe(2);
  });
  it('F10: a foreign book LazyLibrarian wants, with the unparked wants on it; a parked want is not one', async () => {
    const { findings } = await runBooksCensus({
      llBooks: SNAPSHOT,
      wants: WANTS,
      items: ITEMS,
      holds: [],
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === 'foreign_wanted')).toEqual([
      expect.objectContaining({
        llBookId: 'crescent-it',
        language: 'it',
        llWanted: ['ebook'],
        wants: ['76848581'],
      }),
    ]);
  });
  it('F10: library items tagged non-English, counted per library', async () => {
    const { findings, summary } = await runBooksCensus({
      llBooks: [],
      wants: [],
      items: ITEMS,
      holds: [],
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    expect(findings.map((f) => f.key)).toEqual([
      'foreign_item:kavita:18',
      'foreign_item:audiobookshelf:u-2',
    ]);
    expect(summary.foreignItemsBySource).toEqual({ kavita: 1, audiobookshelf: 1 });
  });
  it('a Census Hold covers its finding (same file, not expired) and is reported when it matched nothing', async () => {
    const holds: CensusHold[] = [
      {
        key: 'wrong_file:crown:audiobook',
        path: 'AudioBooks/Robert Jordan/A Crown of Swords/A Crown of Swords 01.mp3',
        title: 'A Crown of Swords',
        reason: 'checked',
        opened: '2026-10-07',
      },
      {
        key: 'wrong_file:divergent:ebook',
        path: 'EBooks/elsewhere.pdf',
        title: 'Divergent',
        reason: 'another file',
        opened: '2026-10-07',
      },
      {
        key: 'foreign_wanted:crescent-it',
        title: 'Crescent City',
        reason: 'lapsed',
        opened: '2026-10-01',
        until: '2026-10-06',
      },
      { key: 'foreign_item:kavita:999', title: 'gone', reason: 'gone', opened: '2026-10-01' },
    ];
    const { findings, summary } = await runBooksCensus({
      llBooks: SNAPSHOT,
      wants: WANTS,
      items: ITEMS,
      holds,
      readMeta: fakeRead,
      booksRoot: ROOT,
      now: NOW,
    });
    const byKey = (k: string) => findings.find((f) => f.key === k)!;
    expect(byKey('wrong_file:crown:audiobook')).toMatchObject({
      held: true,
      holdReason: 'checked',
    });
    expect(byKey('wrong_file:divergent:ebook').held).toBe(false);
    expect(byKey('foreign_wanted:crescent-it').held).toBe(false);
    expect(summary.held.wrong_file).toBe(1);
    expect(summary.wrongFile).toBe(3);
    expect(summary.unusedHolds).toEqual([
      'wrong_file:divergent:ebook',
      'foreign_wanted:crescent-it',
      'foreign_item:kavita:999',
    ]);
  });
});

describe('Census Holds', () => {
  it('the repo file parses', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(
      new URL('../../../.agents/books-census-holds.yaml', import.meta.url),
      'utf8',
    );
    expect(Array.isArray(parseHolds(text))).toBe(true);
  });
  it('refuses a bad key, a missing reason and a duplicate', () => {
    expect(() =>
      parseHolds(
        'version: 1\nholds:\n  - {key: "wrong_file:x", title: t, reason: r, opened: 2026-10-07}',
      ),
    ).toThrow(/key/);
    expect(() =>
      parseHolds('version: 1\nholds:\n  - {key: "foreign_wanted:x", title: t, opened: 2026-10-07}'),
    ).toThrow(/reason/);
    const dup = '  - {key: "foreign_wanted:x", title: t, reason: r, opened: "2026-10-07"}\n';
    expect(() => parseHolds(`version: 1\nholds:\n${dup}${dup}`)).toThrow(/duplicate/);
  });
  it('a hold lapses after its until day', () => {
    const hold: CensusHold = {
      key: 'foreign_wanted:x',
      title: 't',
      reason: 'r',
      opened: '2026-10-01',
      until: '2026-10-07',
    };
    expect(matchHold([hold], 'foreign_wanted:x', undefined, new Date('2026-10-07T23:00:00Z'))).toBe(
      hold,
    );
    expect(
      matchHold([hold], 'foreign_wanted:x', undefined, new Date('2026-10-08T00:00:00Z')),
    ).toBeNull();
  });
});

describe('parseBooksCensusArgs', () => {
  it('defaults to the env URL and the app database', () => {
    expect(parseBooksCensusArgs([], { BOOKS_CENSUS_HOLDS_URL: 'https://x/h.yaml' })).toEqual({
      holds: 'https://x/h.yaml',
      appDb: true,
    });
    expect(parseBooksCensusArgs(['--no-app-db', '--holds=./h.yaml'], {})).toEqual({
      holds: './h.yaml',
      appDb: false,
    });
    expect(() => parseBooksCensusArgs(['--bogus'], {})).toThrow(/unknown/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A whole pass: a real LazyLibrarian-shaped SQLite file, real files, the app reads on the embedded Postgres 16
// ---------------------------------------------------------------------------------------------------------------------

function captureLog(): {
  log: SyncLogger;
  lines: { level: string; msg: string; fields: Record<string, unknown> }[];
} {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const push =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level, msg, fields });
  return { log: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

function llDbFile(root: string): string {
  const path = join(dir, 'lazylibrarian.db');
  const db = new DatabaseSync(path);
  db.exec(`create table authors (AuthorID text primary key, AuthorName text);
    create table books (BookID text primary key, AuthorID text, BookName text, BookSub text, BookLang text, Status text,
      AudioStatus text, BookFile text, AudioFile text);`);
  db.prepare('insert into authors values (?, ?)').run('a1', 'Hugh Howey');
  const ins = db.prepare('insert into books values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(
    'Qw30DwAAQBAJ',
    'a1',
    'Shift',
    null,
    'en',
    'Open',
    'Skipped',
    `${root}/EBooks/Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub`,
    null,
  );
  ins.run(
    'PQ30DwAAQBAJ',
    'a1',
    'Wool',
    null,
    'en',
    'Open',
    'Skipped',
    `${root}/EBooks/Hugh Howey/Wool/Wool - Hugh Howey.epub`,
    null,
  );
  ins.run('ital', 'a1', 'Lana', null, 'it', 'Wanted', 'Skipped', null, null);
  db.close();
  return path;
}

describe('runCensusPass', () => {
  let books: string;
  let llPath: string;
  let holdsPath: string;
  beforeAll(() => {
    books = join(dir, 'books');
    put(
      'books/EBooks/Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub',
      epub({ title: 'First Shift - Legacy', language: 'en' }),
    );
    put(
      'books/EBooks/Hugh Howey/Wool/Wool - Hugh Howey.epub',
      epub({ title: 'Wool', language: 'en' }),
    );
    llPath = llDbFile(books);
    holdsPath = put('holds.yaml', 'version: 1\nholds: []\n');
  });

  it('LazyLibrarian only: logs each finding and one summary line', async () => {
    const { log, lines } = captureLog();
    const result = await runCensusPass(
      { llDbPath: llPath, holds: holdsPath, booksRoot: books },
      log,
    );
    expect(result.summary).toMatchObject({
      llBooks: 3,
      ebookFiles: 2,
      read: 2,
      wrongFile: 1,
      foreignWanted: 1,
    });
    expect(lines.filter((l) => l.msg === 'books_census_finding').map((l) => l.fields.key)).toEqual([
      'wrong_file:Qw30DwAAQBAJ:ebook',
      'foreign_wanted:ital',
    ]);
    const summary = lines.find((l) => l.msg === 'books_census')!;
    expect(summary.fields).toMatchObject({
      holds: 'ok',
      appDb: 'none',
      samples: { wrong_file: ['Shift (Hugh Howey)'], foreign_wanted: ['Lana (Hugh Howey)'] },
    });
  });

  it('an unreadable holds file over-reports instead of hiding', async () => {
    const { log, lines } = captureLog();
    await runCensusPass(
      { llDbPath: llPath, holds: put('bad-holds.yaml', 'version: 2\n'), booksRoot: books },
      log,
    );
    expect(lines.some((l) => l.msg === 'books_census_holds_invalid' && l.level === 'error')).toBe(
      true,
    );
    expect(lines.find((l) => l.msg === 'books_census')!.fields).toMatchObject({
      holds: 'error',
      wrongFile: 1,
    });
  });

  describe('with the app database', () => {
    let testDb: TestDb;
    let url: string;
    beforeAll(async () => {
      testDb = await bootMigratedDb();
      url = (testDb.pool as unknown as { options: { connectionString: string } }).options
        .connectionString;
      // Seeded through the domain single-writer (the no-direct-state-writes guard): a Dutch-tagged book and a
      // French-tagged comic, which the census never counts.
      const item = (
        externalId: string,
        mediaKind: 'book' | 'comic',
        title: string,
        language: string,
      ) => ({
        source: 'kavita' as const,
        mediaKind,
        externalId,
        libraryId: mediaKind === 'book' ? '1' : '2',
        libraryName: mediaKind === 'book' ? 'Books' : 'Comics',
        title,
        sortTitle: title.toLowerCase(),
        author: null,
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: null,
        deepLinkUrl: 'x',
        pageCount: null,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: { language },
        sourceAddedAt: null,
        sourceUpdatedAt: null,
      });
      await syncBooks({
        db: testDb.db,
        rows: [item('18', 'book', 'De Silmarillion', 'nl'), item('77', 'comic', 'Asterix', 'fr')],
        syncedSources: ['kavita'],
      });
    }, 120_000);
    afterAll(async () => {
      await testDb?.stop();
    });

    it('reads wants and library tags through a read-only session', async () => {
      const { log, lines } = captureLog();
      const result = await runCensusPass(
        { llDbPath: llPath, databaseUrl: url, holds: holdsPath, booksRoot: books },
        log,
      );
      expect(result.summary).toMatchObject({
        foreignItems: 1,
        foreignItemsBySource: { kavita: 1 },
      });
      // The wants query ran (no want points at the Italian book here).
      expect(result.findings.find((f) => f.kind === 'foreign_wanted')!.wants).toEqual([]);
      expect(lines.find((l) => l.msg === 'books_census')!.fields.appDb).toBe('ok');
    });
  });
});
