// ADR-021 / ADR-022 / DESIGN-009 — the Ledger section router integration tests: embedded PG16 +
// fetch-stubbed *arr. Covers the section gating matrix (Disabled/Read-Only/Edit/Admin ×
// procedures), browse always including tombstoned rows + the Ledger-only filters, the bulk
// Add-&-search three-outcome wiring + reason-filtered run report, the deterministic JSONL export,
// and roles.setSectionPermission surfacing on roles.list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import {
  setRoleLibraries,
  syncPlexMatches,
  tombstoneMissingItems,
  upsertPlexLibraries,
} from '@hnet/domain';
import { buildExportFilterFromParams, streamLedgerExportRows } from '../src/ledger-export';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';
import { movieJson, stubArrBundle } from './arr-stubs';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

describe('ledgerAdmin section gating (AC-13)', () => {
  it('Disabled → browse FORBIDDEN; Read-Only → browse ok but bulk FORBIDDEN; Edit → bulk reached', async () => {
    const member = await createUser(tdb.db);
    const gate = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Gate Movie',
      arrItemId: 9001,
      tmdbId: 990001,
    });
    // ADR-047 (PLAN-028) — the Read-Only member must also have Plex library ACCESS to browse the item
    // (the invariant applies to the admin spreadsheet too). Grant the Default role a Movies library +
    // match Gate Movie into it so this section-gating test sees the row it asserts on.
    await upsertPlexLibraries({
      db: tdb.db,
      slug: 'haynestower',
      libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
    });
    const [movies] = await tdb.db
      .select({ id: schema.plexLibraries.id })
      .from(schema.plexLibraries)
      .where(
        and(
          eq(schema.plexLibraries.serverId, schema.SEEDED_PLEX_SERVER_IDS.haynestower),
          eq(schema.plexLibraries.sectionKey, '1'),
        ),
      );
    await syncPlexMatches({
      db: tdb.db,
      matches: [{ mediaItemId: gate.id, plexLibraryId: movies!.id, ratingKey: '1', matchedVia: 'tmdb' }],
      scopedLibraryIds: [movies!.id],
    });
    await setRoleLibraries({
      db: tdb.db,
      roleId: schema.SEEDED_ROLE_IDS.default,
      libraryIds: [movies!.id],
      actorId: null,
    });

    const disabled = caller(makeCtx(tdb.db, sessionUser(member, { ledger: 'disabled' })));
    await expect(disabled.ledgerAdmin.browse({ arrKind: 'radarr' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const readOnly = caller(makeCtx(tdb.db, sessionUser(member, { ledger: 'read_only' })));
    const page = await readOnly.ledgerAdmin.browse({ arrKind: 'radarr' });
    expect(page.items.some((i) => i.title === 'Gate Movie')).toBe(true);
    await expect(
      readOnly.ledgerAdmin.bulkAddAndSearch({
        arrKind: 'radarr',
        mediaItemIds: [crypto.randomUUID()],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Edit reaches the resolver (no arr bundle injected → it fails at the *arr call, NOT the gate).
    const edit = caller(makeCtx(tdb.db, sessionUser(member, { ledger: 'edit' })));
    await expect(
      edit.ledgerAdmin.bulkAddAndSearch({ arrKind: 'radarr', mediaItemIds: [crypto.randomUUID()] }),
    ).rejects.not.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('ledgerAdmin.browse (DESIGN-009 D-04)', () => {
  it('always includes tombstoned rows and honors monitored/hasFile filters', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const live = await seedMediaItem(tdb.db, 'sonarr', {
      title: 'Live Show',
      arrItemId: 6001,
      tvdbId: 960001,
      monitored: true,
      onDiskFileCount: 3,
      expectedFileCount: 3,
    });
    const gone = await seedMediaItem(tdb.db, 'sonarr', {
      title: 'Gone Show',
      arrItemId: 6002,
      tvdbId: 960002,
      monitored: false,
      onDiskFileCount: 0,
      expectedFileCount: 5,
    });
    // Tombstone 6002 (not in the seen set).
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'sonarr', seenArrItemIds: [6001] });

    const api = caller(makeCtx(tdb.db, sessionUser(admin)));
    const all = await api.ledgerAdmin.browse({ arrKind: 'sonarr', limit: 200 });
    const byId = new Map(all.items.map((i) => [i.id, i]));
    // The tombstoned row appears (browse forces includeTombstoned), badged.
    expect(byId.get(gone.id)!.tombstonedAt).not.toBeNull();
    expect(byId.get(live.id)!.tombstonedAt).toBeNull();

    // Ledger-only dims: monitored=false + hasFile='none' isolates the Fileless-Set half.
    const fileless = await api.ledgerAdmin.browse({
      arrKind: 'sonarr',
      monitored: false,
      hasFile: 'none',
      limit: 200,
    });
    const filelessIds = new Set(fileless.items.map((i) => i.id));
    expect(filelessIds.has(gone.id)).toBe(true);
    expect(filelessIds.has(live.id)).toBe(false);
  });
});

describe('ledgerAdmin.bulkAddAndSearch + run (AC-11)', () => {
  it('wires executeArrAdd(reason:ledger_add) and reports per item; run is reason-scoped', async () => {
    const editor = await createUser(tdb.db);
    const absent = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Bulk Absent',
      arrItemId: 7101,
      tmdbId: 971001,
      monitored: false,
      qualityProfileName: 'Any',
      rootFolder: '/movies',
    });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [] });

    let added = 0;
    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [] }, // nothing live → absent → add
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/movies' }] },
      { path: '/api/v3/tag', body: [] },
      {
        method: 'POST',
        path: '/api/v3/movie',
        status: 201,
        body: () => movieJson(5000 + ++added, { tmdbId: 971001, monitored: true }),
      },
      {
        method: 'POST',
        path: '/api/v3/command',
        status: 201,
        body: { id: 1, name: 'MoviesSearch' },
      },
    ]);

    const api = caller(makeCtx(tdb.db, sessionUser(editor, { ledger: 'edit' }), stub.bundle));
    const { runId, status } = await api.ledgerAdmin.bulkAddAndSearch({
      arrKind: 'radarr',
      mediaItemIds: [absent.id],
      searchOnAdd: true,
    });
    expect(status).toBe('completed');

    // The search command fired (Add-&-search).
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(1);

    const run = await api.ledgerAdmin.run({ id: runId });
    expect(run.reason).toBe('ledger_add');
    expect(run.successCount).toBe(1);
    expect(run.results[0]).toMatchObject({
      mediaItemId: absent.id,
      ok: true,
      outcome: 'added',
      searched: true,
    });
    expect(await api.ledgerAdmin.runs()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runId, reason: 'ledger_add' })]),
    );

    // The Runs-tab list contract: each row carries the server-computed outcome summary
    // (D-05 classification — the list never ships the raw results payload)…
    const listed = (await api.ledgerAdmin.runs()).find((r) => r.id === runId)!;
    expect(listed.summary).toEqual({ added: 1, monitored: 0, skipped: 0, failed: 0 });
    expect(listed).not.toHaveProperty('results');
    // …and the optional arrKind narrows server-side (the media-type filter).
    const radarrRuns = await api.ledgerAdmin.runs({ arrKind: 'radarr' });
    expect(radarrRuns.some((r) => r.id === runId)).toBe(true);
    const sonarrRuns = await api.ledgerAdmin.runs({ arrKind: 'sonarr' });
    expect(sonarrRuns.some((r) => r.id === runId)).toBe(false);
  });

  it('a Restore run (reason restore) is NOT visible via ledgerAdmin.run', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const item = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Restore Only',
      arrItemId: 7201,
      tmdbId: 972001,
    });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [] });
    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [] },
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/data/haynestower/Media/TV Shows' }] },
      { path: '/api/v3/tag', body: [] },
      {
        method: 'POST',
        path: '/api/v3/movie',
        status: 201,
        body: () => movieJson(6001, { tmdbId: 972001 }),
      },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));
    const { runId } = await api.restore.execute({ arrKind: 'radarr', mediaItemIds: [item.id] });
    await expect(api.ledgerAdmin.run({ id: runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a selection over the 1000-item cap at the edge (zod)', async () => {
    const editor = await createUser(tdb.db);
    const api = caller(makeCtx(tdb.db, sessionUser(editor, { ledger: 'edit' })));
    const tooMany = Array.from({ length: 1001 }, () => crypto.randomUUID());
    await expect(
      api.ledgerAdmin.bulkAddAndSearch({ arrKind: 'radarr', mediaItemIds: tooMany }),
    ).rejects.toBeTruthy();
  });
});

