// ADR-023 / DESIGN-010 — Trash orchestrators (embedded PG16 + fetch-stubbed Maintainerr). Proves:
// the preflight audit's SAFE verdict; saveExclusion's PROTECTIVE ordering (external-then-event: a
// failed exclusion writes NO event) + idempotency; expedite's DESTRUCTIVE ordering (intent-first: a
// failed handle STILL leaves the trash_expedited event) + the SAFE gate refusal; the watch guardian
// window; the read-through pending merge + scheduled-delete derivation; recently-deleted from
// tombstones; and the music/Lidarr rejection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { ledgerEvents, mediaItems, notifications } from '@hnet/db/schema';
import {
  AGING_HORIZON_MIN_DAYS,
  LEAVING_SOON_COLLECTION_TITLES,
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  TrashMusicUnsupportedError,
  auditMaintainerr,
  buildMaintainerrClientBundle,
  classifyGuardian,
  evaluateAgingInvariants,
  expediteDeletion,
  guardRecentlyWatched,
  listNotifications,
  listRecentlyDeleted,
  listTrashPending,
  removeExclusion,
  restoreDeleted,
  saveExclusion,
  upsertTrashRule,
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
    /** ServarrAction (0=DELETE … 4=DO_NOTHING). Default 0 in the GET handler when omitted. */
    arrAction?: number;
    /** true for app-managed Leaving-Soon manual collections; default false (rule collection). */
    manualCollection?: boolean;
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
  /** rule groups GET /rules serves (the Rules tab's data). Default []. */
  rules: Array<Record<string, unknown>>;
  /** DESTRUCTIVE-hazard tracker: each PUT /rules that Maintainerr's `updateRules` would treat as a
   *  crucial-setting change (dataType/libraryId differs from the stored group → wipes collection media
   *  + specific exclusions + deletes the Plex collection). A correct isActive toggle produces none. */
  wipes: Array<{ ruleId: number; from: unknown; to: unknown }>;
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
    if (method === 'GET' && path === '/rules') return ok(state.rules);
    if (method === 'GET' && path === '/collections') {
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: c.isActive,
          deleteAfterDays: c.deleteAfterDays,
          arrAction: c.arrAction ?? 0,
          manualCollection: c.manualCollection ?? false,
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
    if ((method === 'PUT' || method === 'POST') && path === '/rules') {
      const dto = (body ?? {}) as {
        id?: unknown;
        rules?: unknown;
        dataType?: unknown;
        libraryId?: unknown;
        radarrSettingsId?: unknown;
        sonarrSettingsId?: unknown;
      };
      // (1) Faithful to Maintainerr updateRules/validateRule: it validates each rule as a DECODED
      // RuleDto (reads firstVal/action) and NEVER decodes ruleJson. A round-tripped DB entity (still
      // carrying a string `ruleJson`, no firstVal) fails validation → ReturnStatus {code:0}; decoded
      // rules pass. An EMPTY rules[] skips the loop (→ code:1), which is why the pre-fix e2e never
      // caught Bug 1. The confined write client fails closed on code:0 (P1a) → BAD_GATEWAY.
      const dtoRules = Array.isArray(dto.rules) ? (dto.rules as unknown[]) : [];
      const undecoded = dtoRules.some(
        (r) =>
          r !== null &&
          typeof r === 'object' &&
          typeof (r as { ruleJson?: unknown }).ruleJson === 'string',
      );
      if (undecoded) {
        return ok({ code: 0, result: 'First value is not available for this server' }, method === 'POST' ? 201 : 200);
      }
      // (2) validateRuleServerSelection: a rule referencing Radarr (Application.RADARR=1) or Sonarr
      // (=2) in firstVal[0]/lastVal[0] requires the matching GROUP-LEVEL server id (GET nests them
      // under `collection`, so a verbatim round-trip omits them → the live re-verify 502).
      const appIds = new Set<number>();
      for (const r of dtoRules) {
        if (r === null || typeof r !== 'object') continue;
        for (const v of [(r as { firstVal?: unknown }).firstVal, (r as { lastVal?: unknown }).lastVal]) {
          if (Array.isArray(v) && typeof v[0] === 'number') appIds.add(v[0]);
        }
      }
      if (appIds.has(1) && dto.radarrSettingsId == null) {
        return ok({ code: 0, result: 'Radarr rules require a Radarr server to be selected' }, method === 'POST' ? 201 : 200);
      }
      if (appIds.has(2) && dto.sonarrSettingsId == null) {
        return ok({ code: 0, result: 'Sonarr rules require a Sonarr server to be selected' }, method === 'POST' ? 201 : 200);
      }
      // (3) Crucial-change WIPE simulation (verified v3.17.0 updateRules): dataType or libraryId
      // differing from the stored group wipes the collection media + specific exclusions + deletes the
      // Plex collection. A correct isActive toggle carries both back VERBATIM ⇒ never fires.
      if (method === 'PUT' && typeof dto.id === 'number') {
        const stored = state.rules.find((r) => r.id === dto.id);
        if (
          stored !== undefined &&
          (('dataType' in dto && dto.dataType !== stored.dataType) ||
            ('libraryId' in dto && dto.libraryId !== stored.libraryId))
        ) {
          state.wipes.push({
            ruleId: dto.id,
            from: { dataType: stored.dataType, libraryId: stored.libraryId },
            to: { dataType: dto.dataType, libraryId: dto.libraryId },
          });
        }
      }
      return ok({ code: 1, result: 'Success' }, method === 'POST' ? 201 : 200);
    }
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
  rules: [],
  wipes: [],
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

describe('aging invariants (DESIGN-010 errata 2026-07-09 — Maintainerr self-delete safeguard)', () => {
  // --- the pure, unit-testable core ---
  it('flags a 60-day rule pool with the specific horizon reason', () => {
    const v = evaluateAgingInvariants([
      {
        title: 'hnet — unwatched low-value movies',
        isActive: true,
        deleteAfterDays: 60,
        arrAction: 0,
        manualCollection: false,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("Maintainerr would self-delete the 'hnet — unwatched low-value movies' pool");
    expect(v[0]).toContain('in 60 days');
    expect(v[0]).toContain('raise its delete-after horizon');
  });

  it('is clean once the rule pool horizon reaches AGING_HORIZON_MIN_DAYS (9999 >= 3650)', () => {
    expect(AGING_HORIZON_MIN_DAYS).toBe(3650);
    expect(
      evaluateAgingInvariants([
        { title: 'pool', isActive: true, deleteAfterDays: 9999, arrAction: 0, manualCollection: false },
      ]),
    ).toEqual([]);
    // Exactly at the threshold is safe; one day short is not.
    expect(
      evaluateAgingInvariants([
        { title: 'pool', isActive: true, deleteAfterDays: 3650, arrAction: 0, manualCollection: false },
      ]),
    ).toEqual([]);
    expect(
      evaluateAgingInvariants([
        { title: 'pool', isActive: true, deleteAfterDays: 3649, arrAction: 0, manualCollection: false },
      ]),
    ).toHaveLength(1);
  });

  it('reads a null/0 rule-pool horizon as imminent (no null guard in Maintainerr)', () => {
    for (const horizon of [null, 0]) {
      const v = evaluateAgingInvariants([
        { title: 'pool', isActive: true, deleteAfterDays: horizon, arrAction: 0, manualCollection: false },
      ]);
      expect(v[0]).toContain('imminently');
    }
  });

  it('flags a rule pool whose arrAction is not DELETE/0 (app can no longer manage deletions)', () => {
    const v = evaluateAgingInvariants([
      { title: 'pool', isActive: true, deleteAfterDays: 9999, arrAction: 3, manualCollection: false },
    ]);
    expect(v.some((m) => m.includes('arrAction 3') && m.includes('must be Delete/0'))).toBe(true);
  });

  it('flags an app-managed Leaving-Soon pool that is NOT Do-Nothing/4', () => {
    const v = evaluateAgingInvariants([
      {
        title: LEAVING_SOON_COLLECTION_TITLES.movie,
        isActive: true,
        deleteAfterDays: 0,
        arrAction: 0,
        manualCollection: true,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Leaving-Soon');
    expect(v[0]).toContain('outside the batch pipeline');
  });

  it('accepts a Leaving-Soon pool that IS Do-Nothing/4 (its short horizon is irrelevant)', () => {
    expect(
      evaluateAgingInvariants([
        {
          title: LEAVING_SOON_COLLECTION_TITLES.tv,
          isActive: true,
          deleteAfterDays: 0,
          arrAction: 4,
          manualCollection: true,
        },
      ]),
    ).toEqual([]);
  });

  it('ignores inactive collections entirely', () => {
    expect(
      evaluateAgingInvariants([
        { title: 'pool', isActive: false, deleteAfterDays: 1, arrAction: 0, manualCollection: false },
      ]),
    ).toEqual([]);
  });

  // --- end-to-end through auditMaintainerr → the SAFE gate ---
  const ruleColState = (deleteAfterDays: number) =>
    baseState({
      collections: [
        {
          id: 1,
          isActive: true,
          deleteAfterDays,
          arrAction: 0,
          type: 'movie',
          title: 'hnet — unwatched low-value movies',
          items: [],
        },
      ],
    });

  it('auditMaintainerr: a 60-day rule pool forces safe:false while integrations stay green', async () => {
    const { bundle } = makeMaintainerr(ruleColState(60));
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit.safe).toBe(false);
    // integrations are all fine — the aging invariant is the sole reason.
    expect(audit.integrations).toMatchObject({
      plex: true,
      radarr: true,
      sonarr: true,
      tautulli: true,
      seerr: true,
    });
    expect(audit.agingViolations).toHaveLength(1);
    expect(audit.agingViolations[0]).toContain('in 60 days');
  });

  it('auditMaintainerr: raising the same pool to 9999 is SAFE again', async () => {
    const { bundle } = makeMaintainerr(ruleColState(9999));
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit.safe).toBe(true);
    expect(audit.agingViolations).toEqual([]);
  });

  it('auditMaintainerr: a Leaving-Soon manual collection not set to Do-Nothing forces safe:false', async () => {
    const { bundle } = makeMaintainerr(
      baseState({
        collections: [
          {
            id: 1,
            isActive: true,
            deleteAfterDays: 9999,
            arrAction: 0,
            type: 'movie',
            title: 'hnet — unwatched low-value movies',
            items: [],
          },
          {
            id: 2,
            isActive: true,
            deleteAfterDays: 0,
            arrAction: 0, // WRONG — should be 4/DO_NOTHING
            manualCollection: true,
            type: 'movie',
            title: LEAVING_SOON_COLLECTION_TITLES.movie,
            items: [],
          },
        ],
      }),
    );
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit.safe).toBe(false);
    expect(audit.agingViolations.some((m) => m.includes('Leaving-Soon'))).toBe(true);
  });

  it('auditMaintainerr: a healthy estate (defused rule pool + Do-Nothing Leaving-Soon) is SAFE', async () => {
    const { bundle } = makeMaintainerr(
      baseState({
        collections: [
          {
            id: 1,
            isActive: true,
            deleteAfterDays: 9999,
            arrAction: 0,
            type: 'movie',
            title: 'hnet — unwatched low-value movies',
            items: [],
          },
          {
            id: 2,
            isActive: true,
            deleteAfterDays: 0,
            arrAction: 4,
            manualCollection: true,
            type: 'movie',
            title: LEAVING_SOON_COLLECTION_TITLES.movie,
            items: [],
          },
        ],
      }),
    );
    const audit = await auditMaintainerr({ maintainerr: bundle });
    expect(audit.safe).toBe(true);
    expect(audit.agingViolations).toEqual([]);
  });

  it('auditMaintainerr: a 60-day pool blocks the destructive expedite path (MaintainerrUnsafeError)', async () => {
    const { bundle } = makeMaintainerr(ruleColState(60));
    await expect(
      expediteDeletion({
        maintainerr: bundle,
        scope: 'all',
        media: 'movie',
        actorId: null,
        snapshotMediaIds: [],
      }),
    ).rejects.toBeInstanceOf(MaintainerrUnsafeError);
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
        {
          mediaItemId: watchedId,
          lastViewedAt: new Date(RECENT),
          lastWatchedAt: new Date(RECENT),
          lastWatchedServer: 'haynesops',
        },
        // PLAN-013 reclaim forward-capture: the cold item carries a resolution + ratings so the
        // expedite-freeze test can assert they land in the trash_expedited payload + notification.
        // DESIGN-010 D-12 — it is ALSO an ever-watched-but-not-recent item (watched 400d ago on
        // hayneskube): the watch-visibility pair flows to the wall, but it must remain sweep-deletable.
        {
          mediaItemId: coldId,
          lastViewedAt: new Date(OLD),
          lastWatchedAt: new Date(OLD),
          lastWatchedServer: 'hayneskube',
          resolution: '2160p',
          imdbRating: 8.5,
          tmdbRating: 7.9,
        },
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
          // Aging-safe horizon (>= AGING_HORIZON_MIN_DAYS) so the audit stays SAFE and the destructive
          // expedite paths in this block are exercised — the invariant itself is tested separately.
          deleteAfterDays: 9999,
          arrAction: 0,
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
      new Date(Date.parse('2026-06-01T00:00:00Z') + 9999 * 86_400_000).toISOString(),
    );
    const cold = res.items.find((i) => i.tmdbId === 8002)!;
    expect(cold.recentlyWatched).toBe(false);
    // DESIGN-010 D-12 — the watch-visibility pair rides the wire (snapshot carry-through) for BOTH
    // items: the cross-server MAX instant + its server, independent of the 30-day window.
    expect(watched.lastWatchedAt).toBe(RECENT);
    expect(watched.lastWatchedServer).toBe('haynesops');
    expect(cold.lastWatchedAt).toBe(OLD);
    expect(cold.lastWatchedServer).toBe('hayneskube');
  });

  it('D-12 — an ever-watched-but-not-recent item stays SWEEP-DELETABLE (info, not protection)', async () => {
    const { bundle } = makeMaintainerr(pendingState());
    const res = await listTrashPending({ db: t.db, maintainerr: bundle, media: 'movie' });
    const cold = res.items.find((i) => i.tmdbId === 8002)!;
    // It carries a last-watched signal (watched 400d ago) but is NOT recentlyWatched…
    expect(cold.lastWatchedAt).not.toBeNull();
    expect(cold.recentlyWatched).toBe(false);
    // …so the guardian does NOT keep it — it remains deletable. The recent item is kept as before.
    expect(classifyGuardian(cold)).toEqual({ keep: false });
    const watched = res.items.find((i) => i.tmdbId === 8001)!;
    expect(classifyGuardian(watched)).toEqual({ keep: true, reason: 'recently_watched' });
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
    const forItem = events.find(
      (e) => (e.payload as { maintainerrMediaId?: string }).maintainerrMediaId === 'ms-8002',
    );
    expect(forItem).toBeDefined();
    // PLAN-013 reclaim forward-capture — the direct-expedite path now FREEZES size/resolution/ratings
    // into the trash_expedited payload (previously only scope/collectionId/maintainerrMediaId).
    expect(forItem!.payload).toMatchObject({
      scope: 'item',
      sizeBytes: 2_000_000_000,
      resolution: '2160p',
      imdbRating: 8.5,
      tmdbRating: 7.9,
    });
    // …and into the app-sourced Activity notification payload (source 'trash').
    const [note] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.source, 'trash'));
    expect(note!.payload).toMatchObject({
      sizeBytes: 2_000_000_000,
      resolution: '2160p',
      imdbRating: 8.5,
      tmdbRating: 7.9,
    });
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

// Deletion-tracking fix (2026-07-07) — an app-initiated Expedite must be trackable from OUR durable
// records. ROOT CAUSE: listRecentlyDeleted read ONLY tombstoned media_items, but a per-item Maintainerr
// delete can remove the FILE while leaving the *arr entry — so sync never tombstones it (and would
// un-tombstone any value we wrote). The two owner-deleted titles thus wrote a `trash_expedited` event
// but were never tombstoned → invisible in Recently Deleted; and Maintainerr never webhooks our per-item
// handle → invisible in Activity. The fix: (1) listRecentlyDeleted ALSO surfaces items with a
// non-superseded `trash_expedited` event (branch B, the durable source); (2) expedite writes a
// source='trash' Activity notification same-tx carrying actor + title + size.
describe('expedite deletion audit — Recently Deleted + Activity (deletion-tracking fix)', () => {
  let t: TestDb;
  let actorId: string;
  const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'deleter@example.com', displayName: 'Tom Haynes' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 1, tmdbId: 8100, title: 'The Deadly Little Mermaid', sortTitle: 'deadly little mermaid', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies', sizeOnDisk: 1_400_000_000 },
      ],
    });
    const [row] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 8100));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [{ mediaItemId: row!.id, lastViewedAt: new Date(OLD) }],
    });
  });
  afterAll(async () => t?.stop());

  const coldState = () =>
    baseState({
      collections: [
        {
          id: 9,
          isActive: true,
          deleteAfterDays: 9999, // aging-safe (see pendingState note) — expedite must reach the delete
          arrAction: 0,
          type: 'movie',
          title: 'Least watched movies',
          items: [
            { mediaServerId: 'ms-8100', tmdbId: 8100, sizeBytes: 1_400_000_000, addDate: '2026-06-01T00:00:00Z' },
          ],
        },
      ],
    });

  it('surfaces an app-expedited deletion in Recently Deleted WITH actor + title, NOT tombstoned', async () => {
    // Sanity: no expedite yet AND not tombstoned ⇒ Recently Deleted is empty (the pre-fix bug state:
    // the item is still a live *arr entry, so a tombstone-only query would never surface it).
    expect(await listRecentlyDeleted({ db: t.db, media: 'movie' })).toHaveLength(0);

    const { bundle } = makeMaintainerr(coldState());
    const res = await expediteDeletion({
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId,
      item: { collectionId: 9, maintainerrMediaId: 'ms-8100' },
    });
    expect(res).toMatchObject({ expeditedCount: 1 });

    // The item is NOT tombstoned (sync owns deleted_from_arr_at; the *arr entry may still be live) —
    // yet it surfaces in Recently Deleted from the durable trash_expedited event (branch B).
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 8100));
    expect(item!.deletedFromArrAt).toBeNull();

    const deleted = await listRecentlyDeleted({ db: t.db, media: 'movie' });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      title: 'The Deadly Little Mermaid',
      deletedBy: 'Tom Haynes', // WHO — the attributed actor
      sizeOnDisk: 1_400_000_000,
    });
    expect(deleted[0]!.deletedAt).not.toBeNull(); // WHEN — the expedite time
  });

  it('same-tx Activity notification carries the actor + title + size', async () => {
    // An app-sourced Activity notification exists (source 'trash') attributed to the actor.
    const notes = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.source, 'trash'))
      .orderBy(desc(notifications.createdAt));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]).toMatchObject({
      source: 'trash',
      type: 'deleted',
      title: 'The Deadly Little Mermaid',
      actorUserId: actorId,
    });
    expect(notes[0]!.body).toContain('Tom Haynes');
    expect(notes[0]!.body).toContain('freed');

    // The Activity feed read (maintainerr + trash) returns the deletion.
    const feed = await listNotifications({ db: t.db, sources: ['maintainerr', 'trash'] });
    expect(feed.some((n) => n.title === 'The Deadly Little Mermaid')).toBe(true);
  });

  it('a later restore event supersedes the expedite ⇒ the item LEAVES Recently Deleted', async () => {
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 8100));
    // A restore event newer than the trash_expedited event (the executeRestore/restoreDeleted marker).
    await t.db.insert(ledgerEvents).values({
      mediaItemId: item!.id,
      eventType: 'trash_restored',
      source: 'maintainerr',
      occurredAt: new Date(Date.now() + 1000),
      payload: {},
    });
    const deleted = await listRecentlyDeleted({ db: t.db, media: 'movie' });
    expect(deleted.some((r) => r.tmdbId === 8100)).toBe(false);
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

