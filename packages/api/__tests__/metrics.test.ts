// ADR-037 / DESIGN-016 — the Metrics router: the SERVER-AUTHORITATIVE level invariant (a `limited`
// caller never receives the full-only `network.wanLinks` key AND never even fetches it), the section
// visibility gate (disabled ⇒ FORBIDDEN), the audited role-level flip, and the admin capacity round-trip.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, roles } from '@hnet/db/schema';
import { createRole, syncAiUsage, type AiUsageChatInput, type AiUsageUserInput } from '@hnet/domain';
import type { PromMatrixSeries, PromVectorSample, PrometheusReader } from '@hnet/metrics';
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

/** A stub reader answering the Network sub-tab series (ADR-039 / DESIGN-019) + WAN history range. */
function stubNetworkReader(): { reader: PrometheusReader; queries: string[] } {
  const queries: string[] = [];
  const query = vi.fn(async (promQL: string): Promise<PromVectorSample[]> => {
    queries.push(promQL);
    if (promQL.includes('transmit_rate_bytes')) return [sample(1_454_880, { subsystem: 'wan' })];
    if (promQL.includes('receive_rate_bytes')) return [sample(844_568, { subsystem: 'wan' })];
    if (promQL.includes('provider_upload_kbps'))
      return [sample(316_000, { wan_name: 'Internet 1', wan_id: 'a' })];
    if (promQL.includes('provider_download_kbps'))
      return [sample(2_256_000, { wan_name: 'Internet 1', wan_id: 'a' })];
    if (promQL.includes('cpu_utilization_ratio'))
      return [
        sample(0.454, { name: 'Westford DMSE', type: 'udm' }),
        sample(0.213, { name: 'Switch Pro Max 48 PoE', type: 'usw' }),
      ];
    if (promQL.includes('memory_utilization_ratio'))
      return [sample(0.818, { name: 'Westford DMSE', type: 'udm' })];
    if (promQL.includes('load_average_1')) return [sample(1.2, { name: 'Westford DMSE', type: 'udm' })];
    if (promQL.includes('speedtest_download')) return [sample(1526)];
    if (promQL.includes('unpoller_site_aps')) return [sample(7)];
    if (promQL.includes('unpoller_site_stations')) return [sample(181)];
    return [sample(1)];
  });
  const queryRange = vi.fn(async (): Promise<PromMatrixSeries[]> => [
    { metric: {}, values: [[1_700_000_000, '1250000'], [1_700_003_600, '2500000']] },
  ]);
  return { reader: { query, queryRange }, queries };
}

describe('metrics.network — the disjoint limited/full shape + privacy seam (ADR-039 C-03)', () => {
  it('full sees infra + per-uplink wanLinks; limited sees only WAN meters + history, never fetching infra', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const fullStub = stubNetworkReader();
    const full = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, fullStub.reader),
    ).metrics.network();
    expect(full.level).toBe('full');
    expect(full.wan.upload.usageMbps).toBe(11.6);
    expect(full.history.upload.length).toBeGreaterThan(0);
    expect(full.infra).toBeDefined();
    expect(full.infra!.devices[0]).toMatchObject({ name: 'Westford DMSE', category: 'gateway' });
    expect(full.infra!.site.stations).toBe(181);
    expect(full.wan.wanLinks).toBeDefined();
    expect(fullStub.queries.some((q) => q.includes('cpu_utilization_ratio'))).toBe(true);

    const limitedStub = stubNetworkReader();
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
    ).metrics.network();
    expect(limited.level).toBe('limited');
    // The full-only infra key is ABSENT and was NEVER fetched (server-authoritative).
    expect('infra' in limited).toBe(false);
    expect(limited.infra).toBeUndefined();
    expect(limited.wan.wanLinks).toBeUndefined();
    expect(limitedStub.queries.some((q) => q.includes('cpu_utilization_ratio'))).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('unpoller_site_aps'))).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('provider_upload_kbps'))).toBe(false);
    // But the WAN meters + history ARE present at limited (its value-add over a bare Overview).
    expect(limited.wan.upload.usageMbps).toBe(11.6);
    expect(limited.history.upload.length).toBeGreaterThan(0);
  });

  it('a caller whose metrics section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    const stub = stubNetworkReader();
    await expect(
      caller(
        makeCtx(testDb.db, sessionUser(member), undefined, undefined, undefined, undefined, stub.reader),
      ).metrics.network(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('metrics.* — Grafana deep-links are ADMIN-ONLY (DESIGN-016 D-07)', () => {
  // The Grafana dashboards resolve ONLY on the owner's LAN/VPN, so their URLs are ADMIN-ONLY and enforced
  // SERVER-SIDE in the payload shape: an admin response carries the `grafana` link object; a NON-admin
  // response never carries a Grafana URL at all — at BOTH metrics levels (a `full` non-admin, e.g. Family,
  // has the detail grant but not necessarily LAN access, so it is gated on ADMIN, not the level).

  /** A non-admin caller whose metrics section is opened to read_only, at the given detail level. */
  function memberCtxFactory(member: Awaited<ReturnType<typeof createUser>>, level: 'full' | 'limited', reader: PrometheusReader) {
    return makeCtx(
      testDb.db,
      sessionUser(member, { metrics: 'read_only' }, undefined, undefined, undefined, level),
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );
  }

  it('overview: PRESENT for admin, ABSENT for a non-admin at BOTH levels', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const adminOut = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, stubReader().reader),
    ).metrics.overview();
    expect(adminOut.grafana).toEqual({ base: 'https://grafana.haynesops.com' });

    for (const level of ['full', 'limited'] as const) {
      const out = await caller(memberCtxFactory(member, level, stubReader().reader)).metrics.overview();
      expect(out.grafana).toBeUndefined();
      expect('grafana' in out).toBe(false);
    }
  });

  it('apps: PRESENT for admin, ABSENT for a non-admin at BOTH levels', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const adminOut = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, stubAppsReader().reader),
    ).metrics.apps();
    expect(adminOut.grafana).toEqual({
      library: 'https://grafana.haynesops.com/d/arr-library-overview',
      downloads: 'https://grafana.haynesops.com/d/downloads-clients-indexers',
    });

    for (const level of ['full', 'limited'] as const) {
      const out = await caller(memberCtxFactory(member, level, stubAppsReader().reader)).metrics.apps();
      expect(out.grafana).toBeUndefined();
      expect('grafana' in out).toBe(false);
    }
  });

  it('hardware: PRESENT for admin, ABSENT for a non-admin at BOTH levels', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const adminOut = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, stubReader().reader),
    ).metrics.hardware();
    expect(adminOut.grafana).toEqual({
      nas: 'https://grafana.haynesops.com/d/nas-haynestower',
      smart: 'https://grafana.haynesops.com/d/f8f249a0-be78-41b1-97fe-8d0a92a71b93',
      nodes: 'https://grafana.haynesops.com/d/rYdddlPWk',
      pve: 'https://grafana.haynesops.com/explore',
    });

    for (const level of ['full', 'limited'] as const) {
      const out = await caller(memberCtxFactory(member, level, stubReader().reader)).metrics.hardware();
      expect(out.grafana).toBeUndefined();
      expect('grafana' in out).toBe(false);
    }
  });

  it('network: PRESENT for admin, ABSENT for a non-admin at BOTH levels', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);

    const adminOut = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, undefined, undefined, undefined, stubNetworkReader().reader),
    ).metrics.network();
    expect(adminOut.grafana).toEqual({
      sites: 'https://grafana.haynesops.com/d/9WaGWZaZk',
      uap: 'https://grafana.haynesops.com/d/g5wFWqxZk',
      usw: 'https://grafana.haynesops.com/d/FsfxpWaZz',
    });

    for (const level of ['full', 'limited'] as const) {
      const out = await caller(memberCtxFactory(member, level, stubNetworkReader().reader)).metrics.network();
      expect(out.grafana).toBeUndefined();
      expect('grafana' in out).toBe(false);
    }
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