describe('ledger export (AC-12 — deterministic JSONL)', () => {
  it('streams exactly the filtered set with round-trip ids, ordered (sort_title, id)', async () => {
    await seedMediaItem(tdb.db, 'lidarr', {
      title: 'Zeta Band',
      arrItemId: 8002,
      musicbrainzArtistId: '00000000-0000-0000-0000-0000000zeta',
      monitored: true,
      year: null,
    });
    await seedMediaItem(tdb.db, 'lidarr', {
      title: 'Alpha Band',
      arrItemId: 8001,
      musicbrainzArtistId: '00000000-0000-0000-0000-000000alpha',
      monitored: false,
      year: null,
    });

    const filter = buildExportFilterFromParams(new URLSearchParams({ arrKind: 'lidarr' }));
    const lines: string[] = [];
    for await (const line of streamLedgerExportRows(tdb.db, filter)) lines.push(line);
    const rows = lines.map(
      (l) => JSON.parse(l) as { kind: string; title: string; musicbrainzArtistId: string | null },
    );
    const bands = rows.filter((r) => r.title.endsWith(' Band'));
    // Deterministic sort_title order: 'alpha band' before 'zeta band'.
    expect(bands.map((b) => b.title)).toEqual(['Alpha Band', 'Zeta Band']);
    expect(bands[0]).toMatchObject({
      kind: 'lidarr',
      musicbrainzArtistId: '00000000-0000-0000-0000-000000alpha',
    });
    // Each line is a single JSON object terminated by a newline.
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });
});

