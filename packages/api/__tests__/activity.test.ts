// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the *ARR action dispatch + role gate.
// Embedded PG16 + a fetch-stubbed *arr bundle (ADR-010). The failure ledger is seeded through the REAL
// `evaluateActivityFailures` single-writer, so the retry/force-search resolvers exercise the exact path
// prod runs. Covers: retry-import fires the *arr `ProcessMonitoredDownloads` on the RIGHT instance;
// force-search fires the per-kind Force-Search command; both co-write the permission_audit + stamp the
// ledger; a plain member is FORBIDDEN from acting yet CAN view the (universal, section-null) *arr failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import {
  evaluateActivityFailures,
  type ActivityFailureInput,
  type KapowarrClientBundle,
} from '@hnet/domain';
import {
  auditRows,
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type TestDb,
} from './helpers';
import { stubArrBundle } from './arr-stubs';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

/** The stub accepts the shared `POST /command` (search + ProcessMonitoredDownloads) with an ack body. */
const ARR_COMMAND_ROUTES = [
  { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 4242, name: 'cmd' } },
];

function arrFailure(overrides: Partial<ActivityFailureInput> & { sourceRef: string }): ActivityFailureInput {
  return {
    source: 'arr',
    kind: 'movie',
    section: null,
    failureKind: 'import_blocked',
    failureReason: 'One or more files were not imported',
    title: 'Blocked Movie',
    year: 2022,
    sourceApp: 'radarr',
    downstreamUrl: 'http://radarr.test:7878',
    ...overrides,
  };
}

/** Seed one OPEN *arr failure via the real ledger writer; return its durable id. */
async function seedArrFailure(input: ActivityFailureInput): Promise<string> {
  await evaluateActivityFailures({ db: tdb.db, failures: [input], scannedSources: ['arr'] });
  const [row] = await tdb.db
    .select()
    .from(schema.activityImportFailures)
    .where(eq(schema.activityImportFailures.sourceRef, input.sourceRef));
  if (!row) throw new Error(`seeded arr failure ${input.sourceRef} not found`);
  return row.id;
}

async function failureRow(id: string) {
  const [row] = await tdb.db
    .select()
    .from(schema.activityImportFailures)
    .where(eq(schema.activityImportFailures.id, id));
  if (!row) throw new Error(`failure ${id} not found`);
  return row;
}

describe('activity.retryImport — *arr dispatch (R2)', () => {
  it('admin fires ProcessMonitoredDownloads on the RIGHT instance, audits + stamps the ledger', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const failureId = await seedArrFailure(arrFailure({ sourceRef: 'arr:radarr:601' }));
    const stub = stubArrBundle(ARR_COMMAND_ROUTES);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    const res = await api.activity.retryImport({ failureId });
    expect(res).toEqual({ ok: true, failureId });

    const cmds = stub.callsFor('POST', '/api/v3/command');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.body).toEqual({ name: 'ProcessMonitoredDownloads' });
    expect(cmds[0]!.url.host).toBe('radarr.test:7878'); // routed to Radarr, not Sonarr/Lidarr

    const audits = await auditRows(tdb.db, 'activity_retry_import');
    expect(
      audits.some((a) => (a.detail as { source_ref?: string })?.source_ref === 'arr:radarr:601'),
    ).toBe(true);

    const row = await failureRow(failureId);
    expect(row.lastAction).toBe('retry_import');
    expect(row.lastActionBy).toBe(admin.id);
  });

  it('a plain member is FORBIDDEN and no *arr write fires', async () => {
    const member = await createUser(tdb.db);
    const failureId = await seedArrFailure(arrFailure({ sourceRef: 'arr:radarr:603' }));
    const stub = stubArrBundle(ARR_COMMAND_ROUTES);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    await expect(api.activity.retryImport({ failureId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
    // The gate fired before the resolver — the ledger is untouched.
    expect((await failureRow(failureId)).lastAction).toBeNull();
  });
});

describe('activity.forceSearch — per-kind *arr Force-Search (R2, PLAN-015 reuse)', () => {
  it('a radarr failure fires MoviesSearch with the movie id', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const failureId = await seedArrFailure(arrFailure({ sourceRef: 'arr:radarr:602' }));
    const stub = stubArrBundle(ARR_COMMAND_ROUTES);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    await api.activity.forceSearch({ failureId });
    const cmds = stub.callsFor('POST', '/api/v3/command');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.body).toEqual({ name: 'MoviesSearch', movieIds: [602] });
    expect(cmds[0]!.url.host).toBe('radarr.test:7878');
    expect((await auditRows(tdb.db, 'activity_force_search')).length).toBeGreaterThan(0);
  });

  it('a sonarr failure fires EpisodeSearch with the episode target on the Sonarr instance', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const failureId = await seedArrFailure(
      arrFailure({ sourceRef: 'arr:sonarr:501:50110', kind: 'tv', sourceApp: 'sonarr' }),
    );
    const stub = stubArrBundle(ARR_COMMAND_ROUTES);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    await api.activity.forceSearch({ failureId });
    const cmds = stub.callsFor('POST', '/api/v3/command');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.body).toEqual({ name: 'EpisodeSearch', episodeIds: [50110] });
    expect(cmds[0]!.url.host).toBe('sonarr.test:8989');
  });
});