/** Seed the ai_usage_chats mirror through the domain single-writer (two users, mixed models/images). */
async function seedAiUsage(db: TestDb['db']): Promise<void> {
  const now = new Date();
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * 86_400_000);
  const users: AiUsageUserInput[] = [
    { id: 'ou1', name: 'Alice', email: 'alice@example.test', role: 'admin' },
    { id: 'ou2', name: 'Bob', email: 'bob@example.test', role: 'user' },
  ];
  const chats: AiUsageChatInput[] = [
    {
      owuiChatId: 'oc-a', owuiUserId: 'ou1', title: 'plan', models: ['gpt-oss:latest'],
      primaryModel: 'gpt-oss:latest', messageCount: 4, imageCount: 2, totalTokens: 100,
      totalDurationMs: 90_000, chatCreatedAt: daysAgo(2), chatUpdatedAt: daysAgo(2), archived: false,
    },
    {
      owuiChatId: 'oc-b', owuiUserId: 'ou2', title: 'art', models: ['gpt-oss:latest'],
      primaryModel: 'gpt-oss:latest', messageCount: 2, imageCount: 5, totalTokens: 40,
      totalDurationMs: 5_000, chatCreatedAt: daysAgo(1), chatUpdatedAt: daysAgo(1), archived: false,
    },
  ];
  await syncAiUsage({ db, chats, users, now });
}

describe('metrics.aiUsage — level-gated attribution seam (ADR-044 C-03)', () => {
  it('a FULL (admin) caller gets byUser/byModel + activeUsers; a LIMITED caller gets counts only', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const member = await createUser(testDb.db);
    await seedAiUsage(testDb.db);

    const full = await caller(makeCtx(testDb.db, sessionUser(admin))).metrics.aiUsage({ range: '30d' });
    expect(full.level).toBe('full');
    expect(full.totals.chats).toBe(2);
    expect(full.totals.imageGenerations).toBe(7);
    expect(full.totals.activeUsers).toBe(2);
    expect(full.byModel).toBeDefined();
    expect(full.byUser).toBeDefined();
    expect(full.byUser!.some((u) => u.name === 'Alice')).toBe(true);

    const limited = await caller(
      makeCtx(
        testDb.db,
        sessionUser(member, { metrics: 'read_only' }, undefined, undefined, undefined, 'limited'),
      ),
    ).metrics.aiUsage({ range: '30d' });
    expect(limited.level).toBe('limited');
    // Same aggregate counts…
    expect(limited.totals.chats).toBe(2);
    expect(limited.totals.imageGenerations).toBe(7);
    // …but NO user identity: the full-only keys are OMITTED (server-authoritative, not client-hidden).
    expect(limited.totals.activeUsers).toBeNull();
    expect(limited.byModel).toBeUndefined();
    expect(limited.byUser).toBeUndefined();
    expect('byUser' in limited).toBe(false);
  });

  it('a caller whose metrics section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    await expect(
      caller(makeCtx(testDb.db, sessionUser(member))).metrics.aiUsage({ range: '30d' }),
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
