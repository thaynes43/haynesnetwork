import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DownloadPathProbe, SabnzbdReadClient, llJanitorPathsFromEnv, LL_DOWNLOAD_ROOT_DEFAULT } from '../src/read';
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