// Live-repro fix (2026-07-06, plan-006 live validation) — Bug 1: the Rules-tab arm/disarm 502.
// GET /api/rules returns each group's rules[] as the DB ENTITY shape (RuleDbDto: an ENCODED `ruleJson`
// string), but PUT /api/rules validates each rule as a DECODED RuleDto (firstVal/action). Round-tripping
// the GET object verbatim makes Maintainerr's validateRule fail → ReturnStatus {code:0} → the write
// client's P1a hardening throws → BAD_GATEWAY. upsertTrashRule now decodes ruleJson → RuleDto first.
describe('upsertTrashRule — GET→PUT rule-shape reconciliation (Bug 1, live-repro fix)', () => {
  /** A rule group exactly as GET /api/rules returns it: rules[] carry an encoded `ruleJson`, NOT the
   *  decoded RuleDto fields PUT validates. Non-empty rules[] is what triggers the upstream failure. */
  const getShapedRule = () => ({
    id: 11,
    libraryId: 1,
    name: 'Purge stale movies',
    description: 'Unwatched 4K movies older than 90 days',
    isActive: true,
    arrAction: 0,
    useRules: true,
    dataType: 1,
    collection: { id: 7, deleteAfterDays: 30 },
    rules: [
      {
        id: 1,
        ruleGroupId: 11,
        section: 0,
        isActive: true,
        ruleJson: JSON.stringify({ operator: null, action: 0, firstVal: [0, 3], lastVal: [0, 4], section: 0 }),
      },
      {
        id: 2,
        ruleGroupId: 11,
        section: 0,
        isActive: true,
        // Plex-app value (firstVal[0]=0) so this decode-focused fixture never trips server selection.
        ruleJson: JSON.stringify({ operator: 1, action: 2, firstVal: [0, 0], customVal: { ruleTypeId: 0, value: '90' }, section: 0 }),
      },
    ],
  });

  it('FAIL-BEFORE: PUTting the raw GET shape (undecoded ruleJson) is rejected upstream (the live 502)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    // The pre-fix path handed the GET object straight to the confined write client.
    await expect(
      bundle.write.updateRuleGroup({ ...getShapedRule(), isActive: false }),
    ).rejects.toThrow(/logical failure|code 0/i);
  });

  it('PASS-AFTER: upsertTrashRule decodes ruleJson → RuleDto so the round-trip succeeds', async () => {
    const { bundle, calls } = makeMaintainerr(baseState());
    await expect(
      upsertTrashRule({ maintainerr: bundle, payload: { ...getShapedRule(), isActive: false } }),
    ).resolves.toBeUndefined();

    const put = calls.find((c) => c.method === 'PUT' && c.pathname === '/rules');
    expect(put).toBeDefined();
    const sent = put!.body as { id: number; isActive: boolean; rules: Array<Record<string, unknown>> };
    expect(sent).toMatchObject({ id: 11, isActive: false });
    expect(sent.rules).toHaveLength(2);
    for (const r of sent.rules) {
      // decoded RuleDto shape — the encoded string is gone; the fields updateRules validates are present.
      expect(r).not.toHaveProperty('ruleJson');
      expect(r).toHaveProperty('firstVal');
      expect(r).toHaveProperty('section');
    }
  });

  it('an EMPTY rules[] round-trips even undecoded (why the old rules: [] stub never caught it)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    await expect(
      upsertTrashRule({ maintainerr: bundle, payload: { id: 11, isActive: false, rules: [] } }),
    ).resolves.toBeUndefined();
  });

  it('leaves rules already in decoded RuleDto shape untouched (idempotent)', async () => {
    const { bundle, calls } = makeMaintainerr(baseState());
    const decoded = { operator: null, action: 0, firstVal: [0, 3], lastVal: [0, 4], section: 0 };
    await expect(
      upsertTrashRule({ maintainerr: bundle, payload: { id: 11, isActive: false, rules: [decoded] } }),
    ).resolves.toBeUndefined();
    const put = calls.find((c) => c.method === 'PUT' && c.pathname === '/rules')!;
    expect((put.body as { rules: unknown[] }).rules[0]).toMatchObject(decoded);
  });
});

