// ADR-023 / DESIGN-010 — Trash orchestrators (embedded PG16 + fetch-stubbed Maintainerr). Proves:
// the preflight audit's SAFE verdict; saveExclusion's PROTECTIVE ordering (external-then-event: a
// failed exclusion writes NO event) + idempotency; expedite's DESTRUCTIVE ordering (intent-first: a
// failed handle STILL leaves the trash_expedited event) + the SAFE gate refusal; the watch guardian
// window; the read-through pending merge + scheduled-delete derivation; recently-deleted from
// tombstones; and the music/Lidarr rejection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  TrashMusicUnsupportedError,
  auditMaintainerr,
  buildMaintainerrClientBundle,
  expediteDeletion,
  guardRecentlyWatched,
  listRecentlyDeleted,
  listTrashPending,
  removeExclusion,
  restoreDeleted,
  saveExclusion,
  tombstoneMissingItems,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  type MaintainerrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

interface RecordedCall {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

interface MaintState {
  integrations: { radarr: boolean; sonarr: boolean; tautulli: boolean; seerr: boolean };
  plexOk: boolean;
  reachable: boolean;
  exclusions: Set<string>; // mediaServerIds currently excluded
  collections: Array<{
    id: number;
    isActive: boolean;
    deleteAfterDays: number;
    type: string;
    title: string;
    items: Array<{
      mediaServerId: string;
      tmdbId?: number;
      tvdbId?: number;
      sizeBytes: number;
      addDate: string;
    }>;
  }>;
  /** force a 500 on these `METHOD /path` keys (e.g. 'POST /rules/exclusion'). */
  fail: Set<string>;
  /** force a Maintainerr LOGICAL failure (HTTP 201 + ReturnStatus `{code:0}`) on these `METHOD /path`
   *  keys — the P1a in-band failure that HTTP-status-only reads used to miss. */
  logicalFail: Set<string>;
}

function makeMaintainerr(state: MaintState): {
  bundle: MaintainerrClientBundle;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: path, query, body });

    if (!state.reachable) return new Response('unreachable', { status: 502 });
    const key = `${method} ${path}`;
    if (state.fail.has(key)) {
      return new Response(JSON.stringify({ message: 'forced failure' }), { status: 500 });
    }
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    // P1a — a Maintainerr WRITE that returns HTTP 201 but a ReturnStatus `{code:0}` (logical failure,
    // e.g. setExclusion 'Failed - no metadata'). The write client must fail closed on this.
    if (state.logicalFail.has(key)) {
      return ok({ code: 0, result: 'Failed - no metadata', message: 'Failed - no metadata' }, 201);
    }

    // ---- reads ----
    if (method === 'GET' && path === '/app/status') {
      return ok({ status: 'ok', version: '3.17.0' });
    }
    if (method === 'GET' && path === '/settings/test/plex') {
      return ok({ status: state.plexOk ? 'OK' : 'NOK', code: state.plexOk ? 1 : 0, message: 'x' });
    }
    if (method === 'GET' && path === '/rules/constants') {
      const apps: Array<{ name: string }> = [];
      if (state.integrations.radarr) apps.push({ name: 'Radarr' });
      if (state.integrations.sonarr) apps.push({ name: 'Sonarr' });
      if (state.integrations.tautulli) apps.push({ name: 'Tautulli' });
      if (state.integrations.seerr) apps.push({ name: 'Overseerr' });
      return ok({ applications: apps });
    }
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections') {
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: c.isActive,
          deleteAfterDays: c.deleteAfterDays,
          type: c.type,
          title: c.title,
          media: [],
        })),
      );
    }
    const contentMatch = path.match(/^\/collections\/media\/(\d+)\/content\/(\d+)$/);
    if (method === 'GET' && contentMatch) {
      const cid = Number(contentMatch[1]);
      const col = state.collections.find((c) => c.id === cid);
      const items = col?.items ?? [];
      return ok({ totalSize: items.length, items });
    }
    if (method === 'GET' && path === '/rules/exclusion') {
      const id = query.mediaServerId;
      const present = id !== undefined && state.exclusions.has(id);
      return ok(present ? [{ id: 1, mediaServerId: id, ruleGroupId: null }] : []);
    }
    // ---- writes ----
    if (method === 'POST' && path === '/rules/exclusion') {
      state.exclusions.add(String((body as { mediaId: string }).mediaId));
      return ok({ code: 1 }, 201);
    }
    const rmMatch = path.match(/^\/rules\/exclusions\/(.+)$/);
    if (method === 'DELETE' && rmMatch) {
      state.exclusions.delete(decodeURIComponent(rmMatch[1]!));
      return ok({ code: 1 });
    }
    if (method === 'POST' && path === '/collections/handle') return ok(null, 201);
    if (method === 'POST' && path === '/collections/media/handle') return ok(null, 201);
    return new Response(JSON.stringify({ message: `no stub for ${key}` }), { status: 404 });
  }) as typeof fetch;

  return {
    bundle: buildMaintainerrClientBundle({
      baseUrl: 'http://maintainerr.test:6246',
      apiKey: 'k',
      retryDelayMs: 0,
      fetchImpl,
    }),
    calls,
  };
}

