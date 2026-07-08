// ADR-023 / DESIGN-010 — the trash router: section + per-action gating matrix and the happy paths
// (pending merge, save exclusion, unsafe-expedite refusal, activity). Embedded PG16 + a
// fetch-stubbed Maintainerr bundle. The gates read the session (server-authoritative, AC-13), so
// gating cases only need session overrides; the write paths exercise the domain + stub.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  buildMaintainerrClientBundle,
  upsertMediaItemsBatch,
  type MaintainerrClientBundle,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  wireShape,
  type TestDb,
} from './helpers';

interface MaintState {
  safe: boolean;
  exclusions: Set<string>;
  collections: Array<{
    id: number;
    isActive: boolean;
    deleteAfterDays: number;
    type: string;
    title: string;
    items: Array<{ mediaServerId: string; tmdbId?: number; sizeBytes: number; addDate: string }>;
  }>;
  /** rule groups GET /rules serves (the Rules tab's data); default []. */
  rules: Array<Record<string, unknown>>;
}

function stubMaintainerr(state: MaintState): MaintainerrClientBundle {
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const q = Object.fromEntries(url.searchParams.entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.17.0' });
    if (method === 'GET' && path === '/settings/test/plex')
      return ok({ status: state.safe ? 'OK' : 'NOK', code: 1 });
    if (method === 'GET' && path === '/rules/constants')
      return ok({
        applications: state.safe
          ? [{ name: 'Radarr' }, { name: 'Sonarr' }, { name: 'Tautulli' }, { name: 'Overseerr' }]
          : [{ name: 'Sonarr' }],
      });
    if (method === 'GET' && path === '/rules') return ok(state.rules);
    if (method === 'GET' && path === '/collections')
      return ok(state.collections.map((c) => ({ ...c, media: [] })));
    const cm = path.match(/^\/collections\/media\/(\d+)\/content\/(\d+)$/);
    if (method === 'GET' && cm) {
      const col = state.collections.find((c) => c.id === Number(cm[1]));
      const items = col?.items ?? [];
      return ok({ totalSize: items.length, items });
    }
    if (method === 'GET' && path === '/rules/exclusion') {
      const id = q.mediaServerId;
      return ok(id !== undefined && state.exclusions.has(id) ? [{ id: 1, mediaServerId: id }] : []);
    }
    if (method === 'POST' && path === '/rules/exclusion') {
      state.exclusions.add(String((body as { mediaId: string }).mediaId));
      return ok({ code: 1 }, 201);
    }
    if (method === 'POST' && path === '/collections/handle') return ok(null, 201);
    if (method === 'POST' && path === '/collections/media/handle') return ok(null, 201);
    if ((method === 'PUT' || method === 'POST') && path === '/rules') {
      // Faithful to Maintainerr updateRules/validateRule: rules[] must be the DECODED RuleDto shape
      // (it never decodes ruleJson). A round-tripped DB entity (still carrying `ruleJson`) fails →
      // ReturnStatus {code:0} → the write client fails closed → BAD_GATEWAY. Decoded rules pass.
      const dtoRules = Array.isArray((body as { rules?: unknown }).rules)
        ? (body as { rules: unknown[] }).rules
        : [];
      const undecoded = dtoRules.some(
        (r) => r !== null && typeof r === 'object' && typeof (r as { ruleJson?: unknown }).ruleJson === 'string',
      );
      if (undecoded) return ok({ code: 0, result: 'First value is not available for this server' }, 200);
      const dto = body as { id?: unknown };
      if (method === 'PUT' && typeof dto.id === 'number') {
        state.rules = state.rules.map((r) => (r.id === dto.id ? { ...r, ...(body as object) } : r));
      }
      return ok({ code: 1, result: 'Success' }, method === 'POST' ? 201 : 200);
    }
    return new Response(JSON.stringify({ message: `no stub ${method} ${path}` }), { status: 404 });
  }) as typeof fetch;
  return buildMaintainerrClientBundle({
    baseUrl: 'http://maintainerr.test:6246',
    apiKey: 'k',
    retryDelayMs: 0,
    fetchImpl,
  });
}

const state = (over: Partial<MaintState> = {}): MaintState => ({
  safe: true,
  exclusions: new Set(),
  rules: [],
  collections: [
    {
      id: 7,
      isActive: true,
      deleteAfterDays: 30,
      type: 'movie',
      title: 'Least watched',
      items: [{ mediaServerId: 'ms-1', tmdbId: 55001, sizeBytes: 1_000_000_000, addDate: '2026-06-01T00:00:00Z' }],
    },
  ],
  ...over,
});

