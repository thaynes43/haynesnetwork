import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DownloadPathProbe,
  SabnzbdReadClient,
  bookFileKind,
  compareFolderToLibrary,
  llJanitorPathsFromEnv,
  LL_DOWNLOAD_ROOT_DEFAULT,
  type FolderFile,
  type LibraryFile,
} from '../src/read';
import { DownloadFolderCleaner, SabnzbdWriteClient } from '../src/write';
import { DownloadsHttpError, DownloadsPathError } from '../src/errors';

// ADR-095 / DESIGN-046 D-18 — the queue janitor's LazyLibrarian surfaces on the downloads stack: the filtered SABnzbd
// history read, the SABnzbd history-job delete (never del_files), and the mount checks + the folder delete, which
// must never reach outside the one download folder (a real temp directory, symlinks included).

function sabStub(body: unknown, calls: URL[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('SABnzbd janitor calls', () => {
  it('listHistory sends one archive view with its filters and reads the finish time; no ids ⇒ no request', async () => {
    const calls: URL[] = [];
    const client = new SabnzbdReadClient({
      baseUrl: 'http://sab.test/',
      apiKey: 'sab-secret',
      fetchImpl: sabStub(
        { history: { slots: [{ nzo_id: 'n1', name: 'A', status: 'Completed', storage: '/d/A', completed: 1790650000 }] } },
        calls,
      ),
    });
    const slots = await client.listHistory({ archive: true, category: 'lazylibrarian', status: 'Completed' });
    expect(slots).toEqual([
      { nzoId: 'n1', name: 'A', status: 'Completed', category: null, storage: '/d/A', failMessage: null, completedAt: new Date(1790650000 * 1000) },
    ]);
    const q = calls[0]!.searchParams;
    expect([q.get('mode'), q.get('archive'), q.get('cat'), q.get('status'), q.get('limit')]).toEqual([
      'history',
      '1',
      'lazylibrarian',
      'Completed',
      '10000',
    ]);
    await client.listHistory({ archive: false, nzoIds: ['a', 'b'] });
    expect(calls[1]!.searchParams.get('nzo_ids')).toBe('a,b');
    expect(calls[1]!.searchParams.get('archive')).toBe('0');
    expect(await client.listHistory({ archive: false, nzoIds: [] })).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('deleteHistoryJob deletes one job (SABnzbd archives it), never del_files; a refusal throws with the key redacted', async () => {
    const calls: URL[] = [];
    await new SabnzbdWriteClient({ baseUrl: 'http://sab.test', apiKey: 'sab-secret', fetchImpl: sabStub({ status: true }, calls) }).deleteHistoryJob('nzo-1');
    const q = calls[0]!.searchParams;
    expect([q.get('mode'), q.get('name'), q.get('value'), q.get('del_files'), q.get('archive')]).toEqual([
      'history',
      'delete',
      'nzo-1',
      null,
      null,
    ]);
    const refused = new SabnzbdWriteClient({ baseUrl: 'http://sab.test', apiKey: 'sab-secret', fetchImpl: sabStub({ status: false }) });
    const err = await refused.deleteHistoryJob('nzo-1').catch((e) => e);
    expect(err).toBeInstanceOf(DownloadsHttpError);
    expect(String(err.message)).not.toContain('sab-secret');
    await expect(refused.deleteHistoryJob('  ')).rejects.toBeInstanceOf(DownloadsHttpError);
  });
});

describe('the janitor paths on a real filesystem', () => {
  let base: string;
  let downloadRoot: string;
  let library: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'janitor-'));
    downloadRoot = join(base, 'complete', 'lazylibrarian');
    library = join(base, 'books', 'AudioBooks');
    await mkdir(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1'), { recursive: true });
    await writeFile(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1', '01.mp3'), 'x');
    await mkdir(join(library, 'Author', 'Book'), { recursive: true });
    await writeFile(join(library, 'Author', 'Book', '01.mp3'), 'x');
    // A symlink inside the download folder pointing at the library, and one standing in for a job folder.
    await symlink(join(library, 'Author'), join(downloadRoot, 'Author - Book (2014) MP3', 'link-to-library'));
    await symlink(join(library, 'Author'), join(downloadRoot, 'linked-job'));
    await symlink(join(library, 'Author', 'Book', '01.mp3'), join(library, 'Author', 'Book', 'link.mp3'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('the probe: mounts present, a real folder and file inside their roots, never a symlink or an outsider', async () => {
    const probe = new DownloadPathProbe({ downloadRoot, libraryRoots: [library] });
    expect(await probe.available()).toBe(true);
    expect(await probe.listDownloadFolders()).toEqual(new Set(['Author - Book (2014) MP3']));
    expect(await probe.downloadFolderExists(join(downloadRoot, 'Author - Book (2014) MP3'))).toBe(true);
    expect(await probe.downloadFolderExists(join(downloadRoot, 'linked-job'))).toBe(false);
    expect(await probe.downloadFolderExists(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1'))).toBe(false);
    expect(await probe.libraryFileExists(join(library, 'Author', 'Book', '01.mp3'))).toBe(true);
    expect(await probe.libraryFileExists(join(library, 'Author', 'Book', 'link.mp3'))).toBe(false);
    expect(await probe.libraryFileExists(join(library, 'Author', 'Book', 'gone.mp3'))).toBe(false);
    expect(await probe.libraryFileExists(join(library, '..', 'AudioBooks', 'Author', 'Book', '01.mp3'))).toBe(true);
    expect(await probe.libraryFileExists(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1', '01.mp3'))).toBe(false);
    expect(await new DownloadPathProbe({ downloadRoot: join(base, 'absent'), libraryRoots: [library] }).available()).toBe(false);
    // A library root that contains the download folder never vouches for a file inside it.
    const wide = new DownloadPathProbe({ downloadRoot, libraryRoots: [base] });
    expect(await wide.libraryFileExists(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1', '01.mp3'))).toBe(false);
    expect(await wide.libraryFileExists(join(library, 'Author', 'Book', '01.mp3'))).toBe(true);
  });

  it('the cleaner deletes one job folder (a symlink inside it goes as a link, its target stays), and refuses the rest', async () => {
    const cleaner = new DownloadFolderCleaner(downloadRoot);
    await expect(cleaner.removeFolder(join(downloadRoot, 'linked-job'))).rejects.toBeInstanceOf(DownloadsPathError);
    await expect(cleaner.removeFolder(downloadRoot)).rejects.toBeInstanceOf(DownloadsPathError);
    await expect(cleaner.removeFolder(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1'))).rejects.toBeInstanceOf(DownloadsPathError);
    await expect(cleaner.removeFolder(join(library, 'Author'))).rejects.toBeInstanceOf(DownloadsPathError);
    await expect(cleaner.removeFolder(join(downloadRoot, 'missing'))).rejects.toBeInstanceOf(DownloadsPathError);
    // The refusal names the rule, never the folder (a release name must not reach the janitor's error column).
    const refusal = await cleaner.removeFolder(join(downloadRoot, 'linked-job')).catch((e: Error) => e);
    expect(String((refusal as Error).message)).not.toContain('linked-job');
    await cleaner.removeFolder(join(downloadRoot, 'Author - Book (2014) MP3'));
    await expect(stat(join(downloadRoot, 'Author - Book (2014) MP3'))).rejects.toThrow();
    expect((await stat(join(library, 'Author', 'Book', '01.mp3'))).isFile()).toBe(true);
  });

  it('llJanitorPathsFromEnv: live defaults; overrides keep absolute paths only', () => {
    expect(llJanitorPathsFromEnv({}).downloadRoot).toBe(LL_DOWNLOAD_ROOT_DEFAULT);
    expect(llJanitorPathsFromEnv({ JANITOR_LL_LIBRARY_ROOTS: '/a:relative:/b' }).libraryRoots).toEqual(['/a', '/b']);
  });
});

// DESIGN-046 D-22 (issue #621): a folder is a leftover only when every book file in it has its counterpart among
// the files of its destinations' directories. The shapes are the live ones of 2026-09-29, anonymized.
describe('compareFolderToLibrary (D-22, pure)', () => {
  const f = (path: string, size: number, regular = true): FolderFile => ({ path, size, regular });
  const l = (name: string, size: number): LibraryFile => ({ name, size });

  it('book files are audio and eBook formats by extension; archives are their own kind; the rest is ignored', () => {
    expect(['a.MP3', 'b.m4b', 'c.flac', 'd.opus'].map(bookFileKind)).toEqual(Array(4).fill('audio'));
    expect(['a.EPUB', 'b.azw3', 'c.mobi', 'd.pdf', 'e.cbz'].map(bookFileKind)).toEqual(Array(5).fill('ebook'));
    expect(['a.rar', 'a.r00', 'a.001', 'a.zip', 'a.7z'].map(bookFileKind)).toEqual(Array(5).fill('archive'));
    const ignored = ['a.nfo', 'a.jpg', 'a.sfv', 'file_id.diz', 'a.URL', 'a.m3u', 'a.txt', 'a.opf', 'a.par2', 'noext'];
    expect(ignored.map(bookFileKind)).toEqual(Array(ignored.length).fill('other'));
  });

  it('audio: the same name and size (LazyLibrarian keeps audio names), anywhere in the folder', () => {
    const library = [l('Author - Book - 01 of 02.mp3', 28_311_552), l('Author - Book - 02 of 02.mp3', 28_311_552)];
    const folder = [
      f('Author - Book - 01 of 02.mp3', 28_311_552),
      f('CD2/Author - Book - 02 of 02.mp3', 28_311_552),
      f('cover.jpg', 5),
      f('book.nfo', 1),
    ];
    expect(compareFolderToLibrary(folder, library)).toEqual({ covered: true, bookFiles: 2 });
    // Size alone is no identity for audio: equal-length parts of another book have the same size.
    expect(compareFolderToLibrary([f('Other - Book - 01 of 02.mp3', 28_311_552)], library)).toEqual({
      covered: false,
      gap: 'not_matched',
      bookFiles: 1,
      unmatched: 1,
    });
    // The same name at another size is another file.
    expect(compareFolderToLibrary([f('Author - Book - 01 of 02.mp3', 28_311_553)], library).covered).toBe(false);
  });

  it('eBook: the same extension and size under any name (LazyLibrarian renames every eBook file)', () => {
    const library = [l('Book - Author.epub', 507_854), l('Book - Author.mobi', 569_082), l('Book - Author.opf', 1_465)];
    const folder = [f('Author.Book.2012.RETAiL.EPUB.eBook-GRP.EPUB', 507_854), f('grp.nfo', 2_008)];
    expect(compareFolderToLibrary(folder, library)).toEqual({ covered: true, bookFiles: 1 });
    // The same size under another extension is not a counterpart.
    expect(compareFolderToLibrary([f('x.azw3', 507_854)], library).covered).toBe(false);
  });

  it('issue #621 (a): a series tracked as one book, the destination holds volume 6, the folder volume 3', () => {
    const library = [
      l('Series - Author.epub', 1_258_578),
      l('Series - Author.pdf', 178_736),
      l('Series - Author.jpg', 2_997_475),
      l('Series - Author.opf', 850),
    ];
    const folder = [f('Author - Series 03 - Book.epub', 755_982), f('WELCOME advert.pdf', 178_736), f('Community.URL', 214)];
    expect(compareFolderToLibrary(folder, library)).toEqual({
      covered: false,
      gap: 'not_matched',
      bookFiles: 2,
      unmatched: 1,
    });
  });

  it('issue #621 (b): the destination epub is the omnibus; the azw3 is there byte for byte, the epub is not', () => {
    const library = [
      l('Book - Author.epub', 3_450_352),
      l('Book - Author.azw3', 2_094_536),
      l('Book - Author.mobi', 638_415),
      l('Author - Book.azw3', 549_196),
    ];
    const folder = [f('Author - Trilogy 03 Book (retail).azw3', 549_196), f('Author - Trilogy 03 Book (retail).epub', 795_804)];
    expect(compareFolderToLibrary(folder, library)).toEqual({
      covered: false,
      gap: 'not_matched',
      bookFiles: 2,
      unmatched: 1,
    });
  });

  it('never covered: no book file, an archive left behind, a symlinked book file, an empty library', () => {
    const library = [l('Book - Author.epub', 10)];
    expect(compareFolderToLibrary([f('x.nfo', 1), f('file_id.diz', 1)], library)).toEqual({
      covered: false,
      gap: 'no_book_file',
      bookFiles: 0,
      unmatched: 0,
    });
    expect(compareFolderToLibrary([f('a.epub', 10), f('a.part01.rar', 99)], library)).toMatchObject({
      covered: false,
      gap: 'archive',
    });
    expect(compareFolderToLibrary([f('a.epub', 10, false)], library)).toMatchObject({ covered: false, gap: 'not_matched' });
    expect(compareFolderToLibrary([f('a.epub', 10)], [])).toMatchObject({ covered: false, gap: 'not_matched' });
  });
});

describe('DownloadPathProbe.folderCoverage (D-22) on a real filesystem', () => {
  let base: string;
  let downloadRoot: string;
  let ebooks: string;
  let audio: string;
  let probe: DownloadPathProbe;
  const put = async (path: string, bytes: number) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes, 1));
  };
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'janitor-cov-'));
    downloadRoot = join(base, 'complete', 'lazylibrarian');
    ebooks = join(base, 'books', 'EBooks');
    audio = join(base, 'books', 'AudioBooks');
    probe = new DownloadPathProbe({ downloadRoot, libraryRoots: [ebooks, audio] });
    // A good audiobook (names kept, a nested CD folder), a good renamed eBook, and the #621 series-slot shape.
    await put(join(downloadRoot, 'Author - Book (2014) MP3', 'CD1', '01.mp3'), 300);
    await put(join(downloadRoot, 'Author - Book (2014) MP3', 'book.nfo'), 20);
    await put(join(audio, 'Author', 'Book', '01.mp3'), 300);
    await symlink(join(audio, 'Author', 'Book', '01.mp3'), join(audio, 'Author', 'Book', '02.mp3'));
    await put(join(downloadRoot, 'Author.Ebook.RETAIL.EPUB-GRP', 'Author.Ebook.RETAIL.EPUB-GRP.epub'), 5_000);
    await put(join(ebooks, 'Author', 'Ebook', 'Ebook - Author.epub'), 5_000);
    await put(join(downloadRoot, 'Author - Series 03 - Book epub.1', 'Author - Series 03 - Book.epub'), 7_559);
    await put(join(ebooks, 'Author', 'Series', 'Series - Author.epub'), 12_585);
    // A symlinked book file inside a folder (its target is the library copy: still not the folder's own file).
    await mkdir(join(downloadRoot, 'Author - Linked (epub)'), { recursive: true });
    await symlink(
      join(ebooks, 'Author', 'Ebook', 'Ebook - Author.epub'),
      join(downloadRoot, 'Author - Linked (epub)', 'Linked.epub'),
    );
    // A folder nested deeper than the walk's bound.
    await put(join(downloadRoot, 'Author - Deep', 'a', 'b', 'c', 'd', '01.mp3'), 300);
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('compares the walked folder with the regular files of the destination directory', async () => {
    const book = join(audio, 'Author', 'Book', '01.mp3');
    const ebook = join(ebooks, 'Author', 'Ebook', 'Ebook - Author.epub');
    const slot = join(ebooks, 'Author', 'Series', 'Series - Author.epub');
    expect(await probe.folderCoverage(join(downloadRoot, 'Author - Book (2014) MP3'), [book])).toEqual({
      covered: true,
      bookFiles: 1,
    });
    expect(await probe.folderCoverage(join(downloadRoot, 'Author.Ebook.RETAIL.EPUB-GRP'), [ebook])).toEqual({
      covered: true,
      bookFiles: 1,
    });
    expect(await probe.folderCoverage(join(downloadRoot, 'Author - Series 03 - Book epub.1'), [slot])).toEqual({
      covered: false,
      gap: 'not_matched',
      bookFiles: 1,
      unmatched: 1,
    });
    expect(await probe.folderCoverage(join(downloadRoot, 'Author - Linked (epub)'), [ebook])).toMatchObject({
      covered: false,
      gap: 'not_matched',
    });
  });

  it('whatever it cannot vouch for is unreadable: over the bounds, a missing or outside destination, no folder', async () => {
    const book = join(audio, 'Author', 'Book', '01.mp3');
    const folder = join(downloadRoot, 'Author - Book (2014) MP3');
    const unreadable = { covered: false, gap: 'unreadable' };
    expect(await probe.folderCoverage(join(downloadRoot, 'Author - Deep'), [book])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(folder, [join(audio, 'Author', 'Book', 'gone.mp3')])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(folder, [join(base, 'elsewhere.mp3')])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(folder, [null])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(folder, [])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(join(downloadRoot, 'missing'), [book])).toMatchObject(unreadable);
    expect(await probe.folderCoverage(join(folder, 'CD1'), [book])).toMatchObject(unreadable);
  });
});