// Live re-verification (2026-07-07, plan-006 staging) — the arm/disarm PUT still 502'd after Bug 1.
// GET /api/rules NESTS the *arr server ids under `collection`, but PUT (updateRules) reads them at the
// GROUP level for validateRuleServerSelection: a Radarr/Sonarr rule with no group-level id →
// {code:0,"Radarr rules require a Radarr server to be selected"} → the write client fails closed →
// 502. upsertTrashRule now lifts them up. HAZARD: updateRules ALSO treats a change to
// dataType/manualCollection/manualCollectionName/libraryId (vs the stored group) as a "crucial setting
// change" that WIPES the collection's media + specific exclusions and DELETES the Plex collection.
// Verified against v3.17.0 rules.service.ts: `dataType` (contracts MediaItemType) is a STRING union
// ('movie'|'show'|'season'|'episode') stored as varchar, `libraryId` is varchar — so a pure isActive
// toggle MUST carry both back VERBATIM. These tests lock the exact PUT body and prove no wipe fires.
describe('upsertTrashRule — group server selection + crucial-change safety (live re-verify 2026-07-07)', () => {
  // A movie rule EXACTLY as GET /api/rules serves it on v3.17.0: dataType the STRING 'movie', libraryId
  // a varchar string, the server ids NESTED under collection, and the rule references Radarr
  // (Application.RADARR === 1 in firstVal[0]) so PUT's validateRuleServerSelection actually applies.
  const getShapedRadarrRule = () => ({
    id: 11,
    libraryId: '1',
    name: 'Purge stale movies',
    description: 'Unwatched 4K movies older than 90 days',
    isActive: true,
    dataType: 'movie',
    collection: { id: 7, libraryId: '1', deleteAfterDays: 30, radarrSettingsId: 3, sonarrSettingsId: null },
    rules: [
      {
        id: 1,
        ruleGroupId: 11,
        section: 0,
        isActive: true,
        ruleJson: JSON.stringify({ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }),
      },
    ],
  });
  // Seed the stub with the stored baseline so the crucial-change comparison has something to diff.
  const storedState = () => baseState({ rules: [getShapedRadarrRule()] });

  it('FAIL-BEFORE: a decoded round-trip WITHOUT the group server id is rejected upstream (the live 502)', async () => {
    const { bundle } = makeMaintainerr(storedState());
    // Bug-1 fix applied (ruleJson decoded) but the server id NOT lifted — the pre-this-fix behaviour.
    const decodedButNoServerId = {
      ...getShapedRadarrRule(),
      isActive: false,
      rules: [{ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }],
    };
    await expect(bundle.write.updateRuleGroup(decodedButNoServerId)).rejects.toThrow(
      /Radarr rules require a Radarr server to be selected|logical failure|code 0/i,
    );
  });

  it('PASS-AFTER: upsertTrashRule lifts radarrSettingsId from the nested collection so the PUT succeeds', async () => {
    const { bundle, calls } = makeMaintainerr(storedState());
    await expect(
      upsertTrashRule({ maintainerr: bundle, payload: { ...getShapedRadarrRule(), isActive: false } }),
    ).resolves.toBeUndefined();
    const put = calls.find((c) => c.method === 'PUT' && c.pathname === '/rules')!;
    expect((put.body as { radarrSettingsId?: unknown }).radarrSettingsId).toBe(3);
  });

  it('HAZARD: the PUT body carries dataType/libraryId VERBATIM (never coerced) ⇒ NO crucial-change wipe', async () => {
    const state = storedState();
    const { bundle, calls } = makeMaintainerr(state);
    await upsertTrashRule({ maintainerr: bundle, payload: { ...getShapedRadarrRule(), isActive: false } });
    const put = calls.find((c) => c.method === 'PUT' && c.pathname === '/rules')!;
    const sent = put.body as Record<string, unknown>;
    const canonical = getShapedRadarrRule();
    // The exact GET-derived canonical representation — the string 'movie' and the string '1', NOT numbers.
    // If any normalization coerced these, updateRules would see a crucial change and WIPE the collection.
    expect(sent.dataType).toBe('movie');
    expect(sent.dataType).toBe(canonical.dataType);
    expect(sent.libraryId).toBe('1');
    expect(sent.libraryId).toBe(canonical.libraryId);
    expect(state.wipes).toHaveLength(0); // matched the stored group ⇒ no crucial change, no wipe
  });

  it('the wipe detector actually fires on a coerced dataType (proves the no-wipe assertion is real)', async () => {
    // Directly PUT a COERCED numeric dataType (the regression this guards against) and confirm the stub
    // flags + would have enacted the crucial-change wipe — so the PASS tests are a real safety net.
    const state = storedState();
    const { bundle } = makeMaintainerr(state);
    await bundle.write.updateRuleGroup({
      ...getShapedRadarrRule(),
      isActive: false,
      dataType: 1, // WRONG: a number instead of the stored string 'movie' → crucial change → WIPE
      radarrSettingsId: 3,
      rules: [{ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }],
    });
    expect(state.wipes).toHaveLength(1);
    expect(state.wipes[0]).toMatchObject({ ruleId: 11, to: { dataType: 1 } });
  });
});