// ADR-059 / DESIGN-030 D-08 (PLAN-048) — the KAPOWARR (comic) action path. A comic failure is always
// `download_failed` (Kapowarr has no manual-import surface → no import_blocked), so the only action is a fresh
// force-search that fires the confined PLAN-046 `searchVolume` (auto_search). Comics ride the books section.
function comicFailure(overrides: Partial<ActivityFailureInput> & { sourceRef: string }): ActivityFailureInput {
  return {
    source: 'kapowarr',
    kind: 'comic',
    section: 'books',
    failureKind: 'download_failed',
    failureReason: 'The comic download failed at Kapowarr (dead GetComics source)',
    title: 'Scott Pilgrim',
    year: 2004,
    sourceApp: 'kapowarr',
    downstreamUrl: 'http://kapowarr.test:5656',
    ...overrides,
  };
}

async function seedComicFailure(input: ActivityFailureInput): Promise<string> {
  await evaluateActivityFailures({ db: tdb.db, failures: [input], scannedSources: ['kapowarr'] });
  const [row] = await tdb.db
    .select()
    .from(schema.activityImportFailures)
    .where(eq(schema.activityImportFailures.sourceRef, input.sourceRef));
  if (!row) throw new Error(`seeded comic failure ${input.sourceRef} not found`);
  return row.id;
}

/** A stub Kapowarr bundle whose confined `write.searchVolume` records the volume ids it was fired for. */
function stubKapowarrBundle(): { bundle: KapowarrClientBundle; searched: number[] } {
  const searched: number[] = [];
  const bundle = {
    read: {},
    write: {
      searchVolume: async (id: number) => {
        searched.push(id);
      },
    },
  } as unknown as KapowarrClientBundle;
  return { bundle, searched };
}

describe('activity.forceSearch — Kapowarr comic dispatch (R2)', () => {
  it('admin fires the confined searchVolume(volumeId), audits + stamps the ledger', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const failureId = await seedComicFailure(comicFailure({ sourceRef: 'kapowarr:701' }));
    const kapo = stubKapowarrBundle();
    const api = caller({ ...makeCtx(tdb.db, sessionUser(admin)), kapowarr: kapo.bundle });

    const res = await api.activity.forceSearch({ failureId });
    expect(res).toEqual({ ok: true, failureId });
    expect(kapo.searched).toEqual([701]); // the confined auto_search fired for the exact volume

    const audits = await auditRows(tdb.db, 'activity_force_search');
    expect(audits.some((a) => (a.detail as { source_ref?: string })?.source_ref === 'kapowarr:701')).toBe(true);

    const [row] = await tdb.db
      .select()
      .from(schema.activityImportFailures)
      .where(eq(schema.activityImportFailures.id, failureId));
    expect(row!.lastAction).toBe('force_research');
    expect(row!.lastActionBy).toBe(admin.id);
  });

  it('a plain member is FORBIDDEN and no Kapowarr write fires', async () => {
    const member = await createUser(tdb.db);
    const failureId = await seedComicFailure(comicFailure({ sourceRef: 'kapowarr:703' }));
    const kapo = stubKapowarrBundle();
    const api = caller({ ...makeCtx(tdb.db, sessionUser(member)), kapowarr: kapo.bundle });

    await expect(api.activity.forceSearch({ failureId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(kapo.searched).toHaveLength(0);
  });

  it('a comic retry_import is an honest NO-OP (Kapowarr has no retry-import surface) yet still audits', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const failureId = await seedComicFailure(comicFailure({ sourceRef: 'kapowarr:704' }));
    const kapo = stubKapowarrBundle();
    const api = caller({ ...makeCtx(tdb.db, sessionUser(admin)), kapowarr: kapo.bundle });

    await api.activity.retryImport({ failureId });
    expect(kapo.searched).toHaveLength(0); // no Kapowarr write for a retry-import
    expect((await auditRows(tdb.db, 'activity_retry_import')).length).toBeGreaterThan(0);
  });
});

describe('activity.failure — universal *arr visibility, action flags gated (D-01/D-06)', () => {
  it('a member VIEWS the section-null *arr failure but gets no action flags; admin gets both + the deep link', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const member = await createUser(tdb.db);
    const failureId = await seedArrFailure(arrFailure({ sourceRef: 'arr:radarr:604' }));

    const memberView = await caller(makeCtx(tdb.db, sessionUser(member))).activity.failure({ failureId });
    expect(memberView.failureKind).toBe('import_blocked');
    expect(memberView.canRetryImport).toBe(false);
    expect(memberView.canForceSearch).toBe(false);
    expect(memberView.downstreamUrl).toBeNull(); // Admin-only operator link

    const adminView = await caller(makeCtx(tdb.db, sessionUser(admin))).activity.failure({ failureId });
    expect(adminView.canRetryImport).toBe(true);
    expect(adminView.canForceSearch).toBe(true);
    expect(adminView.downstreamUrl).toBe('http://radarr.test:7878');
  });
});
