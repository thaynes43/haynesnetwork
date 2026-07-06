// ADR-022 D-02 — executeArrAdd three-outcome matrix (embedded PG16 + fetch-stubbed radarr).
// Proves the Ledger bulk Add-&-search (reason 'ledger_add', searches ON): absent → add
// monitored + search on the NEW id (restored + search_requested events, tombstone cleared);
// present-but-unmonitored → PUT /movie/editor monitor-flip + search on the EXISTING id
// (search_requested only, monitored flipped locally, NO restored); present + monitored → skip.
// Plus: the 1000-item search cap rejects; and the restore wrapper keeps skip-if-present.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  SearchCapExceededError,
  buildArrClientBundle,
  executeArrAdd,
  executeRestore,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

interface RecordedCall {
  method: string;
  pathname: string;
  body: unknown;
}
interface StubRoute {
  method?: string;
  path: string | RegExp;
  status?: number;
  body?: unknown | ((url: URL) => unknown);
}

function stubBundle(routes: StubRoute[]): { bundle: ArrClientBundle; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({
      method,
      pathname: url.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  return {
    bundle: buildArrClientBundle({
      sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
      radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
      lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
      bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
    }),
    calls,
  };
}

const movieJson = (id: number, tmdbId: number, monitored: boolean) => ({
  id,
  title: `Movie ${tmdbId}`,
  sortTitle: `movie ${tmdbId}`,
  year: 2020,
  tmdbId,
  monitored,
  qualityProfileId: 1,
  rootFolderPath: '/movies',
  path: `/movies/Movie ${tmdbId}`,
  tags: [],
  hasFile: false,
  movieFileId: 0,
  sizeOnDisk: 0,
  statistics: { movieFileCount: 0 },
  minimumAvailability: 'released',
  status: 'released',
  isAvailable: true,
  added: '2025-01-01T00:00:00Z',
});

describe('executeArrAdd — Ledger bulk Add-&-search three outcomes (ADR-022 D-02)', () => {
  let t: TestDb;
  let userId: string;
  let absentId: string;
  let presentUnmonId: string;
  let presentMonId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    userId = (await createUser(t.db, { email: 'ledger-add@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        // absent from live radarr, unmonitored in the ledger (a Fileless-Set row) → add
        { arrItemId: 1, tmdbId: 700, title: 'Absent', sortTitle: 'absent', monitored: false, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
        // present but unmonitored in live radarr → monitor-flip
        { arrItemId: 2, tmdbId: 701, title: 'Present Unmon', sortTitle: 'present unmon', monitored: false, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
        // present + monitored → skip
        { arrItemId: 3, tmdbId: 702, title: 'Present Mon', sortTitle: 'present mon', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
      ],
    });
    const rows = await t.db.select().from(mediaItems).where(eq(mediaItems.arrKind, 'radarr'));
    absentId = rows.find((r) => r.tmdbId === 700)!.id;
    presentUnmonId = rows.find((r) => r.tmdbId === 701)!.id;
    presentMonId = rows.find((r) => r.tmdbId === 702)!.id;
    // The absent row is tombstoned (the deleted/fileless disaster case) so we can assert the
    // 'added' outcome clears the tombstone.
    await t.db
      .update(mediaItems)
      .set({ deletedFromArrAt: new Date() })
      .where(eq(mediaItems.id, absentId));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const eventsFor = async (id: string) =>
    (
      await t.db
        .select({ eventType: ledgerEvents.eventType })
        .from(ledgerEvents)
        .where(eq(ledgerEvents.mediaItemId, id))
    ).map((e) => e.eventType);

  it('adds absent, monitor-flips present-unmonitored, skips present-monitored, all searched', async () => {
    let addedSeq = 0;
    const stub = stubBundle([
      // live list: 701 (unmonitored) + 702 (monitored); 700 absent.
      { path: '/api/v3/movie', body: [movieJson(9701, 701, false), movieJson(9702, 702, true)] },
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/movies' }] },
      { path: '/api/v3/tag', body: [] },
      { method: 'POST', path: '/api/v3/movie', status: 201, body: () => movieJson(8000 + ++addedSeq, 700, true) },
      { method: 'PUT', path: '/api/v3/movie/editor', body: [] },
      { method: 'POST', path: '/api/v3/command', status: 201, body: (url: URL) => ({ id: 1, name: 'MoviesSearch', url: url.pathname }) },
    ]);

    const result = await executeArrAdd({
      db: t.db,
      arr: stub.bundle,
      arrKind: 'radarr',
      initiatedBy: userId,
      mediaItemIds: [absentId, presentUnmonId, presentMonId],
      reason: 'ledger_add',
      searchOnAdd: true,
    });

    expect(result.status).toBe('completed');
    expect(result.itemCount).toBe(2); // add + monitor (present-monitored is skipped, not counted)
    expect(result.successCount).toBe(2);

    const byId = new Map(result.results.map((r) => [r.mediaItemId, r]));
    expect(byId.get(absentId)).toMatchObject({ ok: true, outcome: 'added', searched: true });
    expect(byId.get(presentUnmonId)).toMatchObject({ ok: true, outcome: 'monitored', searched: true });
    expect(byId.get(presentMonId)).toMatchObject({ ok: false, skipped: true });
    expect(byId.get(presentMonId)!.error).toContain('already present and monitored');

    // The add POST fired for 700; the monitor PUT fired for the live id 9701.
    const addPosts = stub.calls.filter((c) => c.method === 'POST' && c.pathname === '/api/v3/movie');
    expect(addPosts).toHaveLength(1);
    expect((addPosts[0]!.body as { tmdbId: number; monitored: boolean })).toMatchObject({ tmdbId: 700, monitored: true });
    const editorPuts = stub.calls.filter((c) => c.method === 'PUT' && c.pathname === '/api/v3/movie/editor');
    expect(editorPuts).toHaveLength(1);
    expect(editorPuts[0]!.body).toMatchObject({ movieIds: [9701], monitored: true });
    // Two MoviesSearch commands (one per acted item).
    const commands = stub.calls.filter((c) => c.method === 'POST' && c.pathname === '/api/v3/command');
    expect(commands).toHaveLength(2);
    expect(commands.every((c) => (c.body as { name: string }).name === 'MoviesSearch')).toBe(true);

    // Events: added → restored + search_requested (tombstone cleared, arr id adopted).
    const absentEvents = await eventsFor(absentId);
    expect(absentEvents).toContain('restored');
    expect(absentEvents).toContain('search_requested');
    const [absentRow] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, absentId));
    expect(absentRow!.deletedFromArrAt).toBeNull();
    expect(absentRow!.arrItemId).toBeGreaterThan(8000);

    // Monitored → search_requested ONLY (no restored); monitored flipped locally.
    const monEvents = await eventsFor(presentUnmonId);
    expect(monEvents).toContain('search_requested');
    expect(monEvents).not.toContain('restored');
    const [monRow] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, presentUnmonId));
    expect(monRow!.monitored).toBe(true);

    // Skipped item wrote no ledger events.
    expect(await eventsFor(presentMonId)).toHaveLength(0);
  });

  it('rejects a searched run over the 1000-item cap before any *arr call', async () => {
    const stub = stubBundle([]);
    const tooMany = Array.from({ length: 1001 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await expect(
      executeArrAdd({
        db: t.db,
        arr: stub.bundle,
        arrKind: 'radarr',
        initiatedBy: userId,
        mediaItemIds: tooMany,
        reason: 'ledger_add',
        searchOnAdd: true,
      }),
    ).rejects.toBeInstanceOf(SearchCapExceededError);
    expect(stub.calls).toHaveLength(0); // nothing partial — thrown before any read/write
  });

  it('the restore wrapper keeps skip-if-present (never monitor-flips)', async () => {
    // A fresh radarr row, present-but-unmonitored in the live *arr.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 4, tmdbId: 800, title: 'Restore Present', sortTitle: 'restore present', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
      ],
    });
    const [row] = await t.db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.tmdbId, 800)));
    const stub = stubBundle([
      { path: '/api/v3/movie', body: [movieJson(9800, 800, false)] }, // present, unmonitored
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/movies' }] },
      { path: '/api/v3/tag', body: [] },
    ]);
    const result = await executeRestore({
      db: t.db,
      arr: stub.bundle,
      arrKind: 'radarr',
      initiatedBy: userId,
      mediaItemIds: [row!.id],
    });
    expect(result.results[0]).toMatchObject({ ok: false, skipped: true });
    expect(result.results[0]!.error).toContain('already present');
    // Restore NEVER touches the editor or a search command.
    expect(stub.calls.some((c) => c.pathname === '/api/v3/movie/editor')).toBe(false);
    expect(stub.calls.some((c) => c.pathname === '/api/v3/command')).toBe(false);
  });
});