const baseState = (over: Partial<MaintState> = {}): MaintState => ({
  integrations: { radarr: true, sonarr: true, tautulli: true, seerr: true },
  plexOk: true,
  reachable: true,
  exclusions: new Set(),
  collections: [],
  fail: new Set(),
  logicalFail: new Set(),
  ...over,
});

describe('auditMaintainerr (ADR-023 D-04)', () => {
  it('SAFE when reachable + Plex OK + every required integration configured', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit).toMatchObject({
      safe: true,
      reachable: true,
      version: '3.17.0',
      integrations: { plex: true, radarr: true, sonarr: true, tautulli: true, seerr: true },
    });
  });

  it('UNSAFE when a required integration (radarr) is down', async () => {
    const { bundle } = makeMaintainerr(
      baseState({ integrations: { radarr: false, sonarr: true, tautulli: true, seerr: true } }),
    );
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit.safe).toBe(false);
    expect(audit.integrations.radarr).toBe(false);
  });

  it('UNSAFE + reachable false when the instance is unreachable', async () => {
    const { bundle } = makeMaintainerr(baseState({ reachable: false }));
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit).toMatchObject({ safe: false, reachable: false });
  });
});

describe('saveExclusion / removeExclusion (ADR-023 D-05 protective ordering)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'trash-save@example.com' })).id;
  });
  afterAll(async () => t?.stop());

  const excludeEvents = () =>
    t.db.select().from(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_excluded'));

  it('excludes then records a trash_excluded event (source maintainerr)', async () => {
    const { bundle, calls } = makeMaintainerr(baseState());
    const res = await saveExclusion({
      db: t.db,
      maintainerr: bundle,
      maintainerrMediaId: '5001',
      actorId,
    });
    expect(res).toEqual({ excluded: true, alreadyExcluded: false });
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/rules/exclusion')).toBe(true);
    const events = await excludeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'maintainerr' });
    expect(events[0]!.payload).toMatchObject({ action: 'save', maintainerrMediaId: '5001' });
  });

  it('is idempotent — already excluded ⇒ no POST, no event', async () => {
    const state = baseState({ exclusions: new Set(['9999']) });
    const { bundle, calls } = makeMaintainerr(state);
    const res = await saveExclusion({
      db: t.db,
      maintainerr: bundle,
      maintainerrMediaId: '9999',
      actorId,
    });
    expect(res).toEqual({ excluded: false, alreadyExcluded: true });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // Still just the one event from the previous test.
    expect(await excludeEvents()).toHaveLength(1);
  });

  it('a FAILED exclusion writes NO event (protective ordering — never a phantom protection)', async () => {
    const state = baseState({ fail: new Set(['POST /rules/exclusion']) });
    const { bundle } = makeMaintainerr(state);
    await expect(
      saveExclusion({ db: t.db, maintainerr: bundle, maintainerrMediaId: '7777', actorId }),
    ).rejects.toBeInstanceOf(MaintainerrUpstreamError);
    // No new event for 7777.
    const events = await excludeEvents();
    expect(events.some((e) => (e.payload as { maintainerrMediaId?: string }).maintainerrMediaId === '7777')).toBe(
      false,
    );
  });

  it('P1a — a Maintainerr in-band failure (201 + code:0) fails CLOSED: throws + writes NO event', async () => {
    // setExclusion returns HTTP 201 with {code:0,'Failed - no metadata'} — a LOGICAL failure the old
    // requestVoid (HTTP-status-only) read as success → phantom trash_excluded + phantom protection.
    const state = baseState({ logicalFail: new Set(['POST /rules/exclusion']) });
    const { bundle } = makeMaintainerr(state);
    await expect(
      saveExclusion({ db: t.db, maintainerr: bundle, maintainerrMediaId: '6006', actorId }),
    ).rejects.toBeInstanceOf(MaintainerrUpstreamError);
    // The item is NOT actually excluded, and no phantom protection event was written.
    expect(state.exclusions.has('6006')).toBe(false);
    const events = await excludeEvents();
    expect(
      events.some(
        (e) => (e.payload as { maintainerrMediaId?: string }).maintainerrMediaId === '6006',
      ),
    ).toBe(false);
  });

  it('removeExclusion removes then records an unsave event; no-op when not excluded', async () => {
    const state = baseState({ exclusions: new Set(['5001']) });
    const { bundle, calls } = makeMaintainerr(state);
    const res = await removeExclusion({
      db: t.db,
      maintainerr: bundle,
      maintainerrMediaId: '5001',
      actorId,
    });
    expect(res).toEqual({ removed: true });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);

    // Not excluded ⇒ no-op.
    const { bundle: b2, calls: c2 } = makeMaintainerr(baseState());
    const res2 = await removeExclusion({ db: t.db, maintainerr: b2, maintainerrMediaId: '404', actorId });
    expect(res2).toEqual({ removed: false });
    expect(c2.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('listTrashPending + guardian + expedite (ADR-023 D-02/D-04/D-05)', () => {
  let t: TestDb;
  let actorId: string;
  const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 days ago
  const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'trash-exp@example.com' })).id;
    // Two radarr rows: 8001 recently watched, 8002 cold.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 1, tmdbId: 8001, title: 'Watched Movie', sortTitle: 'watched movie', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
        { arrItemId: 2, tmdbId: 8002, title: 'Cold Movie', sortTitle: 'cold movie', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
      ],
    });
    const rows = await t.db.select().from(mediaItems).where(eq(mediaItems.arrKind, 'radarr'));
    const watchedId = rows.find((r) => r.tmdbId === 8001)!.id;
    const coldId = rows.find((r) => r.tmdbId === 8002)!.id;
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        { mediaItemId: watchedId, lastViewedAt: new Date(RECENT) },
        { mediaItemId: coldId, lastViewedAt: new Date(OLD) },
      ],
    });
  });
  afterAll(async () => t?.stop());

  const pendingState = () =>
    baseState({
      collections: [
        {
          id: 7,
          isActive: true,
          deleteAfterDays: 30,
          type: 'movie',
          title: 'Least watched movies',
          items: [
            { mediaServerId: 'ms-8001', tmdbId: 8001, sizeBytes: 1_000_000_000, addDate: '2026-06-01T00:00:00Z' },
            { mediaServerId: 'ms-8002', tmdbId: 8002, sizeBytes: 2_000_000_000, addDate: '2026-06-01T00:00:00Z' },
          ],
        },
      ],
    });

  it('merges Maintainerr media with our ledger + computes scheduled-delete + total size', async () => {
    const { bundle } = makeMaintainerr(pendingState());
    const res = await listTrashPending({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(res.count).toBe(2);
    expect(res.totalSizeBytes).toBe(3_000_000_000);
    const watched = res.items.find((i) => i.tmdbId === 8001)!;
    expect(watched.title).toBe('Watched Movie');
    expect(watched.recentlyWatched).toBe(true);
    expect(watched.scheduledDeleteAt).toBe(
      new Date(Date.parse('2026-06-01T00:00:00Z') + 30 * 86_400_000).toISOString(),
    );
    const cold = res.items.find((i) => i.tmdbId === 8002)!;
    expect(cold.recentlyWatched).toBe(false);
  });

  it('guardRecentlyWatched auto-protects the recently-watched item, leaves the cold one expeditable', async () => {
    const state = pendingState();
    const { bundle } = makeMaintainerr(state);
    const guard = await guardRecentlyWatched({ db: t.db, maintainerr: bundle, media: 'movie', actorId });
    expect(guard.protectedIds).toContain('ms-8001');
    expect(guard.expeditableIds).toContain('ms-8002');
    expect(state.exclusions.has('ms-8001')).toBe(true); // auto-whitelisted
  });

  it('expedite REFUSES when the audit is unsafe (MaintainerrUnsafeError)', async () => {
    const state = pendingState();
    state.integrations.sonarr = false; // required integration down
    const { bundle } = makeMaintainerr(state);
    await expect(
      expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        scope: 'all',
        media: 'movie',
        actorId,
      }),
    ).rejects.toBeInstanceOf(MaintainerrUnsafeError);
  });

  it('expedite scope=item on a recently-watched target PROTECTS instead of deleting', async () => {
    const state = pendingState();
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId,
      item: { collectionId: 7, maintainerrMediaId: 'ms-8001' },
    });
    expect(res).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
    expect(state.exclusions.has('ms-8001')).toBe(true);
  });

  it('expedite scope=item on a cold target commits the intent event BEFORE the handle call', async () => {
    const state = pendingState();
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId,
      item: { collectionId: 7, maintainerrMediaId: 'ms-8002' },
    });
    expect(res).toMatchObject({ protectedCount: 0, expeditedCount: 1 });
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(true);
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_expedited'));
    expect(events.some((e) => (e.payload as { maintainerrMediaId?: string }).maintainerrMediaId === 'ms-8002')).toBe(true);
  });

  it('a FAILED handle STILL leaves the trash_expedited intent event (destructive ordering)', async () => {
    const state = pendingState();
    state.fail.add('POST /collections/media/handle');
    const { bundle } = makeMaintainerr(state);
    await expect(
      expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        scope: 'item',
        media: 'movie',
        actorId,
        // ms-8002 is cold, so it reaches the handle call (which fails).
        item: { collectionId: 7, maintainerrMediaId: 'ms-8002' },
      }),
    ).rejects.toBeInstanceOf(MaintainerrUpstreamError);
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_expedited'));
    // At least two intent events for ms-8002 now (the prior success + this failed attempt).
    const forItem = events.filter(
      (e) => (e.payload as { maintainerrMediaId?: string }).maintainerrMediaId === 'ms-8002',
    );
    expect(forItem.length).toBeGreaterThanOrEqual(2);
  });

  it('P1b/P5 — expedite scope=all loops PER ITEM (never /collections/handle) + guards each', async () => {
    const state = pendingState();
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId,
    });
    // The watched item is whitelisted; the cold one is deleted individually.
    expect(res).toMatchObject({ scope: 'all', protectedCount: 1, expeditedCount: 1 });
    expect(state.exclusions.has('ms-8001')).toBe(true); // watched → auto-whitelisted
    // The estate-wide handler is NEVER called (it would delete beyond the user's media kind/ledger).
    expect(calls.some((c) => c.pathname === '/collections/handle')).toBe(false);
    // The cold survivor is deleted via the per-item handler, scoped to exactly what was seen.
    const perItem = calls.filter((c) => c.pathname === '/collections/media/handle');
    expect(perItem).toHaveLength(1);
    expect((perItem[0]!.body as { mediaId?: string }).mediaId).toBe('ms-8002');
  });

  it('P3 — expediteItem with a WRONG media param still protects the watched item (no bypass)', async () => {
    const state = pendingState();
    const { bundle, calls } = makeMaintainerr(state);
    // ms-8001 is a recently-watched MOVIE; the caller lies with media:'tv'. Old code searched the tv
    // pending set, did not find the target, skipped the guardian and DELETED it. Now the target's
    // real identity is resolved from the actual pending set and the guardian protects it.
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'tv',
      actorId,
      item: { collectionId: 7, maintainerrMediaId: 'ms-8001' },
    });
    expect(res).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
    expect(state.exclusions.has('ms-8001')).toBe(true);
  });

  it('P4 — expedite scope=all SKIPS an item unknown to our ledger (cannot evaluate ⇒ never delete)', async () => {
    const state = pendingState();
    // Add a third collection item with a tmdbId absent from our ledger ⇒ mediaItemId null ⇒
    // the guardian cannot positively clear it. It must be skipped, never deleted.
    state.collections[0]!.items.push({
      mediaServerId: 'ms-8003',
      tmdbId: 8003,
      sizeBytes: 500_000_000,
      addDate: '2026-06-01T00:00:00Z',
    });
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId,
    });
    expect(res.skippedCount).toBeGreaterThanOrEqual(1);
    const handled = calls
      .filter((c) => c.pathname === '/collections/media/handle')
      .map((c) => (c.body as { mediaId?: string }).mediaId);
    expect(handled).toContain('ms-8002'); // the cold, ledger-known item is deleted
    expect(handled).not.toContain('ms-8003'); // the unevaluable item is never deleted
  });

  // F1 (2026-07-06 pre-ship review) — the LIVE-exclusion safety seam. classifyGuardian reads only
  // the synced facets, so a just-SAVED item (exclusion set, but dnd tag not yet synced ⇒
  // protectedByTag still false) would be cleared as cold and DELETED. Expedite must consult the live
  // Maintainerr exclusion set and PROTECT it instead — the save→expedite race the review found.
  it('F1 — a LIVE Maintainerr exclusion PROTECTS a cold item (scope item), never handled', async () => {
    const state = pendingState();
    state.exclusions.add('ms-8002'); // saved just now; dnd tag has NOT synced (protectedByTag false)
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId,
      item: { collectionId: 7, maintainerrMediaId: 'ms-8002' },
    });
    expect(res).toMatchObject({ protectedCount: 1, expeditedCount: 0, skippedCount: 0 });
    // NEVER handed to the per-item delete handler.
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
  });

  it('F1 — a LIVE exclusion PROTECTS a cold item in scope all, never handled', async () => {
    const state = pendingState();
    state.exclusions.add('ms-8002');
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId,
      snapshotMediaIds: ['ms-8001', 'ms-8002'],
    });
    expect(res.expeditedCount).toBe(0);
    // ms-8002 live-excluded + ms-8001 watched-whitelisted ⇒ both protected; nothing deleted.
    expect(res.protectedCount).toBe(2);
    expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(0);
  });

  // F2 (2026-07-06 pre-ship review) — scope 'all' is pinned to the snapshot the user SAW.
  it('F2 — scope all processes ONLY the snapshot ∩ pending: stale ids counted, newly-pending untouched', async () => {
    const state = pendingState(); // pending now: ms-8001 (watched), ms-8002 (cold)
    const { bundle, calls } = makeMaintainerr(state);
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId,
      // The user saw ms-8002 (cold) + a stale id no longer pending. They did NOT see ms-8001.
      snapshotMediaIds: ['ms-8002', 'ms-gone'],
    });
    expect(res.expeditedCount).toBe(1); // only the SEEN cold item
    expect(res.stalePending).toBe(1); // ms-gone was in the snapshot but no longer pending
    const handled = calls
      .filter((c) => c.pathname === '/collections/media/handle')
      .map((c) => (c.body as { mediaId?: string }).mediaId);
    expect(handled).toEqual(['ms-8002']);
    // ms-8001 became pending but was NOT in the snapshot ⇒ never touched (not whitelisted, not deleted).
    expect(state.exclusions.has('ms-8001')).toBe(false);
  });
});

describe('listRecentlyDeleted + restore music rejection (ADR-023 D-02 / R-87)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 1, tmdbId: 9001, title: 'Deleted Movie', sortTitle: 'deleted movie', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies', sizeOnDisk: 4200 },
      ],
    });
    await tombstoneMissingItems({ db: t.db, arrKind: 'radarr', seenArrItemIds: [] });
  });
  afterAll(async () => t?.stop());

  it('lists tombstoned rows as recently-deleted (newest first)', async () => {
    const rows = await listRecentlyDeleted({ db: t.db, media: 'movie' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Deleted Movie', arrKind: 'radarr', sizeOnDisk: 4200 });
    expect(rows[0]!.deletedAt).not.toBeNull();
  });

  it('restoreDeleted refuses a music (Lidarr) target (R-87)', async () => {
    await expect(
      restoreDeleted({
        db: t.db,
        // arr bundle is never reached — the kind guard throws first.
        arr: undefined as never,
        arrKind: 'lidarr',
        mediaItemId: '00000000-0000-0000-0000-000000000000',
        actorId: null,
      }),
    ).rejects.toBeInstanceOf(TrashMusicUnsupportedError);
  });
});
