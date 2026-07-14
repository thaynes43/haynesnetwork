import { describe, expect, it } from 'vitest';
import {
  buildKapowarrActivity,
  buildKapowarrActivityAdapter,
  parseKapowarrActivityRef,
  resolveKapowarrBaseUrl,
  type KapowarrActivityReadClient,
  type KapowarrActivitySources,
} from '../src/activity/kapowarr-adapter';
import type {
  KapowarrHistoryEntry,
  KapowarrQueueEntry,
  KapowarrTask,
  KapowarrVolume,
} from '@hnet/kapowarr/read';

// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the PURE Kapowarr (comics) normalizer: the
// live download queue + running search tasks + completed history → the shared Activity stage machine. The KEY
// comic cases are the download_failed strand (a dead GetComics grab) and the `searching` monitored-wanted
// volume backed by a real search task. Every item rides the BOOKS section gate (`section: 'books'`, NOT a new
// union value) with kind 'comic' / wall 'comics'. Kapowarr has no manual-import queue → import_blocked is NOT
// produced (documented honestly), so comic failures only ever offer a re-search.

const NOW = new Date('2026-07-14T12:00:00Z');
const FRESH_MS = new Date('2026-07-14T11:55:00Z').getTime() / 1000; // epoch SECONDS, 5 min ago (in horizon)
const STALE_MS = new Date('2026-07-14T11:00:00Z').getTime() / 1000; // 1h ago (past the 15-min horizon)

function queue(overrides: Partial<KapowarrQueueEntry> & { volumeId: number }): KapowarrQueueEntry {
  return {
    id: overrides.id ?? overrides.volumeId,
    volumeId: overrides.volumeId,
    issueId: overrides.issueId ?? null,
    status: overrides.status ?? 'downloading',
    progress: overrides.progress ?? 40,
    title: overrides.title ?? `Scott.Pilgrim.v${overrides.volumeId}`,
    source: overrides.source ?? 'GetComics (direct)',
  };
}
function volume(overrides: Partial<KapowarrVolume> & { id: number }): KapowarrVolume {
  return {
    id: overrides.id,
    comicvineId: overrides.comicvineId ?? 25478,
    title: overrides.title ?? `Volume ${overrides.id}`,
    monitored: overrides.monitored ?? true,
    issueCount: overrides.issueCount ?? 6,
    issuesDownloaded: overrides.issuesDownloaded ?? 0,
  };
}

function empty(): KapowarrActivitySources {
  return { queue: [], tasks: [], history: [], volumes: [] };
}
function build(partial: Partial<KapowarrActivitySources>, opts?: { baseUrl?: string | null }) {
  return buildKapowarrActivity(
    { ...empty(), ...partial },
    { now: NOW, completedHorizonMs: 15 * 60 * 1000, ...(opts ?? {}) },
  );
}

