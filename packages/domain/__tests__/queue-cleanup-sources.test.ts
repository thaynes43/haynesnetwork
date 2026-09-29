import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { appSettings, arrQueueCleanupActions, notificationOutbox, permissionAudit } from '@hnet/db';
import { LazyLibrarianReadClient } from '@hnet/lazylibrarian/read';
import { LazyLibrarianWriteClient } from '@hnet/lazylibrarian/write';
import { KapowarrReadClient } from '@hnet/kapowarr/read';
import { KapowarrWriteClient } from '@hnet/kapowarr/write';
import { DownloadPathProbe, SabnzbdReadClient, type DownloadPathFs } from '@hnet/downloads/read';
import { DownloadFolderCleaner, SabnzbdWriteClient, type DownloadFolderFs } from '@hnet/downloads/write';
import { bootMigratedDb, type TestDb } from './helpers';
import { renderOutboxEmail } from '../src/notify-outbox';
import {
  FAIL_LOOP_MIN_FAILURES,
  QueueCleanupItemGoneError,
  buildKapowarrQueueCleanupAdapter,
  buildLazyLibrarianQueueCleanupAdapter,
  classifyKapowarrQueue,
  classifyLazyLibrarian,
  normalizeLlFailure,
  queueCleanupSourceAdaptersFromEnv,
  type QueueCleanupSourceAdapter,
  type QueueCleanupSourceItem,
} from '../src/queue-cleanup-sources';
import {
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  QUEUE_CLEANUP_LOOP_LOG,
  QUEUE_CLEANUP_SOURCE_LOOP_LIMIT,
  buildQueueCleanupDigestSection,
  deriveQueueCleanupLadderLevel,
  evaluateQueueCleanup,
  getArrQueueCleanupConfig,
  getArrQueueCleanupStatus,
  getQueueCleanupLadder,
  queueCleanupCellMode,
  queueCleanupConfigError,
  setArrQueueCleanupConfig,
  type ArrQueueCleanupConfig,
  type QueueCleanupClients,
  type QueueCleanupInstanceClient,
} from '../src/queue-cleanup';
import {
  DOWNLOAD_FOLDERS_SAMPLE,
  KAPOWARR_QUEUE_SAMPLE,
  LIBRARY_FILES_SAMPLE,
  LL_BOOKS_SAMPLE,
  LL_HISTORY_SAMPLE,
  SAB_HISTORY_SAMPLE,
  SAB_QUEUE_SAMPLE,
  SAMPLE_PATHS,
  type SabSlotSample,
} from './fixtures/janitor-suite-samples';

// ADR-095 / DESIGN-046 D-15..D-20 (PLAN-065) — the queue janitor covers the download suite. The proof: the stored
// config of 2026-09-29 survives the widening cell for cell; LazyLibrarian and Kapowarr classify from anonymized live
// samples through their real read clients; the shared evaluator applies every rail (cells, age, cap, one action per
// download, escalation, seeding, the loop guard, the loop signals) and never writes while a cell is census; the
// ladder is per family; the digest lists fail loops and every family's ladder.

// ---------------------------------------------------------------------------
// Fakes: fetch stubs over the samples, an in-memory filesystem for the mount checks.
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function llFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const cmd = url.searchParams.get('cmd') ?? '';
    calls.push(cmd);
    if (cmd === 'getHistory') return json(LL_HISTORY_SAMPLE);
    if (cmd === 'getAllBooks') return json(LL_BOOKS_SAMPLE);
    if (cmd === 'forceProcess') return new Response('OK', { status: 200 });
    return json({ Success: false, Error: { Code: 404, Message: `Unknown command: ${cmd}` } });
  }) as typeof fetch;
}

function sabFetch(calls: URL[] = [], slots: SabSlotSample[] = SAB_HISTORY_SAMPLE): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const mode = url.searchParams.get('mode');
    if (mode === 'queue') return json(SAB_QUEUE_SAMPLE);
    if (mode === 'history' && url.searchParams.get('name') === 'delete') return json({ status: true });
    if (mode === 'history') {
      const archive = url.searchParams.get('archive') === '1';
      const ids = url.searchParams.get('nzo_ids')?.split(',');
      const cat = url.searchParams.get('cat');
      const status = url.searchParams.get('status');
      const out = slots
        .filter((s) => s.archive === archive)
        .map((s) => s.slot)
        .filter(
          (s) =>
            (!ids || ids.includes(String(s.nzo_id))) && (!cat || s.category === cat) && (!status || s.status === status),
        );
      return json({ history: { slots: out, noofslots: out.length } });
    }
    return json({ status: false }, 400);
  }) as typeof fetch;
}

/** An in-memory filesystem: the given directories and files exist; realpath is the lexical path; rm is recorded. */
function memFs(dirs: string[], files: string[], removed: string[] = []): DownloadFolderFs {
  const dirSet = new Set(dirs.map((d) => resolve(d)));
  const fileSet = new Set(files.map((f) => resolve(f)));
  const stat = (kind: 'dir' | 'file') => ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  });
  return {
    lstat: async (p) => {
      const r = resolve(p);
      if (dirSet.has(r)) return stat('dir');
      if (fileSet.has(r)) return stat('file');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    realpath: async (p) => resolve(p),
    readdir: async (p) =>
      [...dirSet]
        .filter((d) => dirname(d) === resolve(p))
        .map((d) => ({ name: d.slice(resolve(p).length + 1), isDirectory: () => true, isSymbolicLink: () => false })),
    rm: async (p) => {
      removed.push(resolve(p));
      dirSet.delete(resolve(p));
    },
  };
}

function sampleFs(removed: string[] = []): DownloadFolderFs {
  const libDirs = [...new Set(LIBRARY_FILES_SAMPLE.map((f) => dirname(f)))];
  return memFs(
    [
      SAMPLE_PATHS.downloadRoot,
      ...SAMPLE_PATHS.libraryRoots,
      ...libDirs,
      ...DOWNLOAD_FOLDERS_SAMPLE.map((n) => `${SAMPLE_PATHS.downloadRoot}/${n}`),
    ],
    LIBRARY_FILES_SAMPLE,
    removed,
  );
}

function llAdapter(opts: {
  withMounts?: boolean;
  llCalls?: string[];
  sabCalls?: URL[];
  removed?: string[];
  fs?: DownloadFolderFs;
}): QueueCleanupSourceAdapter {
  const fs = opts.fs ?? sampleFs(opts.removed);
  const llOpts = { baseUrl: 'http://ll.test', apiKey: 'k', fetchImpl: llFetch(opts.llCalls), retries: 0 };
  const sabOpts = { baseUrl: 'http://sab.test', apiKey: 'k', fetchImpl: sabFetch(opts.sabCalls) };
  return buildLazyLibrarianQueueCleanupAdapter({
    ll: new LazyLibrarianReadClient(llOpts),
    llWrite: new LazyLibrarianWriteClient(llOpts),
    sab: new SabnzbdReadClient(sabOpts),
    sabWrite: new SabnzbdWriteClient(sabOpts),
    ...(opts.withMounts === false
      ? {}
      : {
          probe: new DownloadPathProbe(SAMPLE_PATHS, fs as DownloadPathFs),
          cleaner: new DownloadFolderCleaner(SAMPLE_PATHS.downloadRoot, fs),
        }),
  });
}