describe('ledgerAdmin.count (Export label true total — nit fix 2026-07-07)', () => {
  it('counts the FULL filtered set (== the export), never just the loaded page; honors the shared filters', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    // 12 rows behind a unique query token — 5 unmonitored, 7 monitored.
    for (let i = 0; i < 12; i++) {
      await seedMediaItem(tdb.db, 'radarr', {
        title: `CountFixture ${String(i).padStart(2, '0')}`,
        arrItemId: 74000 + i,
        tmdbId: 974000 + i,
        monitored: i >= 5,
      });
    }
    const api = caller(makeCtx(tdb.db, sessionUser(admin)));
    const filter = { arrKind: 'radarr' as const, query: 'CountFixture' };

    // The true total equals EXACTLY what the export streams for the same filter (shared
    // buildLibraryWhere — the label can't drift from the streamed set).
    const { count } = await api.ledgerAdmin.count(filter);
    const exportFilter = buildExportFilterFromParams(
      new URLSearchParams({ arrKind: 'radarr', query: 'CountFixture' }),
    );
    const lines: string[] = [];
    for await (const line of streamLedgerExportRows(tdb.db, exportFilter)) lines.push(line);
    expect(count).toBe(12);
    expect(count).toBe(lines.length);

    // …and it EXCEEDS a single loaded page — the old label ("N+ rows") only knew page 1 (the bug).
    const page = await api.ledgerAdmin.browse({ ...filter, limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
    expect(count).toBeGreaterThan(page.items.length);

    // The shared filter narrows the count in lockstep with browse/export (the monitored dim).
    const unmonitored = await api.ledgerAdmin.count({ ...filter, monitored: false });
    expect(unmonitored.count).toBe(5);
  });
});

describe('roles.setSectionPermission (ADR-021 C-02)', () => {
  it('admin sets a role level and roles.list reflects it; non-admin is FORBIDDEN', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const member = await createUser(tdb.db);
    const api = caller(makeCtx(tdb.db, sessionUser(admin)));

    const before = (await api.roles.list()).find((r) => r.id === schema.SEEDED_ROLE_IDS.default)!;
    expect(before.sectionPermissions.ledger).toBe('disabled'); // the no-row default (ADR-032)

    await api.roles.setSectionPermission({
      roleId: schema.SEEDED_ROLE_IDS.default,
      sectionId: 'ledger',
      level: 'read_only',
    });
    const after = (await api.roles.list()).find((r) => r.id === schema.SEEDED_ROLE_IDS.default)!;
    expect(after.sectionPermissions.ledger).toBe('read_only');
    // The Admin role always shows edit (implicit).
    expect(
      (await api.roles.list()).find((r) => r.id === schema.SEEDED_ROLE_IDS.admin)!
        .sectionPermissions,
    ).toEqual({
      ledger: 'edit',
      trash: 'edit',
      bulletin: 'edit',
      metrics: 'edit',
      ytdlsub: 'edit',
      books: 'edit',
    });

    const memberApi = caller(makeCtx(tdb.db, sessionUser(member)));
    await expect(
      memberApi.roles.setSectionPermission({
        roleId: schema.SEEDED_ROLE_IDS.default,
        sectionId: 'ledger',
        level: 'edit',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('setting a level on the Admin role → ROLE_IMMUTABLE', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const api = caller(makeCtx(tdb.db, sessionUser(admin)));
    await expect(
      api.roles.setSectionPermission({
        roleId: schema.SEEDED_ROLE_IDS.admin,
        sectionId: 'ledger',
        level: 'read_only',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