describe('buildKapowarrActivity — the Kapowarr comic stage machine', () => {
  it('maps a downloading comic to `downloading` with progress, comic/comics/books facets + kapowarr attribution', () => {
    const items = build({
      queue: [queue({ volumeId: 701, status: 'downloading', progress: 62, title: 'Scott.Pilgrim.01' })],
      volumes: [volume({ id: 701, title: 'Scott Pilgrim' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'kapowarr:701',
      kind: 'comic',
      wall: 'comics',
      section: 'books', // comics ride the books gate — NOT a new contract value
      sourceApp: 'kapowarr',
      stage: 'downloading',
      progress: 62,
    });
    expect(items[0]!.actions).toEqual([]);
    // volume.title (clean) wins over the scene-ish queue title.
    expect(items[0]!.title).toBe('Scott Pilgrim');
  });

  it('THE FAILED-DOWNLOAD CASE: a failed queue entry → failed / download_failed, re-search only (no fake retry)', () => {
    const items = build({
      queue: [queue({ volumeId: 705, status: 'failed', progress: null })],
    });
    const item = items[0]!;
    expect(item.stage).toBe('failed');
    expect(item.failureKind).toBe('download_failed');
    expect(item.failureReason).toMatch(/failed/i);
    // Kapowarr has NO retry-import surface — a dead comic grab is re-searchable only.
    expect(item.actions).toEqual(['force_research']);
  });

  it('maps an importing queue entry to `importing`', () => {
    const items = build({ queue: [queue({ volumeId: 706, status: 'importing', progress: 100 })] });
    expect(items[0]).toMatchObject({ id: 'kapowarr:706', stage: 'importing', progress: null });
  });

  it('SKIPS canceled / shutdown queue entries (user/app-stopped — never a fabricated failure)', () => {
    const items = build({
      queue: [queue({ volumeId: 707, status: 'canceled' }), queue({ volumeId: 708, status: 'shutdown' })],
    });
    expect(items).toHaveLength(0);
  });

  it('lets a FAILED issue win over a downloading issue of the SAME volume (severity dedup)', () => {
    const items = build({
      queue: [
        queue({ volumeId: 710, issueId: 1, status: 'downloading', progress: 30 }),
        queue({ volumeId: 710, issueId: 2, status: 'failed', progress: null }),
      ],
    });
    const forVol = items.filter((i) => i.id === 'kapowarr:710');
    expect(forVol).toHaveLength(1);
    expect(forVol[0]!.stage).toBe('failed');
  });

  it('surfaces a FRESH successful history download as `completed`, dropping stale / failed / queue-held ones', () => {
    const items = build({
      queue: [queue({ volumeId: 720, status: 'downloading' })], // this volume is live → history dedup
      history: [
        { volumeId: 721, title: 'Fresh Comic', downloadedAtMs: FRESH_MS * 1000, success: true } as KapowarrHistoryEntry,
        { volumeId: 722, title: 'Old Comic', downloadedAtMs: STALE_MS * 1000, success: true } as KapowarrHistoryEntry,
        { volumeId: 723, title: 'Failed Comic', downloadedAtMs: FRESH_MS * 1000, success: false } as KapowarrHistoryEntry,
        { volumeId: 720, title: 'Same Volume', downloadedAtMs: FRESH_MS * 1000, success: true } as KapowarrHistoryEntry,
      ],
    });
    const completed = items.filter((i) => i.stage === 'completed').map((i) => i.id);
    expect(completed).toEqual(['kapowarr:721']); // stale + failed dropped; 720 kept its live queue stage
    expect(items.find((i) => i.id === 'kapowarr:720')!.stage).toBe('downloading');
  });

  it('reports `searching` ONLY for a monitored-wanted volume backed by an ACTIVE per-volume search task', () => {
    const items = build({
      tasks: [{ action: 'auto_search', volumeId: 730, displayTitle: 'Searching…' } as KapowarrTask],
      volumes: [
        volume({ id: 730, monitored: true, issueCount: 6, issuesDownloaded: 0, title: 'Wanted Vol' }), // wanted + task
        volume({ id: 731, monitored: true, issueCount: 6, issuesDownloaded: 0 }), // wanted but NO task → skip
        volume({ id: 732, monitored: true, issueCount: 6, issuesDownloaded: 6 }), // landed → not wanted
        volume({ id: 733, monitored: false, issueCount: 6, issuesDownloaded: 0 }), // unmonitored → skip
      ],
    });
    const searching = items.filter((i) => i.stage === 'searching').map((i) => i.id);
    expect(searching).toEqual(['kapowarr:730']);
    expect(items.find((i) => i.id === 'kapowarr:730')).toMatchObject({ kind: 'comic', wall: 'comics', title: 'Wanted Vol' });
  });

  it('a GLOBAL search task (no volume_id) marks every monitored-wanted volume `searching`', () => {
    const items = build({
      tasks: [{ action: 'search_all', volumeId: null, displayTitle: 'Search Monitored' } as KapowarrTask],
      volumes: [
        volume({ id: 740, issuesDownloaded: 0 }),
        volume({ id: 741, issuesDownloaded: 2 }), // still wanted (2 < 6)
        volume({ id: 742, issuesDownloaded: 6 }), // landed
      ],
    });
    expect(items.filter((i) => i.stage === 'searching').map((i) => i.id).sort()).toEqual([
      'kapowarr:740',
      'kapowarr:741',
    ]);
  });

  it('reports NO searching when there is no search task, even for wanted volumes', () => {
    const items = build({ volumes: [volume({ id: 750, issuesDownloaded: 0 })] });
    expect(items).toHaveLength(0);
  });

  it('threads the Admin-only downstream base URL', () => {
    const items = build({ queue: [queue({ volumeId: 760 })] }, { baseUrl: 'http://kapowarr.internal:5656' });
    expect(items[0]!.downstreamUrl).toBe('http://kapowarr.internal:5656');
  });

  it('skips a queue entry with no volume id', () => {
    const items = build({ queue: [queue({ volumeId: null as unknown as number })] });
    expect(items).toHaveLength(0);
  });
});

describe('parseKapowarrActivityRef — the wall-join + force-search dispatch target', () => {
  it('parses a kapowarr ref (the volume is the target)', () => {
    expect(parseKapowarrActivityRef('kapowarr:701')).toEqual({ volumeId: 701 });
  });
  it('returns null for a non-kapowarr ref', () => {
    expect(parseKapowarrActivityRef('arr:radarr:601')).toBeNull();
    expect(parseKapowarrActivityRef('books:ll:abc:ebook')).toBeNull();
    expect(parseKapowarrActivityRef('kapowarr:notanumber')).toBeNull();
  });
});

describe('resolveKapowarrBaseUrl', () => {
  it('prefers KAPOWARR_URL and falls back to the in-cluster default', () => {
    expect(resolveKapowarrBaseUrl({ KAPOWARR_URL: 'http://kapowarr.test:5656' })).toBe('http://kapowarr.test:5656');
    expect(resolveKapowarrBaseUrl({})).toContain('kapowarr.downloads.svc.cluster.local');
  });
});

describe('buildKapowarrActivityAdapter — the live fan-out seam', () => {
  function stubClient(over: Partial<KapowarrActivitySources> & { calls?: string[] }): KapowarrActivityReadClient {
    const calls = over.calls ?? [];
    return {
      async getQueue() {
        calls.push('getQueue');
        return over.queue ?? [];
      },
      async getDownloadHistory() {
        calls.push('getDownloadHistory');
        return over.history ?? [];
      },
      async getTasks() {
        calls.push('getTasks');
        return over.tasks ?? [];
      },
      async listVolumes() {
        calls.push('listVolumes');
        return over.volumes ?? [];
      },
    };
  }

  it('folds queue + history + tasks and SKIPS listVolumes when no search task is running (bounded reads)', async () => {
    const calls: string[] = [];
    const adapter = buildKapowarrActivityAdapter(
      stubClient({ queue: [queue({ volumeId: 770, status: 'failed', progress: null })], calls }),
      { now: () => NOW },
    );
    const items = await adapter.list();
    expect(adapter.source).toBe('kapowarr');
    expect(items[0]).toMatchObject({ id: 'kapowarr:770', stage: 'failed', failureKind: 'download_failed' });
    expect(calls).not.toContain('listVolumes'); // no search task ⇒ no volume page
  });

  it('pages listVolumes only when a search task is running (to compute `searching`)', async () => {
    const calls: string[] = [];
    const adapter = buildKapowarrActivityAdapter(
      stubClient({
        tasks: [{ action: 'auto_search', volumeId: 780, displayTitle: 's' } as KapowarrTask],
        volumes: [volume({ id: 780, issuesDownloaded: 0, title: 'Searching Vol' })],
        calls,
      }),
      { now: () => NOW },
    );
    const items = await adapter.list();
    expect(calls).toContain('listVolumes');
    expect(items[0]).toMatchObject({ id: 'kapowarr:780', stage: 'searching' });
  });

  it('propagates a read failure so the aggregator can degrade the source', async () => {
    const adapter = buildKapowarrActivityAdapter(
      {
        getQueue: async () => {
          throw new Error('kapowarr down');
        },
        getDownloadHistory: async () => [],
        getTasks: async () => [],
        listVolumes: async () => [],
      },
      { now: () => NOW },
    );
    await expect(adapter.list()).rejects.toThrow(/kapowarr down/);
  });
});