async function llItems(withMounts = true): Promise<QueueCleanupSourceItem[]> {
  return llAdapter({ withMounts }).observe();
}

const byRef = (items: QueueCleanupSourceItem[], ref: string) => items.filter((i) => i.itemRef === ref);

// ---------------------------------------------------------------------------
// D-18 — LazyLibrarian: reasons, classification, the adapter.
// ---------------------------------------------------------------------------

describe('normalizeLlFailure (D-18, pure): a message, never a name, a path or a key', () => {
  it.each([
    ['Duplicate NZB', 'Duplicate NZB'],
    [
      'Failed to send nzb to @ <a href="http://prowlarr.downloads.svc.cluster.local:9696/14/api?t=get&apikey=FAKEKEY">SABNZBD</a>',
      'Failed to send nzb to SABnzbd',
    ],
    [
      'Unable to locate a valid filetype (ebook) in /data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian/Author - Title (2014) MP3, leaving for manual processing',
      'Unable to locate a valid filetype (ebook), leaving for manual processing',
    ],
    ['Rejecting torrent name Author - Title (Dramatized), contains und', 'Rejecting torrent name, contains und'],
    ['Repair failed, not enough repair blocks (1175 short)', 'Repair failed, not enough repair blocks'],
    ['URL Fetching failed; Empty NZB file Anne.3-Title-Author.nzb', 'URL Fetching failed'],
    ['Got a 500 response for http://prowlarr.downloads.svc.cluster.local:9696/14/api?apikey=FAKEKEY', 'Got a 500 response from the indexer'],
    ['Author - Title (Retail) was sent to SABNZBD 10 hours ago. Progress: -2', 'Sent to SABNZBD, never finished'],
    ['Unable to copy file /data/a/b.MP3 to /data/c/d.MP3: IsADirectoryError', 'Unable to copy file'],
    ['Failed to send torrent to QBITTORRENT', 'Failed to send torrent to QBITTORRENT'],
    ['Aborted, cannot be completed - https://sabnzbd.org/not-complete', 'Aborted, cannot be completed - https://sabnzbd.org/not-complete'],
    // Any other URL loses its query string (a key can hide under any parameter name).
    ['Odd failure at https://indexer.example/api?t=get&r=SECRETTOKEN', 'Odd failure at https://indexer.example/api'],
  ])('%s', (raw, expected) => {
    const out = normalizeLlFailure(raw);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/apikey|FAKEKEY|SECRETTOKEN|\/data\//i);
  });

  it('null and blank read as null', () => {
    expect(normalizeLlFailure(null)).toBeNull();
    expect(normalizeLlFailure('  ')).toBeNull();
  });
});

describe('classifyLazyLibrarian via the real read clients (D-18, live samples)', () => {
  it('snatches: a strand is retry_import, a failed job bad_release, the rest unknown; torrents never removable', async () => {
    const items = await llItems(false);
    const strand = byRef(items, 'bkStrand0001/audiobook')[0]!;
    expect(strand).toMatchObject({
      actionClass: 'retry_import',
      downloadId: 'nzo-strand-0001',
      queueItemId: null,
      removable: true,
      reason: 'Download finished, LazyLibrarian has not imported it',
    });
    expect(strand.addedAt?.toISOString()).toBe(new Date(1790650000 * 1000).toISOString());

    expect(byRef(items, 'bkFailed0002/ebook')[0]).toMatchObject({
      actionClass: 'bad_release',
      removable: true,
      reason: 'Repair failed, not enough repair blocks',
    });
    expect(byRef(items, 'bkFlight0003/audiobook')[0]).toMatchObject({ actionClass: 'unknown', reason: null });
    expect(byRef(items, 'bkGone00004/audiobook')[0]).toMatchObject({
      actionClass: 'unknown',
      removable: false,
      reason: 'Not in SABnzbd, LazyLibrarian aborts the snatch itself',
    });
    expect(byRef(items, 'bkTorrent005/audiobook')[0]).toMatchObject({ actionClass: 'unknown', removable: false });
    expect(byRef(items, 'bkTorrent006/audiobook')[0]).toMatchObject({
      actionClass: 'retry_import',
      removable: false,
      reason: 'Torrent finished, LazyLibrarian has not imported it',
    });
    // Processed and Seeding rows are not snatches; without the mounts there is no leftover census at all.
    expect(items.some((i) => i.actionClass === 'leftover')).toBe(false);
    expect(byRef(items, 'bkSeed00011/ebook')).toHaveLength(0);
  });

  it(`fail loops: ${FAIL_LOOP_MIN_FAILURES}+ failed grabs of a format still Wanted, the most frequent reason, report only`, async () => {
    const items = await llItems(false);
    const loops = items.filter((i) => i.actionClass === 'fail_loop');
    expect(loops).toEqual([
      {
        queueItemId: null,
        itemRef: 'bkLoop00012/ebook',
        downloadId: null,
        title: 'Book Loop (eBook)',
        addedAt: null,
        targetId: null,
        actionClass: 'fail_loop',
        // 3 "Duplicate NZB" and 3 "Failed to send nzb": the tie goes to the row read last.
        reason: 'Failed to send nzb to SABnzbd',
        attempts: 7,
        removable: false,
      },
    ]);
    // Open now (has it) or under the threshold: not a loop. No stored reason names a key or a path.
    for (const i of items) expect(i.reason ?? '').not.toMatch(/apikey|FAKEKEY|\/data\//i);
  });

  it('leftovers (mounts present): imported with every copy on disk is leftover; a missing copy or a failed download is reported', async () => {
    const items = await llItems(true);
    const left = items.filter((i) => /^nzo-(left|missing|faildir|swept|reuse)/.test(i.downloadId ?? ''));
    expect(left.map((i) => [i.downloadId, i.actionClass, i.reason])).toEqual([
      // SABnzbd reused the folder name for the strand: the old Processed job points at a folder that is not its own.
      ['nzo-reuse-0015', 'unknown', 'Download folder named by more than one SABnzbd job'],
      ['nzo-left-0007', 'leftover', 'Imported, the download folder is still in SABnzbd'],
      [
        'nzo-missing-0008',
        'unknown',
        'Library copy not found at the recorded destination, the download folder may be the only copy',
      ],
      ['nzo-faildir-0010', 'unknown', 'Folder of a failed download left in SABnzbd'],
    ]);
    // Book Nine's folder is already gone (swept by hand): no row. The strand's folder stays with its snatch row.
    expect(items.filter((i) => i.downloadId === 'nzo-strand-0001')).toHaveLength(1);
  });

  it('pure: an empty state classifies to nothing', () => {
    expect(
      classifyLazyLibrarian({ history: [], books: new Map(), sabQueue: [], sabJobs: [], leftovers: null }),
    ).toEqual([]);
  });
});

describe('the LazyLibrarian adapter (D-18): reads, and the only writes', () => {
  it('observe reads the snatches’ SABnzbd jobs from BOTH views, and the category history only with the mounts', async () => {
    const sabCalls: URL[] = [];
    await llAdapter({ withMounts: false, sabCalls }).observe();
    const history = sabCalls.filter((u) => u.searchParams.get('mode') === 'history');
    expect(history.map((u) => u.searchParams.get('archive')).sort()).toEqual(['0', '1']);
    for (const u of history) {
      expect(u.searchParams.get('nzo_ids')!.split(',').sort()).toEqual([
        'nzo-failed-0002',
        'nzo-flight-0003',
        'nzo-gone-0004',
        'nzo-strand-0001',
      ]);
      expect(u.searchParams.get('del_files')).toBeNull();
    }

    const withMounts: URL[] = [];
    await llAdapter({ sabCalls: withMounts }).observe();
    const category = withMounts.filter((u) => u.searchParams.get('cat') === 'lazylibrarian');
    // Completed jobs from both views, plus every live job whatever its status (who else names a folder).
    expect(category.map((u) => [u.searchParams.get('archive'), u.searchParams.get('status')]).sort()).toEqual([
      ['0', null],
      ['0', 'Completed'],
      ['1', 'Completed'],
    ]);
  });

  it('bad_release deletes the SABnzbd job (no del_files, no search); retry is forceProcess', async () => {
    const sabCalls: URL[] = [];
    const llCalls: string[] = [];
    const adapter = llAdapter({ sabCalls, llCalls });
    const items = await adapter.observe();
    const failed = items.filter((i) => i.downloadId === 'nzo-failed-0002');
    expect(await adapter.act('bad_release', failed)).toEqual({ searched: [] });
    const del = sabCalls.filter((u) => u.searchParams.get('name') === 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]!.searchParams.get('value')).toBe('nzo-failed-0002');
    expect(del[0]!.searchParams.get('del_files')).toBeNull();
    await adapter.retryImports!();
    expect(llCalls).toContain('forceProcess');
    expect(llCalls).not.toContain('searchBook');
  });

  it('leftover re-checks the folder and every library copy, then deletes only that folder', async () => {
    const removed: string[] = [];
    const adapter = llAdapter({ removed });
    const items = await adapter.observe();
    const left = items.filter((i) => i.actionClass === 'leftover');
    expect(await adapter.act('leftover', left)).toEqual({ searched: [] });
    expect(removed).toEqual([`${SAMPLE_PATHS.downloadRoot}/Author Seven - Book Seven (2014) MP3`]);
    // The folder is gone now: a second attempt is skipped_gone, not an error.
    await expect(adapter.act('leftover', left)).rejects.toBeInstanceOf(QueueCleanupItemGoneError);
  });

  it('leftover keeps the folder when a library copy vanished between the census and the delete', async () => {
    const removed: string[] = [];
    const files = [...LIBRARY_FILES_SAMPLE];
    const base = sampleFs(removed);
    const fs: DownloadFolderFs = {
      ...base,
      lstat: async (p) => {
        if (resolve(p) === resolve(files[0]!) && removed.length === 0 && seen) throw new Error('ENOENT');
        return base.lstat(p);
      },
    };
    let seen = false;
    const adapter = llAdapter({ fs });
    const items = await adapter.observe();
    seen = true;
    await expect(adapter.act('leftover', items.filter((i) => i.actionClass === 'leftover'))).rejects.toThrow(
      /library copy no longer found/,
    );
    expect(removed).toEqual([]);
  });
});

