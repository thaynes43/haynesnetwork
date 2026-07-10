// ADR-037 / DESIGN-016 — the Metrics router: the SERVER-AUTHORITATIVE level invariant (a `limited`
// caller never receives the full-only `network.wanLinks` key AND never even fetches it), the section
// visibility gate (disabled ⇒ FORBIDDEN), the audited role-level flip, and the admin capacity round-trip.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, roles } from '@hnet/db/schema';
import { createRole } from '@hnet/domain';
import type { PromVectorSample, PrometheusReader } from '@hnet/metrics';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await bootMigratedDb();
});
afterAll(async () => {
  await testDb.stop();
});

function sample(value: number | string, metric: Record<string, string> = {}): PromVectorSample {
  return { metric, value: [1_700_000_000, String(value)] };
}

/** A stub @hnet/metrics reader that answers the Overview's instant queries and RECORDS every query. */
function stubReader(): { reader: PrometheusReader; queries: string[] } {
  const queries: string[] = [];
  const query = vi.fn(async (promQL: string): Promise<PromVectorSample[]> => {
    queries.push(promQL);
    if (promQL.includes('transmit_rate_bytes')) return [sample(1_454_880, { subsystem: 'wan' })];
    if (promQL.includes('receive_rate_bytes')) return [sample(844_568, { subsystem: 'wan' })];
    if (promQL.includes('provider_upload_kbps'))
      return [
        sample(316_000, { wan_name: 'Internet 1', wan_id: 'a' }),
        sample(350_000, { wan_name: 'Internet 2', wan_id: 'b' }),
      ];
    if (promQL.includes('provider_download_kbps'))
      return [
        sample(2_256_000, { wan_name: 'Internet 1', wan_id: 'a' }),
        sample(2_300_000, { wan_name: 'Internet 2', wan_id: 'b' }),
      ];
    if (promQL.includes('count by (instance, cpu)')) return [sample(132)];
    if (promQL.includes('count(node_load1)')) return [sample(6)];
    if (promQL.includes('node_load1')) return [sample(18.5)];
    if (promQL.includes('MemTotal')) return [sample(529_642_733_568)];
    if (promQL.includes('MemAvailable')) return [sample(384_401_444_864)];
    return [];
  });
  return { reader: { query, queryRange: async () => [] }, queries };
}