// Live-repro fix (2026-07-06) — Bug 2: a Maintainerr exclusion made OUTSIDE this session must show as
// Protected in the pending list before its `dnd` tag round-trips into arrTags. listTrashPending with
// `includeLiveExclusions` consults the live exclusion set (per-item mediaServerId reads) and sets
// `protectedByExclusion`, which the UI ORs with protectedByTag.
describe('listTrashPending — live exclusion reflected in the pending list (Bug 2, live-repro fix)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
    // A cold, ledger-known movie with NO dnd tag (arrTags empty) — protectedByTag stays false.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 91, tmdbId: 9101, title: 'Excluded Elsewhere', sortTitle: 'excluded elsewhere', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies', arrTags: [] },
      ],
    });
  });
  afterAll(async () => t?.stop());

  const oneItemState = (over: Partial<MaintState> = {}) =>
    baseState({
      collections: [
        {
          id: 7,
          isActive: true,
          deleteAfterDays: 30,
          type: 'movie',
          title: 'Least watched movies',
          items: [{ mediaServerId: 'ms-9101', tmdbId: 9101, sizeBytes: 1_000_000_000, addDate: '2026-06-01T00:00:00Z' }],
        },
      ],
      ...over,
    });

  it('protectedByExclusion is TRUE for a live-excluded item (tag not yet synced) when opted in', async () => {
    const { bundle, calls } = makeMaintainerr(oneItemState({ exclusions: new Set(['ms-9101']) }));
    const res = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      includeLiveExclusions: true,
    });
    const item = res.items.find((i) => i.maintainerrMediaId === 'ms-9101')!;
    expect(item.protectedByTag).toBe(false); // no dnd tag synced
    expect(item.protectedByExclusion).toBe(true); // but live-excluded ⇒ Protected
    // the live exclusion set was consulted (per-item mediaServerId read — no bulk endpoint exists).
    expect(calls.some((c) => c.method === 'GET' && c.pathname === '/rules/exclusion' && c.query.mediaServerId === 'ms-9101')).toBe(true);
  });

  it('protectedByExclusion is FALSE when the item is NOT live-excluded', async () => {
    const { bundle } = makeMaintainerr(oneItemState());
    const res = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      includeLiveExclusions: true,
    });
    expect(res.items[0]!.protectedByExclusion).toBe(false);
  });

  it('does NOT read the exclusion list when includeLiveExclusions is off (internal expedite/guardian path)', async () => {
    const { bundle, calls } = makeMaintainerr(oneItemState({ exclusions: new Set(['ms-9101']) }));
    const res = await listTrashPending({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(res.items[0]!.protectedByExclusion).toBe(false);
    expect(calls.some((c) => c.pathname === '/rules/exclusion')).toBe(false);
  });
});