describe('DownloadPathProbe + DownloadFolderCleaner (D-18): confined to the one folder', () => {
  const fs = () => sampleFs();
  it('refuses anything outside, nested, the root itself, or a symlink', async () => {
    const probe = new DownloadPathProbe(SAMPLE_PATHS, fs());
    const root = SAMPLE_PATHS.downloadRoot;
    expect(await probe.available()).toBe(true);
    expect(await probe.downloadFolderExists(`${root}/Author Seven - Book Seven (2014) MP3`)).toBe(true);
    expect(await probe.downloadFolderExists(root)).toBe(false);
    expect(await probe.downloadFolderExists(`${root}/../lazylibrarian/Author Seven - Book Seven (2014) MP3/x`)).toBe(false);
    expect(await probe.downloadFolderExists('/data/cephfs-hdd/data/media/books/AudioBooks')).toBe(false);
    expect(await probe.libraryFileExists(LIBRARY_FILES_SAMPLE[0])).toBe(true);
    expect(await probe.libraryFileExists(`${root}/Author Seven - Book Seven (2014) MP3`)).toBe(false);
    expect(await probe.libraryFileExists('relative/path.mp3')).toBe(false);

    const cleaner = new DownloadFolderCleaner(root, fs());
    await expect(cleaner.removeFolder(root)).rejects.toThrow(/refused/);
    await expect(cleaner.removeFolder(`${root}/a/b`)).rejects.toThrow(/refused/);
    await expect(cleaner.removeFolder('/data/cephfs-hdd/data/media/books/AudioBooks/Author Seven')).rejects.toThrow(
      /refused/,
    );

    const linked = sampleFs();
    const symlinkFs: DownloadFolderFs = {
      ...linked,
      lstat: async () => ({ isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }),
    };
    await expect(
      new DownloadFolderCleaner(root, symlinkFs).removeFolder(`${root}/Author Seven - Book Seven (2014) MP3`),
    ).rejects.toThrow(/symlink/);
    expect(await new DownloadPathProbe(SAMPLE_PATHS, symlinkFs).available()).toBe(false);
  });

  it('available() is false when a mount is absent', async () => {
    const noLibrary = memFs([SAMPLE_PATHS.downloadRoot], []);
    expect(await new DownloadPathProbe(SAMPLE_PATHS, noLibrary).available()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-19 — Kapowarr.
// ---------------------------------------------------------------------------

describe('Kapowarr (D-19): classification and the adapter', () => {
  function kapowarr(opts: { deleteStatus?: number; volume?: Record<string, unknown> | null; calls?: Array<[string, string, unknown]> }) {
    const calls = opts.calls ?? [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push([method, url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (url.pathname === '/api/activity/queue' && method === 'GET') return json(KAPOWARR_QUEUE_SAMPLE);
      if (url.pathname.startsWith('/api/activity/queue/') && method === 'DELETE') {
        return opts.deleteStatus && opts.deleteStatus !== 200
          ? json({ error: 'DownloadQueueEntryNotFound', result: {} }, opts.deleteStatus)
          : json({ error: null, result: {} });
      }
      if (url.pathname.startsWith('/api/volumes/')) {
        return opts.volume === null ? json({ error: 'VolumeNotFound', result: {} }, 404) : json({ error: null, result: opts.volume });
      }
      if (url.pathname === '/api/system/tasks') return json({ error: null, result: { id: 1 } }, 201);
      return json({ error: 'unexpected', result: null }, 500);
    }) as typeof fetch;
    const o = { baseUrl: 'http://kapowarr.test', apiKey: 'k', fetchImpl, retries: 0 };
    return buildKapowarrQueueCleanupAdapter({ read: new KapowarrReadClient(o), write: new KapowarrWriteClient(o) });
  }

  it('a failed entry is bad_release (keyed by its volume), the rest in flight', async () => {
    const items = await kapowarr({}).observe();
    // The download id is the queue id AND what it fetches: Kapowarr reuses rowids once its queue drains.
    expect(items.map((i) => [i.queueItemId, i.downloadId, i.targetId, i.actionClass, i.reason])).toEqual([
      [7, '7|1||https://getcomics.org/other-comics/comic-one-1-6-color-edition/', 1, 'bad_release', 'Download failed in Kapowarr'],
      [8, '8|2|31|Comic Two #3', 2, 'unknown', null],
    ]);
    expect(classifyKapowarrQueue([])).toEqual([]);
  });

  it('bad_release removes with blocklist, then searches a monitored volume missing issues, once', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const adapter = kapowarr({ calls, volume: { id: 1, monitored: true, issue_count: 6, issues_downloaded: 0 } });
    const [failed] = await adapter.observe();
    const res = await adapter.act('bad_release', [failed!]);
    expect(res.searched).toEqual([failed]);
    expect(calls.filter(([m]) => m !== 'GET' || true).map(([m, p, b]) => [m, p, b])).toEqual([
      ['GET', '/api/activity/queue', undefined],
      ['DELETE', '/api/activity/queue/7', { blocklist: true }],
      ['GET', '/api/volumes/1', undefined],
      ['POST', '/api/system/tasks', { cmd: 'auto_search', volume_id: 1 }],
    ]);
  });

  it('a complete or unmonitored volume is not searched; a 404 removal is gone', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const done = kapowarr({ calls, volume: { id: 1, monitored: true, issue_count: 6, issues_downloaded: 6 } });
    const [failed] = await done.observe();
    expect((await done.act('bad_release', [failed!])).searched).toEqual([]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/system/tasks')).toBe(false);

    const gone = kapowarr({ deleteStatus: 404 });
    const [again] = await gone.observe();
    await expect(gone.act('bad_release', [again!])).rejects.toBeInstanceOf(QueueCleanupItemGoneError);
  });
});

// ---------------------------------------------------------------------------
// D-16 — config back-compat (pure).
// ---------------------------------------------------------------------------

/** The janitor config EXACTLY as stored on 2026-09-29 (read on a replica: jsonb key order, no manual_match key, no
 *  suite sources). Every cell must survive the widening. */
const LIVE_STORED_2026_09_29 = {
  modes: {
    lidarr: { bad_release: 'enforce', have_better: 'enforce', retry_import: 'enforce' },
    radarr: { bad_release: 'enforce', have_better: 'enforce', retry_import: 'enforce' },
    sonarr: { bad_release: 'enforce', have_better: 'enforce', retry_import: 'enforce' },
  },
  minItemAgeHours: 2,
  maxActionsPerRun: 10,
  retryEscalateRuns: 6,
};

describe('config back-compat (D-16, pure)', () => {
  it('the live stored shape is valid; each absent suite instance or cell reads census, nothing else changes', () => {
    expect(queueCleanupConfigError(LIVE_STORED_2026_09_29)).toBeNull();
    const cfg = LIVE_STORED_2026_09_29 as unknown as ArrQueueCleanupConfig;
    for (const instance of ['sonarr', 'radarr', 'lidarr'] as const) {
      for (const klass of ['have_better', 'retry_import', 'bad_release'] as const) {
        expect(queueCleanupCellMode(cfg, instance, klass)).toBe('enforce');
      }
    }
    for (const [instance, klass] of [
      ['lidarr', 'manual_match'],
      ['lazylibrarian', 'retry_import'],
      ['lazylibrarian', 'bad_release'],
      ['lazylibrarian', 'leftover'],
      ['kapowarr', 'bad_release'],
    ] as const) {
      expect(queueCleanupCellMode(cfg, instance, klass)).toBe('census');
    }
    // A partial suite instance is valid too (an absent cell is census).
    expect(queueCleanupConfigError({ ...LIVE_STORED_2026_09_29, modes: { ...LIVE_STORED_2026_09_29.modes, lazylibrarian: { leftover: 'enforce' } } })).toBeNull();
  });

  it('still refuses an unknown instance or class, a class off its instance, and a bad mode', () => {
    const withModes = (extra: Record<string, unknown>) => ({
      ...LIVE_STORED_2026_09_29,
      modes: { ...LIVE_STORED_2026_09_29.modes, ...extra },
    });
    expect(queueCleanupConfigError(withModes({ bazarr: {} }))).toMatch(/Unknown instance 'bazarr'/);
    expect(queueCleanupConfigError(withModes({ lazylibrarian: { manual_match: 'census' } }))).toMatch(
      /Unknown class 'manual_match' in modes.lazylibrarian/,
    );
    expect(queueCleanupConfigError(withModes({ kapowarr: { retry_import: 'census' } }))).toMatch(
      /Unknown class 'retry_import' in modes.kapowarr/,
    );
    expect(queueCleanupConfigError(withModes({ sonarr: { have_better: 'enforce', retry_import: 'census', bad_release: 'census', leftover: 'census' } }))).toMatch(
      /Unknown class 'leftover' in modes.sonarr/,
    );
    expect(queueCleanupConfigError(withModes({ kapowarr: { bad_release: 'on' } }))).toMatch(
      /modes.kapowarr.bad_release must be/,
    );
    expect(queueCleanupConfigError(withModes({ kapowarr: 'enforce' }))).toMatch(/modes.kapowarr must be an object/);
    // The three *arrs stay required.
    const { sonarr: _drop, ...noSonarr } = LIVE_STORED_2026_09_29.modes;
    expect(queueCleanupConfigError({ ...LIVE_STORED_2026_09_29, modes: noSonarr })).toMatch(/modes.sonarr must be an object/);
  });

  it('the ladder is per family: the live shape reads arr L1 (manual_match census, D-13), and new census cells never lower arr', () => {
    const cfg = LIVE_STORED_2026_09_29 as unknown as ArrQueueCleanupConfig;
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
    const flipped = {
      ...LIVE_STORED_2026_09_29,
      modes: {
        ...LIVE_STORED_2026_09_29.modes,
        lidarr: { ...LIVE_STORED_2026_09_29.modes.lidarr, manual_match: 'enforce' },
      },
    } as unknown as ArrQueueCleanupConfig;
    expect(deriveQueueCleanupLadderLevel(flipped, 'arr')).toBe(2);
    expect(deriveQueueCleanupLadderLevel(flipped, 'books')).toBe(0);
    expect(deriveQueueCleanupLadderLevel(flipped, 'comics')).toBe(0);
    const books = {
      ...flipped,
      modes: { ...flipped.modes, lazylibrarian: { retry_import: 'enforce', bad_release: 'census', leftover: 'census' } },
    } as ArrQueueCleanupConfig;
    expect(deriveQueueCleanupLadderLevel(books, 'arr')).toBe(2);
    expect(deriveQueueCleanupLadderLevel(books, 'books')).toBe(1);
    expect(deriveQueueCleanupLadderLevel({ ...books, modes: { ...books.modes, kapowarr: { bad_release: 'enforce' } } }, 'comics')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D-15..D-20 — the shared evaluator, config, ladders and digest on embedded Postgres.
// ---------------------------------------------------------------------------

function emptyArr(): QueueCleanupInstanceClient {
  return {
    getQueueAll: async () => [],
    deleteQueueItem: async () => {
      throw new Error('no *arr write expected');
    },
    processMonitoredDownloads: async () => {
      throw new Error('no *arr write expected');
    },
    monitoredTargets: async () => [],
    searchTargets: async () => {
      throw new Error('no *arr write expected');
    },
  };
}

interface FakeSource {
  adapter: QueueCleanupSourceAdapter;
  acts: Array<{ actionClass: string; downloadIds: Array<string | null> }>;
  retries: number;
}

function fakeSource(
  instance: 'lazylibrarian' | 'kapowarr',
  items: () => QueueCleanupSourceItem[],
  behave: {
    act?: (actionClass: string, items: QueueCleanupSourceItem[]) => Promise<{ searched: QueueCleanupSourceItem[]; followUpError?: string }>;
  } = {},
): FakeSource {
  const fake: FakeSource = {
    acts: [],
    retries: 0,
    adapter: {
      instance,
      observe: async () => items(),
      act: async (actionClass, its) => {
        fake.acts.push({ actionClass, downloadIds: its.map((i) => i.downloadId) });
        return behave.act ? behave.act(actionClass, its) : { searched: [] };
      },
      retryImports: async () => {
        fake.retries += 1;
      },
    },
  };
  return fake;
}

function srcItem(o: Partial<QueueCleanupSourceItem> & Pick<QueueCleanupSourceItem, 'actionClass'>): QueueCleanupSourceItem {
  return {
    queueItemId: null,
    itemRef: null,
    downloadId: null,
    title: null,
    addedAt: new Date('2026-09-01T00:00:00Z'),
    targetId: null,
    reason: null,
    attempts: null,
    removable: true,
    ...o,
  };
}

function suiteCfg(o: {
  lazylibrarian?: Partial<ArrQueueCleanupConfig['modes']['lazylibrarian']>;
  kapowarr?: Partial<ArrQueueCleanupConfig['modes']['kapowarr']>;
  cap?: number;
  age?: number;
  escalate?: number;
}): ArrQueueCleanupConfig {
  const base = structuredClone(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);
  return {
    ...base,
    modes: {
      ...base.modes,
      lazylibrarian: { ...base.modes.lazylibrarian, ...o.lazylibrarian },
      kapowarr: { ...base.modes.kapowarr, ...o.kapowarr },
    },
    maxActionsPerRun: o.cap ?? 10,
    minItemAgeHours: o.age ?? 0,
    retryEscalateRuns: o.escalate ?? 6,
  };
}

function clients(sources: Partial<Record<'lazylibrarian' | 'kapowarr', QueueCleanupSourceAdapter>>): QueueCleanupClients {
  return { sonarr: emptyArr(), radarr: emptyArr(), lidarr: emptyArr(), ...sources };
}

function captureLog() {
  const lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (msg: string, meta?: Record<string, unknown>) => lines.push({ level, msg, meta });
  return {
    lines,
    loops: () => lines.filter((l) => l.msg === QUEUE_CLEANUP_LOOP_LOG).map((l) => l.meta!),
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
  };
}

describe('the suite on embedded Postgres (D-15..D-20)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.db.delete(arrQueueCleanupActions);
    await t.db.delete(notificationOutbox);
    await t.db.delete(permissionAudit);
    await t.db.delete(appSettings);
  });

  const rows = () => t.db.select().from(arrQueueCleanupActions);

  it('BACK-COMPAT: the live stored row resolves cell for cell; the writer then stores the full canonical shape', async () => {
    await t.db.insert(appSettings).values({ key: 'arr_queue_cleanup_config', value: LIVE_STORED_2026_09_29 });
    const cfg = await getArrQueueCleanupConfig(t.db);
    expect(cfg).toEqual({
      modes: {
        sonarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' },
        radarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' },
        lidarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce', manual_match: 'census' },
        lazylibrarian: { retry_import: 'census', bad_release: 'census', leftover: 'census' },
        kapowarr: { bad_release: 'census' },
      },
      maxActionsPerRun: 10,
      minItemAgeHours: 2,
      retryEscalateRuns: 6,
    });
    const status = await getArrQueueCleanupStatus({ db: t.db });
    expect(status.source).toBe('db');
    expect(status.ladders.map((l) => [l.family, l.level])).toEqual([
      ['arr', 1],
      ['books', 0],
      ['comics', 0],
    ]);

    // Flip the Lidarr manual_match cell the way the coordinator will: arr reads L2, the new families stay L0.
    cfg!.modes.lidarr.manual_match = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: cfg!, actorId: null });
    // D-16 rule 4: an all-census suite instance is not stored, so the row stays one the previous image accepts.
    const storedModes = async () => {
      const [stored] = await t.db.select().from(appSettings).where(eq(appSettings.key, 'arr_queue_cleanup_config'));
      return Object.keys((stored!.value as { modes: object }).modes).sort();
    };
    expect(await storedModes()).toEqual(['lidarr', 'radarr', 'sonarr']);
    const after = await getArrQueueCleanupStatus({ db: t.db });
    expect(after.ladder.level).toBe(2);
    expect(after.ladders.map((l) => [l.family, l.level])).toEqual([
      ['arr', 2],
      ['books', 0],
      ['comics', 0],
    ]);
    // Enforcing a books cell stores LazyLibrarian (Kapowarr, all census, stays out) and every *arr cell survives.
    const next = await getArrQueueCleanupConfig(t.db);
    next!.modes.lazylibrarian.leftover = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: next!, actorId: null });
    expect(await storedModes()).toEqual(['lazylibrarian', 'lidarr', 'radarr', 'sonarr']);
    const final = await getArrQueueCleanupStatus({ db: t.db });
    expect(final.config.modes.sonarr).toEqual({ have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' });
    expect(final.config.modes.lazylibrarian).toEqual({ retry_import: 'census', bad_release: 'census', leftover: 'enforce' });
    expect(final.ladders.map((l) => [l.family, l.level])).toEqual([
      ['arr', 2],
      ['books', 1],
      ['comics', 0],
    ]);
  });

  it('LADDER AGE (D-17): a write that changes only a books cell resets the books age, never the arr age', async () => {
    const t0 = new Date('2026-09-01T12:00:00Z');
    const cfg = suiteCfg({ age: 2 }); // the default knobs: a knob change would count for every family
    await setArrQueueCleanupConfig({ db: t.db, config: { ...cfg, modes: { ...cfg.modes, sonarr: { ...cfg.modes.sonarr, have_better: 'enforce' } } }, actorId: null });
    await t.db.update(permissionAudit).set({ createdAt: t0 });
    const books = await getArrQueueCleanupConfig(t.db);
    books!.modes.lazylibrarian.retry_import = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: books!, actorId: null });
    const now = new Date(t0.getTime() + 20 * 86_400_000);
    const arr = await getQueueCleanupLadder({ db: t.db, config: books!, now });
    expect(arr.ageDays).toBe(20);
    expect(arr.promotionDue).toBe(true); // > 14 days at the same level
    const booksLadder = await getQueueCleanupLadder({ db: t.db, config: books!, now, family: 'books' });
    expect(booksLadder.level).toBe(1);
    expect(booksLadder.ageDays).toBe(0);
    const comics = await getQueueCleanupLadder({ db: t.db, config: books!, now, family: 'comics' });
    expect(comics.ageDays).toBeNull();
    // A shared knob counts for every family.
    await setArrQueueCleanupConfig({ db: t.db, config: { ...books!, maxActionsPerRun: 5 }, actorId: null });
    expect((await getQueueCleanupLadder({ db: t.db, config: books!, now, family: 'comics' })).ageDays).toBe(0);
  });

  it('CENSUS: every source item gets a row (item_ref, null queue id, attempts), and nothing is ever acted on', async () => {
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'retry_import', itemRef: 'bk1/ebook', downloadId: 'nzo-1' }),
      srcItem({ actionClass: 'bad_release', itemRef: 'bk2/ebook', downloadId: 'nzo-2' }),
      srcItem({ actionClass: 'leftover', itemRef: 'bk3/audiobook', downloadId: 'nzo-3' }),
      srcItem({ actionClass: 'fail_loop', itemRef: 'bk4/ebook', attempts: 173, title: 'Book Four (eBook)', reason: 'Duplicate NZB' }),
    ]);
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: 'bad_release', queueItemId: 7, downloadId: '7', targetId: 1 })]);
    const report = await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter, kapowarr: k.adapter }), config: suiteCfg({}) });
    expect(ll.acts).toEqual([]);
    expect(ll.retries).toBe(0);
    expect(k.acts).toEqual([]);
    expect(report.instances.map((i) => [i.instance, i.read, i.itemsObserved])).toEqual([
      ['sonarr', true, 0],
      ['radarr', true, 0],
      ['lidarr', true, 0],
      ['lazylibrarian', true, 4],
      ['kapowarr', true, 1],
    ]);
    const all = await rows();
    expect(all.every((r) => r.mode === 'census' && r.action === 'none' && r.outcome === 'observed')).toBe(true);
    const loop = all.find((r) => r.actionClass === 'fail_loop')!;
    expect(loop).toMatchObject({ instance: 'lazylibrarian', queueItemId: null, itemRef: 'bk4/ebook', attempts: 173 });
    expect(all.find((r) => r.instance === 'kapowarr')).toMatchObject({ queueItemId: 7, targetId: 1, itemRef: null });
  });

  it('ENFORCE: retry once per run (covered), a removal per download, a leftover delete; seeding torrents never', async () => {
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'retry_import', itemRef: 'bk1/ebook', downloadId: 'nzo-1' }),
      srcItem({ actionClass: 'retry_import', itemRef: 'bk5/ebook', downloadId: 'nzo-5' }),
      // One download holding both formats: one removal.
      srcItem({ actionClass: 'bad_release', itemRef: 'bk2/ebook', downloadId: 'nzo-2' }),
      srcItem({ actionClass: 'bad_release', itemRef: 'bk2/audiobook', downloadId: 'nzo-2' }),
      srcItem({ actionClass: 'bad_release', itemRef: 'bk6/ebook', downloadId: 'hash-6', removable: false }),
      srcItem({ actionClass: 'leftover', itemRef: 'bk3/audiobook', downloadId: 'nzo-3' }),
      srcItem({ actionClass: 'fail_loop', itemRef: 'bk4/ebook', attempts: 9 }),
      srcItem({ actionClass: 'unknown', itemRef: 'bk7/ebook', downloadId: 'nzo-7' }),
    ]);
    const cfg = suiteCfg({ lazylibrarian: { retry_import: 'enforce', bad_release: 'enforce', leftover: 'enforce' } });
    const report = await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter }), config: cfg });
    expect(ll.retries).toBe(1);
    expect(ll.acts).toEqual([
      { actionClass: 'bad_release', downloadIds: ['nzo-2', 'nzo-2'] },
      { actionClass: 'leftover', downloadIds: ['nzo-3'] },
    ]);
    const llReport = report.instances.find((i) => i.instance === 'lazylibrarian')!;
    expect(llReport.actionsTaken).toBe(3);
    expect(llReport.covered).toBe(2);
    const actions = Object.fromEntries((await rows()).map((r) => [`${r.itemRef}`, r.action]));
    expect(actions).toEqual({
      'bk1/ebook': 'retried_import',
      'bk5/ebook': 'retried_import',
      'bk2/ebook': 'removed_blocklisted',
      'bk2/audiobook': 'removed_blocklisted',
      'bk6/ebook': 'skipped_seeding',
      'bk3/audiobook': 'removed_leftover',
      'bk4/ebook': 'none',
      'bk7/ebook': 'none',
    });
  });

  it('CENSUS shows skipped_seeding and skipped_young too (what would happen), never for report-only classes', async () => {
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'bad_release', itemRef: 'bk6/ebook', downloadId: 'hash-6', removable: false }),
      srcItem({ actionClass: 'retry_import', itemRef: 'bk1/ebook', downloadId: 'nzo-1', addedAt: new Date() }),
      srcItem({ actionClass: 'unknown', itemRef: 'bk7/ebook', downloadId: 'nzo-7', addedAt: null }),
    ]);
    await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter }), config: suiteCfg({ age: 2 }) });
    const actions = Object.fromEntries((await rows()).map((r) => [`${r.itemRef}`, r.action]));
    expect(actions).toEqual({ 'bk6/ebook': 'skipped_seeding', 'bk1/ebook': 'skipped_young', 'bk7/ebook': 'none' });
  });

  it('ESCALATION: retry_import after retryEscalateRuns prior runs is handled as bad_release; a torrent then stays seeding', async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'retry_import', itemRef: 'bk1/ebook', downloadId: 'nzo-1' }),
      srcItem({ actionClass: 'retry_import', itemRef: 'bk6/ebook', downloadId: 'hash-6', removable: false }),
    ]);
    const cfg = suiteCfg({ lazylibrarian: { retry_import: 'census', bad_release: 'enforce' }, escalate: 2 });
    for (let run = 0; run < 3; run += 1) {
      await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter }), config: cfg, now: new Date(t0.getTime() + run * hour) });
    }
    expect(ll.acts).toEqual([{ actionClass: 'bad_release', downloadIds: ['nzo-1'] }]);
    const last = (await rows()).filter((r) => r.createdAt.getTime() === t0.getTime() + 2 * hour);
    expect(Object.fromEntries(last.map((r) => [r.itemRef, [r.actionClass, r.action]]))).toEqual({
      'bk1/ebook': ['bad_release', 'removed_blocklisted'],
      'bk6/ebook': ['bad_release', 'skipped_seeding'],
    });
  });

  it('AGE via first sighting (Kapowarr gives no timestamp): young on the first run, acted on once old enough', async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: 'bad_release', queueItemId: 7, downloadId: '7', targetId: 1, addedAt: null })]);
    const cfg = suiteCfg({ kapowarr: { bad_release: 'enforce' }, age: 2 });
    await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: t0 });
    await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: new Date(t0.getTime() + hour) });
    expect(k.acts).toEqual([]);
    await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: new Date(t0.getTime() + 3 * hour) });
    expect(k.acts).toEqual([{ actionClass: 'bad_release', downloadIds: ['7'] }]);
    expect((await rows()).map((r) => r.action).sort()).toEqual(['removed_blocklisted', 'skipped_young', 'skipped_young']);
  });

  it('AGE via first sighting counts from the first sighting IN THE CLASS: hours in flight do not make a fresh failure old', async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    let status: 'unknown' | 'bad_release' = 'unknown';
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: status, queueItemId: 9, downloadId: '9', targetId: 1, addedAt: null })]);
    const cfg = suiteCfg({ kapowarr: { bad_release: 'enforce' }, age: 2 });
    const run = (h: number) => evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: new Date(t0.getTime() + h * hour) });
    await run(0); // in flight
    await run(5); // still in flight, 5 hours seen
    status = 'bad_release';
    await run(6); // failed now: first seen failed this run, young
    expect(k.acts).toEqual([]);
    await run(9);
    expect(k.acts).toEqual([{ actionClass: 'bad_release', downloadIds: ['9'] }]);
  });

  it('CAP, GONE, ERROR and a failed search after the removal (D-11 shapes on a source)', async () => {
    const k = fakeSource(
      'kapowarr',
      () => [1, 2, 3, 4].map((n) => srcItem({ actionClass: 'bad_release', queueItemId: n, downloadId: String(n), targetId: n })),
      {
        act: async (_c, its) => {
          const id = its[0]!.downloadId;
          if (id === '1') throw new QueueCleanupItemGoneError('gone');
          if (id === '2') throw new Error('HTTP 500');
          return { searched: [], followUpError: 'search failed' };
        },
      },
    );
    const report = await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: suiteCfg({ kapowarr: { bad_release: 'enforce' }, cap: 3 }) });
    const byId = Object.fromEntries((await rows()).map((r) => [r.downloadId, [r.action, r.outcome, r.error]]));
    expect(byId).toEqual({
      '1': ['skipped_gone', 'observed', null],
      '2': ['none', 'error', 'HTTP 500'],
      '3': ['removed_blocklisted', 'error', 'search failed'],
      '4': ['skipped_cap', 'observed', null],
    });
    expect(report.instances.find((i) => i.instance === 'kapowarr')).toMatchObject({ actionsTaken: 3, errors: 2 });
  });

  it(`LOOP GUARD (D-20): a target removed on ${QUEUE_CLEANUP_SOURCE_LOOP_LIMIT} earlier downloads is held, with one loop_detected line`, async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    let n = 0;
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'bad_release', itemRef: 'bk2/ebook', downloadId: `nzo-${n}`, title: 'Author - Book (Retail)' }),
    ]);
    const cfg = suiteCfg({ lazylibrarian: { bad_release: 'enforce' } });
    const log = captureLog();
    for (n = 0; n < 3; n += 1) {
      await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter }), config: cfg, now: new Date(t0.getTime() + n * hour), logger: log.logger });
    }
    expect(ll.acts.map((a) => a.downloadIds[0])).toEqual(['nzo-0', 'nzo-1']);
    expect((await rows()).map((r) => [r.downloadId, r.action])).toEqual(
      expect.arrayContaining([
        ['nzo-0', 'removed_blocklisted'],
        ['nzo-1', 'removed_blocklisted'],
        ['nzo-2', 'skipped_loop'],
      ]),
    );
    expect(log.loops()).toEqual([
      expect.objectContaining({ kind: 'skipped_loop', instance: 'lazylibrarian', itemRef: 'bk2/ebook', downloadId: 'nzo-2', priorRemovals: 2 }),
    ]);
  });

  it('REPEAT SEARCH (D-20): a Kapowarr volume searched on a second run is logged', async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    let id = 10;
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: 'bad_release', queueItemId: id, downloadId: String(id), targetId: 1 })], {
      act: async (_c, its) => ({ searched: its }),
    });
    const cfg = suiteCfg({ kapowarr: { bad_release: 'enforce' } });
    const log = captureLog();
    await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: t0, logger: log.logger });
    id = 11;
    await evaluateQueueCleanup({ db: t.db, clients: clients({ kapowarr: k.adapter }), config: cfg, now: new Date(t0.getTime() + hour), logger: log.logger });
    expect(log.loops()).toEqual([
      expect.objectContaining({ kind: 'repeat_search', instance: 'kapowarr', targets: [{ targetId: 1, searches7d: 2 }] }),
    ]);
    const section = await buildQueueCleanupDigestSection({ db: t.db, now: new Date(t0.getTime() + 2 * hour) });
    expect(section!.loops.repeatSearches).toEqual([expect.objectContaining({ instance: 'kapowarr', targetId: 1, runs: 2 })]);
    expect(section!.loopDetected).toBe(true);
  });

  it('FAIL LOOP signal (D-20): logged when first seen and when the count grows, not while it holds still', async () => {
    const hour = 3_600_000;
    const t0 = new Date('2026-09-20T00:00:00Z');
    let attempts = 170;
    const ll = fakeSource('lazylibrarian', () => [
      srcItem({ actionClass: 'fail_loop', itemRef: 'bk4/ebook', attempts, title: 'Book Four (eBook)', reason: 'Duplicate NZB', addedAt: null }),
    ]);
    const log = captureLog();
    const run = (h: number) =>
      evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: ll.adapter }), config: suiteCfg({}), now: new Date(t0.getTime() + h * hour), logger: log.logger });
    await run(0);
    await run(1);
    attempts = 173;
    await run(2);
    expect(log.loops().map((m) => [m.kind, m.attempts, m.previousAttempts])).toEqual([
      ['fail_loop', 170, null],
      ['fail_loop', 173, 170],
    ]);
  });

  it('an unreadable source reads false; the *arrs and the other source still run; not a total failure', async () => {
    const broken: QueueCleanupSourceAdapter = {
      instance: 'lazylibrarian',
      observe: async () => {
        throw new Error('not configured: missing LAZYLIBRARIAN_API_KEY');
      },
      act: async () => ({ searched: [] }),
    };
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: 'unknown', queueItemId: 8, downloadId: '8' })]);
    const report = await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: broken, kapowarr: k.adapter }), config: suiteCfg({}) });
    expect(report.totalFailure).toBe(false);
    expect(report.instances.find((i) => i.instance === 'lazylibrarian')).toMatchObject({ read: false, readError: 'not configured: missing LAZYLIBRARIAN_API_KEY' });
    expect((await rows()).map((r) => r.instance)).toEqual(['kapowarr']);
  });

  it('totalFailure keeps its meaning (every *arr unreadable), whatever the sources do', async () => {
    const down: QueueCleanupInstanceClient = {
      ...emptyArr(),
      getQueueAll: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const k = fakeSource('kapowarr', () => [srcItem({ actionClass: 'unknown', queueItemId: 8, downloadId: '8' })]);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: { sonarr: down, radarr: down, lidarr: down, kapowarr: k.adapter },
      config: suiteCfg({}),
    });
    expect(report.totalFailure).toBe(true);
    expect(report.instances.find((i) => i.instance === 'kapowarr')!.read).toBe(true);
  });

  it('a source that fails mid-evaluation is reported and never costs the *arrs their rows', async () => {
    const arr: QueueCleanupInstanceClient = {
      ...emptyArr(),
      getQueueAll: async () => [
        {
          queueItemId: 1,
          downloadId: 'dl-arr',
          title: 'Show S01E01',
          addedAt: new Date('2026-09-01T00:00:00Z'),
          status: 'downloading',
          trackedDownloadStatus: 'ok',
          trackedDownloadState: 'downloading',
          errorMessage: null,
          statusMessages: null,
        },
      ],
    };
    // A class the table refuses: the source's insert fails after its evaluation.
    const bad = fakeSource('lazylibrarian', () => [srcItem({ actionClass: 'bogus' as never, itemRef: 'bk/ebook' })]);
    const log = captureLog();
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: { sonarr: arr, radarr: emptyArr(), lidarr: emptyArr(), lazylibrarian: bad.adapter },
      config: suiteCfg({}),
      logger: log.logger,
    });
    expect((await rows()).map((r) => [r.instance, r.downloadId])).toEqual([['sonarr', 'dl-arr']]);
    expect(report.instances.find((i) => i.instance === 'lazylibrarian')).toMatchObject({ read: false, errors: 1 });
    expect(report.rowsWritten).toBe(1);
    expect(log.lines.some((l) => l.msg === 'queue-cleanup: source evaluation failed')).toBe(true);
  });

  it('the env bundle: a missing source key yields an adapter whose read fails, never a throw', async () => {
    const adapters = queueCleanupSourceAdaptersFromEnv({});
    await expect(adapters.lazylibrarian.observe()).rejects.toThrow(/not configured.*LAZYLIBRARIAN_API_KEY/);
    await expect(adapters.kapowarr.observe()).rejects.toThrow(/not configured.*KAPOWARR_API_KEY/);
  });

  it('END TO END: the LazyLibrarian adapter over the samples, census, then the digest lists the fail loop and every ladder', async () => {
    const adapter = llAdapter({});
    await evaluateQueueCleanup({ db: t.db, clients: clients({ lazylibrarian: adapter }), config: suiteCfg({ age: 2 }), now: new Date('2026-09-29T15:00:00Z') });
    const all = await rows();
    expect(all.every((r) => r.instance === 'lazylibrarian' && r.mode === 'census')).toBe(true);
    expect(all.map((r) => [r.itemRef, r.actionClass, r.action]).sort()).toEqual(
      [
        ['bkStrand0001/audiobook', 'retry_import', 'none'],
        ['bkFailed0002/ebook', 'bad_release', 'none'],
        ['bkFlight0003/audiobook', 'unknown', 'none'],
        ['bkGone00004/audiobook', 'unknown', 'none'],
        ['bkTorrent005/audiobook', 'unknown', 'none'],
        ['bkTorrent006/audiobook', 'retry_import', 'none'],
        ['bkLeft00007/audiobook', 'leftover', 'none'],
        ['bkMissing008/audiobook', 'unknown', 'none'],
        ['bkReuse00015/audiobook', 'unknown', 'none'],
        ['bkFailDir010/audiobook', 'unknown', 'none'],
        ['bkLoop00012/ebook', 'fail_loop', 'none'],
      ].sort(),
    );

    const section = await buildQueueCleanupDigestSection({ db: t.db, now: new Date('2026-09-29T16:00:00Z') });
    expect(section!.loops.failLoops).toEqual([
      { instance: 'lazylibrarian', itemRef: 'bkLoop00012/ebook', title: 'Book Loop (eBook)', attempts: 7, reason: 'Failed to send nzb to SABnzbd' },
    ]);
    expect(section!.loopDetected).toBe(false); // the source's own loops do not raise the janitor loop tag
    expect(section!.ladders.map((l) => [l.family, l.level, l.promotionDue])).toEqual([
      ['arr', 0, false],
      ['books', 0, true], // census evidence for a books cell, below L2: no calendar wait (D-17)
      ['comics', 0, false],
    ]);
    expect(section!.promotionDue).toBe(false); // the *arr ladder's nag; each family's is on `ladders`
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: JSON.parse(JSON.stringify(section)) },
    })!;
    expect(mail.subject).toContain('[janitor: books promotion due]');
    expect(mail.subject).not.toContain('[janitor: promotion due]');
    expect(mail.subject).not.toContain('[janitor: loop detected]');
    expect(mail.text).toContain('lazylibrarian:');
    expect(mail.text).toContain('Still wanted after 5 or more failed grabs, report only (1):');
    expect(mail.text).toContain(' • lazylibrarian Book Loop (eBook): 7 failed grabs, mostly Failed to send nzb to SABnzbd');
    expect(mail.text).toContain('Ladder, Sonarr, Radarr and Lidarr: L0 (unset).');
    expect(mail.text).toContain('Ladder, LazyLibrarian: L0 (unset), promotion due.');
    expect(mail.text).not.toMatch(/apikey|FAKEKEY/i);
  });

  it('a pre-D-17 digest payload (ladder only, no ladders) still renders its ladder line', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: {
        to: 'admin@example.test',
        count: 0,
        queueCleanup: { observed: 3, actions: 0, instances: [], ladder: { level: 2, ageDays: 3, nextCriteria: 'L2→L3' }, promotionDue: false },
      },
    })!;
    expect(mail.text).toContain('Ladder: L2 (3d at level).');
  });
});