describe('trash router — section + per-action gating (ADR-023 C-03)', () => {
  let t: TestDb;
  let userRow: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    userRow = await createUser(t.db, { email: 'trash-gate@example.com' });
  });
  afterAll(async () => t?.stop());

  const call = (
    sectionLevel: 'edit' | 'read_only' | 'disabled',
    actions: Parameters<typeof sessionUser>[2] = [],
  ) =>
    caller(
      makeCtx(
        t.db,
        sessionUser(userRow, { trash: sectionLevel }, actions),
        undefined,
        undefined,
        stubMaintainerr(state()),
      ),
    );

  it('Disabled-trash role is FORBIDDEN on every trash read', async () => {
    const c = call('disabled');
    await expect(c.trash.pending({ media: 'movie' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.trash.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.trash.recentlyDeleted({ media: 'movie' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('Read-Only-trash role can browse but NOT save/expedite/edit without the grant', async () => {
    const c = call('read_only');
    await expect(c.trash.pending({ media: 'movie' })).resolves.toBeTruthy();
    await expect(c.trash.status()).resolves.toBeTruthy();
    await expect(
      c.trash.saveExclusion({ maintainerrMediaId: 'ms-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      c.trash.expediteAll({ media: 'movie', maintainerrMediaIds: ['ms-1'] }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(c.trash.saveRule({ payload: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a save_exclude grant unlocks saveExclusion but not expedite (per-action)', async () => {
    const c = call('read_only', ['save_exclude']);
    await expect(c.trash.saveExclusion({ maintainerrMediaId: 'ms-1' })).resolves.toMatchObject({
      excluded: true,
    });
    await expect(
      c.trash.expediteItem({ media: 'movie', collectionId: 7, maintainerrMediaId: 'ms-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the Save implication is ONE-DIRECTIONAL — save_leaving_soon does NOT unlock the anytime pending-wall save (ADR-025 errata)', async () => {
    // save_exclude ⇒ save_leaving_soon, but NOT the reverse: a windowed-rescue holder still cannot
    // whitelist arbitrary flagged items on the live pending wall (that is the save_exclude power).
    const c = call('read_only', ['save_leaving_soon']);
    await expect(
      c.trash.saveExclusion({ maintainerrMediaId: 'ms-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('edit_rules requires section EDIT (read_only + grant is still FORBIDDEN)', async () => {
    const roGrant = call('read_only', ['edit_rules']);
    await expect(roGrant.trash.saveRule({ payload: {} })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Section edit + grant passes the gate: the write reaches Maintainerr and (empty rules ⇒ code:1)
    // succeeds — i.e. NOT FORBIDDEN, the gate PASSED.
    const editGrant = caller(
      makeCtx(
        t.db,
        sessionUser(userRow, { trash: 'edit' }, ['edit_rules']),
        undefined,
        undefined,
        stubMaintainerr(state()),
      ),
    );
    await expect(editGrant.trash.saveRule({ payload: {} })).resolves.toBeUndefined();
  });
});

describe('trash router — happy paths (ADR-023 D-02/D-04/D-05)', () => {
  let t: TestDb;
  let adminRow: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    adminRow = await createUser(t.db, { email: 'trash-admin@example.com', admin: true });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 1, tmdbId: 55001, title: 'Pending Movie', sortTitle: 'pending movie', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
      ],
    });
  });
  afterAll(async () => t?.stop());

  const adminCaller = (s: MaintState) =>
    caller(makeCtx(t.db, sessionUser(adminRow), undefined, undefined, stubMaintainerr(s)));

  it('pending merges Maintainerr media with the ledger + returns total size', async () => {
    const res = await adminCaller(state()).trash.pending({ media: 'movie' });
    expect(res.count).toBe(1);
    expect(res.totalSizeBytes).toBe(1_000_000_000);
    expect(res.items[0]).toMatchObject({ tmdbId: 55001, title: 'Pending Movie', maintainerrMediaId: 'ms-1' });
    expect(res.items[0]!.scheduledDeleteAt).toBe(
      new Date(Date.parse('2026-06-01T00:00:00Z') + 30 * 86_400_000).toISOString(),
    );
  });

  // Bug 1 (live-repro fix 2026-07-06) — the Rules-tab arm/disarm GET→PUT round-trip. The rule GET
  // shape carries an ENCODED `ruleJson`; PUT validates the DECODED RuleDto. upsertTrashRule now
  // decodes first, so round-tripping the GET object verbatim no longer 502s (the pre-fix live bug).
  it('Bug 1 — arm/disarm round-trips a real (ruleJson) rule through saveRule without a 502', async () => {
    const s = state({
      rules: [
        {
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
          ],
        },
      ],
    });
    const c = adminCaller(s);
    const rules = await c.trash.rules();
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Record<string, unknown>;
    expect(rule.isActive).toBe(true);
    // The UI PUTs the rule object exactly as READ (encoded ruleJson and all).
    await expect(c.trash.saveRule({ payload: { ...rule, isActive: false } })).resolves.toBeUndefined();
    // The write landed on Maintainerr — the rule is now disarmed.
    const after = await c.trash.rules();
    expect((after[0] as Record<string, unknown>).isActive).toBe(false);
  });

  // Bug 2 (live-repro fix 2026-07-06) — a Maintainerr exclusion made outside this session shows as
  // Protected in the pending list before its `dnd` tag syncs into arrTags.
  it('Bug 2 — pending reflects a LIVE Maintainerr exclusion as protectedByExclusion', async () => {
    const res = await adminCaller(state({ exclusions: new Set(['ms-1']) })).trash.pending({
      media: 'movie',
    });
    const item = res.items.find((i) => i.maintainerrMediaId === 'ms-1')!;
    expect(item.protectedByTag).toBe(false); // no dnd tag synced
    expect(item.protectedByExclusion).toBe(true); // but live-excluded ⇒ Protected
  });

  it('status returns the SAFE verdict; expedite refuses when unsafe (PRECONDITION_FAILED)', async () => {
    const okStatus = await adminCaller(state()).trash.status();
    expect(okStatus.safe).toBe(true);

    try {
      await adminCaller(state({ safe: false })).trash.expediteAll({
        media: 'movie',
        maintainerrMediaIds: ['ms-1'],
      });
      throw new Error('expected expediteAll to reject');
    } catch (err) {
      const shape = wireShape(err, 'trash.expediteAll');
      expect(shape.data.code).toBe('PRECONDITION_FAILED');
      expect(shape.data.appCode).toBe('MAINTAINERR_UNSAFE');
    }
  });

  it('saveExclusion records a trash_excluded event (source maintainerr)', async () => {
    const res = await adminCaller(state()).trash.saveExclusion({ maintainerrMediaId: 'ms-1' });
    expect(res).toMatchObject({ excluded: true });
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_excluded'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.source).toBe('maintainerr');
  });

  it('activity reads the (empty) Maintainerr notification feed', async () => {
    const feed = await adminCaller(state()).trash.activity();
    expect(Array.isArray(feed)).toBe(true);
  });

  it('recentlyDeleted returns tombstoned rows (none yet ⇒ empty)', async () => {
    const rows = await adminCaller(state()).trash.recentlyDeleted({ media: 'movie' });
    expect(rows).toEqual([]);
    // sanity — the seeded movie is live, not tombstoned.
    const live = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 55001));
    expect(live[0]!.deletedFromArrAt).toBeNull();
  });

  // F2 (2026-07-06 pre-ship review) — expediteAll is pinned to the snapshot the user saw.
  it('F2 — expediteAll deletes only the pinned snapshot ∩ pending; stale ids counted', async () => {
    // ms-1 (tmdb 55001) is cold + ledger-known ⇒ deletable. Pinning to exactly it deletes it.
    const hit = await adminCaller(state()).trash.expediteAll({
      media: 'movie',
      maintainerrMediaIds: ['ms-1'],
    });
    expect(hit).toMatchObject({ scope: 'all', expeditedCount: 1, stalePending: 0 });

    // A snapshot id no longer pending ⇒ counted stalePending, nothing deleted.
    const stale = await adminCaller(state()).trash.expediteAll({
      media: 'movie',
      maintainerrMediaIds: ['ms-gone'],
    });
    expect(stale).toMatchObject({ expeditedCount: 0, stalePending: 1 });
  });

  // F1 (2026-07-06 pre-ship review) — a live exclusion protects even a cold, ledger-known item.
  it('F1 — a live Maintainerr exclusion protects the pinned item (no deletion)', async () => {
    const res = await adminCaller(state({ exclusions: new Set(['ms-1']) })).trash.expediteAll({
      media: 'movie',
      maintainerrMediaIds: ['ms-1'],
    });
    expect(res).toMatchObject({ expeditedCount: 0, protectedCount: 1 });
  });

  it('expediteAll REQUIRES a non-empty maintainerrMediaIds snapshot (wire contract)', async () => {
    await expect(
      adminCaller(state()).trash.expediteAll({ media: 'movie', maintainerrMediaIds: [] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