describe('metrics.overview — level invariant (ADR-037 C-03)', () => {
  it('a FULL (admin) caller gets network.wanLinks + hardware; a LIMITED caller does not', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const fullStub = stubReader();
    const full = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, fullStub.reader),
    ).metrics.overview();
    expect(full.level).toBe('full');
    expect(full.network.wanLinks).toBeDefined();
    expect(full.network.wanLinks).toHaveLength(2);
    expect(full.network.upload.usageMbps).toBe(11.6);
    expect(full.hardware.nodes?.count).toBe(6);
    expect(fullStub.queries.some((q) => q.includes('provider_upload_kbps'))).toBe(true);

    const limitedStub = stubReader();
    const limited = await caller(
      makeCtx(
        testDb.db,
        // metrics section opened to read_only, but the DETAIL level is 'limited'.
        sessionUser(member, { metrics: 'read_only' }, undefined, undefined, undefined, 'limited'),
        undefined,
        undefined,
        undefined,
        undefined,
        limitedStub.reader,
      ),
    ).metrics.overview();
    expect(limited.level).toBe('limited');
    // The full-only key is ABSENT and was NEVER fetched (server-authoritative, not client-hidden).
    expect(limited.network.wanLinks).toBeUndefined();
    expect('wanLinks' in limited.network).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('provider_upload_kbps'))).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('provider_download_kbps'))).toBe(false);
    // The aggregate usage meters + ungated hardware ARE present at limited.
    expect(limited.network.upload.usageMbps).toBe(11.6);
    expect(limited.hardware.nodes?.count).toBe(6);
  });

  it('a caller whose metrics section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    const stub = stubReader();
    await expect(
      caller(
        // no section override ⇒ metrics defaults to 'disabled'
        makeCtx(testDb.db, sessionUser(member), undefined, undefined, undefined, undefined, stub.reader),
      ).metrics.overview(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/** A stub reader answering the Apps sub-tab series (DESIGN-018 D-03) with plausible non-empty vectors. */
function stubAppsReader(): { reader: PrometheusReader; queries: string[] } {
  const queries: string[] = [];
  const query = vi.fn(async (promQL: string): Promise<PromVectorSample[]> => {
    queries.push(promQL);
    if (promQL.includes('sabnzbd_speed_bps'))
      return [sample(12_000_000, { job: 'sabnzbd' }), sample(0, { job: 'sabnzbd-fast' })];
    if (promQL.includes('up{job=~"sabnzbd'))
      return [sample(1, { job: 'sabnzbd' }), sample(1, { job: 'sabnzbd-fast' })];
    if (promQL.includes('prowlarr_indexer_average_response_time_ms'))
      return [sample(335, { indexer: 'DrunkenSlug' }), sample(225, { indexer: 'NinjaCentral' })];
    if (promQL.includes('rate(prowlarr_indexer_queries_total'))
      return [sample(12, { indexer: 'DrunkenSlug' })];
    // Every other scalar (library totals, queues, up{job="qbittorrent"}, enabled, …) → a non-empty 1.
    return [sample(1)];
  });
  return { reader: { query, queryRange: async () => [] }, queries };
}

describe('metrics.apps — both-levels + the plumbed full-only seam (ADR-037 C-03 / R-126)', () => {
  it('returns the four groups at BOTH levels; the requester seam is present at full, absent at limited', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const fullStub = stubAppsReader();
    const full = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, fullStub.reader),
    ).metrics.apps();
    expect(full.collection.rows).toHaveLength(3);
    expect(full.pipeline.rows).toHaveLength(3);
    expect(full.downloads.usenet).toHaveLength(2);
    expect(full.indexers.rows.map((r) => r.indexer)).toEqual(['DrunkenSlug', 'NinjaCentral']);
    // Full-only seam present-but-empty at full.
    expect('requesterActivity' in full).toBe(true);
    expect(full.requesterActivity).toEqual([]);

    const limitedStub = stubAppsReader();
    const limited = await caller(
      makeCtx(
        testDb.db,
        sessionUser(member, { metrics: 'read_only' }, undefined, undefined, undefined, 'limited'),
        undefined,
        undefined,
        undefined,
        undefined,
        limitedStub.reader,
      ),
    ).metrics.apps();
    // Same data at limited (no user-aware series to drop) but the full-only seam is OMITTED.
    expect(limited.collection).toEqual(full.collection);
    expect(limited.indexers).toEqual(full.indexers);
    expect('requesterActivity' in limited).toBe(false);
    expect(limited.requesterActivity).toBeUndefined();
  });

  it('a caller whose metrics section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    const stub = stubAppsReader();
    await expect(
      caller(
        makeCtx(testDb.db, sessionUser(member), undefined, undefined, undefined, undefined, stub.reader),
      ).metrics.apps(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('metrics.access', () => {
  it('reports the caller’s own level + whether the section is visible', async () => {
    const member = await createUser(testDb.db);
    const hidden = await caller(makeCtx(testDb.db, sessionUser(member))).metrics.access();
    expect(hidden).toEqual({ level: 'limited', canSee: false });

    const opened = await caller(
      makeCtx(testDb.db, sessionUser(member, { metrics: 'read_only' }, undefined, undefined, undefined, 'limited')),
    ).metrics.access();
    expect(opened).toEqual({ level: 'limited', canSee: true });

    const admin = await createUser(testDb.db, { admin: true });
    const adminAccess = await caller(makeCtx(testDb.db, sessionUser(admin))).metrics.access();
    expect(adminAccess).toEqual({ level: 'full', canSee: true });
  });
});

describe('metrics.capacity (admin-gated, audited)', () => {
  it('defaults to 300/2256, round-trips a set, and rejects a non-admin', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const adminCaller: Caller = caller(makeCtx(testDb.db, sessionUser(admin)));

    expect(await adminCaller.metrics.capacity.get()).toEqual({ uploadMbps: 300, downloadMbps: 2256 });

    await adminCaller.metrics.capacity.setUpload({ mbps: 500 });
    expect((await adminCaller.metrics.capacity.get()).uploadMbps).toBe(500);

    const member = await createUser(testDb.db);
    await expect(
      caller(makeCtx(testDb.db, sessionUser(member))).metrics.capacity.setUpload({ mbps: 999 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('roles.setMetricsLevel (audited single-writer)', () => {
  it('flips a custom role’s level and writes an update_role_metrics_level audit row', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
    const { roleId } = await createRole({ db: testDb.db, name: 'Metrics-Full', appIds: [], actorId: null });

    const res = await adminCaller.roles.setMetricsLevel({ roleId, level: 'full' });
    expect(res).toMatchObject({ changed: true, before: 'limited', after: 'full' });

    const [row] = await testDb.db.select({ level: roles.metricsLevel }).from(roles).where(eq(roles.id, roleId));
    expect(row?.level).toBe('full');

    const audits = await testDb.db
      .select({ action: permissionAudit.action })
      .from(permissionAudit)
      .where(eq(permissionAudit.roleId, roleId));
    expect(audits.some((a) => a.action === 'update_role_metrics_level')).toBe(true);
  });

  it('rejects editing the immutable Admin role (ROLE_IMMUTABLE / FORBIDDEN)', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
    const [adminRole] = await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.isAdmin, true));
    await expect(
      adminCaller.roles.setMetricsLevel({ roleId: adminRole!.id, level: 'limited' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
