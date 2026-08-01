import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, arrQueueCleanupActions, notificationOutbox, permissionAudit } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import { runFailureDigest } from '../src/activity/digest';
import { renderOutboxEmail } from '../src/notify-outbox';
import { QueueCleanupConfigInvalidError } from '../src/errors';
import {
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  buildQueueCleanupDigestSection,
  classifyQueueItem,
  deriveQueueCleanupLadderLevel,
  evaluateQueueCleanup,
  getArrQueueCleanupConfig,
  getArrQueueCleanupStatus,
  getQueueCleanupLadder,
  queueCleanupConfigError,
  resolveArrQueueCleanupConfig,
  setArrQueueCleanupConfig,
  type ArrQueueCleanupConfig,
  type ClassifiableQueueItem,
  type QueueCleanupClients,
  type QueueCleanupInstanceClient,
  type QueueCleanupModeCells,
  type QueueCleanupQueueItem,
} from '../src/queue-cleanup';

// ADR-083 / DESIGN-046 (PLAN-065 — *arr queue janitor). The plan's acceptance proof: the classifier assigns
// exactly one Action Class (first-match order, unknown fallback); the census-first evaluator writes one
// append-only row per item and NEVER touches an *arr while a cell is census; enforce honors the rails (cap /
// min-age / monitored-check / retry-escalation) and continues past an *arr write failure (outcome 'error');
// the config validates + audits same-tx and resolves DB-first fail-safe to all-census; and the digest folds
// in the janitor rollup, firing on a clean ledger when the janitor observed anything and nagging when due.

// ---------------------------------------------------------------------------
// Classifier (D-03) — table-driven over synthetic queue records per class per *arr.
// ---------------------------------------------------------------------------

describe('classifyQueueItem (D-03, pure)', () => {
  const msg = (title: string, ...messages: string[]) => ({
    statusMessages: [{ title, messages }],
  });

  const cases: Array<{ name: string; item: ClassifiableQueueItem; class: string }> = [
    // have_better (per *arr)
    {
      name: 'radarr have_better: importBlocked + "Not an upgrade for existing"',
      item: {
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
        ...msg('Not an upgrade', 'Not an upgrade for existing movie file(s)'),
      },
      class: 'have_better',
    },
    {
      name: 'sonarr have_better: importBlocked + "Not a Custom Format upgrade"',
      item: {
        trackedDownloadState: 'importBlocked',
        ...msg('Blocked', 'Not a Custom Format upgrade for existing episode file(s)'),
      },
      class: 'have_better',
    },
    {
      name: 'sonarr have_better: cutoff already met',
      item: {
        trackedDownloadState: 'importPending',
        ...msg('Blocked', 'Quality and Language cutoff has already been met'),
      },
      class: 'have_better',
    },
    // bad_release (per *arr / per signal)
    {
      name: 'radarr bad_release: trackedDownloadStatus error',
      item: { trackedDownloadStatus: 'error', trackedDownloadState: 'importFailed' },
      class: 'bad_release',
    },
    {
      name: 'sonarr bad_release: "Unable to parse"',
      item: { trackedDownloadState: 'importBlocked', ...msg('Failed', 'Unable to parse the release title') },
      class: 'bad_release',
    },
    {
      name: 'lidarr bad_release: sample',
      item: { ...msg('Rejected', 'Sample detected in the release') },
      class: 'bad_release',
    },
    {
      name: 'radarr bad_release: password-protected archive',
      item: { ...msg('Rejected', 'The archive is password protected') },
      class: 'bad_release',
    },
    {
      name: 'sonarr bad_release: status failed',
      item: { status: 'failed' },
      class: 'bad_release',
    },
    // retry_import
    {
      name: 'radarr retry_import: importPending + "Waiting to import"',
      item: { trackedDownloadState: 'importPending', ...msg('Pending', 'Waiting to import...') },
      class: 'retry_import',
    },
    {
      name: 'sonarr retry_import: importBlocked with no messages',
      item: { trackedDownloadState: 'importBlocked', statusMessages: [] },
      class: 'retry_import',
    },
    // unknown
    {
      name: 'lidarr unknown: match ambiguity (Q-01, stays unknown initially)',
      item: {
        trackedDownloadState: 'importPending',
        ...msg('Manual import', 'Found matching artist but no album could be found that was close enough'),
      },
      class: 'unknown',
    },
    {
      name: 'unknown fallthrough: a warning with an unrecognized message',
      item: { status: 'warning', ...msg('Note', 'Something the classifier has never seen') },
      class: 'unknown',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = classifyQueueItem(c.item);
      expect(result.class).toBe(c.class);
      expect(result.confidence).toBe(c.class === 'unknown' ? 'low' : 'high');
    });
  }

  it('precedence: have_better wins over bad_release when BOTH signals are present', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importBlocked',
      trackedDownloadStatus: 'error', // a bad_release signal
      statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing episode file(s)'] }],
    });
    expect(result.class).toBe('have_better');
  });

  it('precedence: bad_release wins over retry_import for a stuck import with an error status', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importPending',
      trackedDownloadStatus: 'error',
      statusMessages: [{ title: 'x', messages: ['Waiting to import...'] }],
    });
    expect(result.class).toBe('bad_release');
  });

  it('carries the driving message as the reason (≤500 chars)', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importBlocked',
      statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing movie file(s)'] }],
    });
    expect(result.reason).toContain('Not an upgrade');
  });
});

// ---------------------------------------------------------------------------
// Config validation (D-05) — pure matrix.
// ---------------------------------------------------------------------------

describe('queueCleanupConfigError (D-05, pure)', () => {
  it('accepts the all-census default', () => {
    expect(queueCleanupConfigError(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT)).toBeNull();
  });
  it('rejects a non-object', () => {
    expect(queueCleanupConfigError(null)).toMatch(/must be an object/);
  });
  it('rejects an unknown instance', () => {
    const cfg = clone();
    (cfg.modes as Record<string, unknown>).plex = cell();
    expect(queueCleanupConfigError(cfg)).toMatch(/Unknown instance/);
  });
  it('rejects an unknown class', () => {
    const cfg = clone();
    (cfg.modes.sonarr as Record<string, unknown>).mystery = 'census';
    expect(queueCleanupConfigError(cfg)).toMatch(/Unknown class/);
  });
  it('rejects a bad mode value', () => {
    const cfg = clone();
    (cfg.modes.sonarr as Record<string, unknown>).have_better = 'on';
    expect(queueCleanupConfigError(cfg)).toMatch(/census.*enforce/);
  });
  it('rejects maxActionsPerRun out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), maxActionsPerRun: 0 })).toMatch(/1\.\.100/);
    expect(queueCleanupConfigError({ ...clone(), maxActionsPerRun: 101 })).toMatch(/1\.\.100/);
  });
  it('rejects minItemAgeHours out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), minItemAgeHours: -1 })).toMatch(/0\.\.168/);
    expect(queueCleanupConfigError({ ...clone(), minItemAgeHours: 200 })).toMatch(/0\.\.168/);
  });
  it('rejects retryEscalateRuns out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), retryEscalateRuns: 0 })).toMatch(/1\.\.48/);
    expect(queueCleanupConfigError({ ...clone(), retryEscalateRuns: 49 })).toMatch(/1\.\.48/);
  });
});

describe('deriveQueueCleanupLadderLevel (D-05, pure)', () => {
  it('L0 when all census', () => {
    expect(deriveQueueCleanupLadderLevel(clone())).toBe(0);
  });
  it('L1 on partial enforcement (have_better on Sonarr + Radarr)', () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    cfg.modes.radarr.have_better = 'enforce';
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
  });
  it('L2 when every enforceable cell is enforce', () => {
    const cfg = clone();
    for (const inst of ['sonarr', 'radarr', 'lidarr'] as const) {
      cfg.modes[inst] = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' };
    }
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function cell(o: Partial<QueueCleanupModeCells> = {}): QueueCleanupModeCells {
  return { have_better: 'census', retry_import: 'census', bad_release: 'census', ...o };
}

/** A fresh config (deep-cloned so a test can mutate cells without leaking). minItemAgeHours 0 unless set. */
function clone(o: Partial<ArrQueueCleanupConfig> = {}): ArrQueueCleanupConfig {
  return {
    modes: { sonarr: cell(), radarr: cell(), lidarr: cell() },
    maxActionsPerRun: 10,
    minItemAgeHours: 0,
    retryEscalateRuns: 6,
    ...o,
  };
}

function item(overrides: Partial<QueueCleanupQueueItem> & { queueItemId: number }): QueueCleanupQueueItem {
  return {
    downloadId: null,
    title: null,
    addedAt: null,
    status: null,
    trackedDownloadStatus: null,
    trackedDownloadState: null,
    errorMessage: null,
    statusMessages: null,
    ...overrides,
  };
}

const haveBetter = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadState: 'importBlocked',
    statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing movie file(s)'] }],
  });
const badRelease = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadStatus: 'error',
    trackedDownloadState: 'importFailed',
    statusMessages: [{ title: 'x', messages: ['Unable to parse the release title'] }],
  });
const retryImport = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadState: 'importPending',
    statusMessages: [{ title: 'x', messages: ['Waiting to import...'] }],
  });
const unknownItem = (id: number) =>
  item({
    queueItemId: id,
    downloadId: `dl-${id}`,
    trackedDownloadState: 'importPending',
    statusMessages: [{ title: 'x', messages: ['no album could be found that was close enough'] }],
  });

interface InstanceStub {
  client: QueueCleanupInstanceClient;
  calls: {
    deletes: Array<{ id: number; removeFromClient: boolean; blocklist: boolean }>;
    processMonitored: number;
    searches: number[];
    monitoredChecks: number;
  };
}

function makeInstanceStub(
  items: QueueCleanupQueueItem[],
  opts: { readError?: boolean; monitored?: boolean; deleteError?: boolean; explodeOnWrite?: boolean } = {},
): InstanceStub {
  const calls = { deletes: [] as InstanceStub['calls']['deletes'], processMonitored: 0, searches: [] as number[], monitoredChecks: 0 };
  return {
    calls,
    client: {
      async getQueueAll() {
        if (opts.readError) throw new Error('queue read failed');
        return items;
      },
      async deleteQueueItem(qi, o) {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        if (opts.deleteError) throw new Error('delete failed');
        calls.deletes.push({ id: qi.queueItemId, removeFromClient: o.removeFromClient, blocklist: o.blocklist });
      },
      async processMonitoredDownloads() {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        calls.processMonitored += 1;
      },
      async isTargetMonitored() {
        calls.monitoredChecks += 1;
        return opts.monitored ?? false;
      },
      async searchTarget(qi) {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        calls.searches.push(qi.queueItemId);
      },
    },
  };
}

function makeClients(map: Partial<Record<'sonarr' | 'radarr' | 'lidarr', QueueCleanupInstanceClient>>): QueueCleanupClients {
  const empty = () => makeInstanceStub([]).client;
  return {
    sonarr: map.sonarr ?? empty(),
    radarr: map.radarr ?? empty(),
    lidarr: map.lidarr ?? empty(),
  };
}

// ---------------------------------------------------------------------------
// Evaluator + config resolution + digest (embedded Postgres).
// ---------------------------------------------------------------------------

describe('evaluateQueueCleanup + config + digest (embedded Postgres)', () => {
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

  // --- config resolution + audit (D-05) ---

  it('setArrQueueCleanupConfig stores the config AND an update_app_setting audit row in the same tx', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    const res = await setArrQueueCleanupConfig({ db: t.db, config: cfg, actorId: null });
    expect(res.changed).toBe(true);

    const stored = await getArrQueueCleanupConfig(t.db);
    expect(stored?.modes.sonarr.have_better).toBe('enforce');
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.detail as { key?: string }).key).toBe('arr_queue_cleanup_config');
  });

  it('rejects an invalid config at the writer (QueueCleanupConfigInvalidError) and stores NO row', async () => {
    await expect(
      setArrQueueCleanupConfig({ db: t.db, config: { ...clone(), maxActionsPerRun: 999 }, actorId: null }),
    ).rejects.toBeInstanceOf(QueueCleanupConfigInvalidError);
    expect(await getArrQueueCleanupConfig(t.db)).toBeNull();
    expect(
      await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_app_setting')),
    ).toHaveLength(0);
  });

  it('resolves DB row → default; a garbage stored row fails SAFE to all-census', async () => {
    // No row ⇒ the all-census default.
    expect(await resolveArrQueueCleanupConfig(t.db)).toEqual(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);

    // A valid stored row wins.
    const cfg = clone({ maxActionsPerRun: 5 });
    cfg.modes.radarr.bad_release = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: cfg, actorId: null });
    const resolved = await resolveArrQueueCleanupConfig(t.db);
    expect(resolved.maxActionsPerRun).toBe(5);
    expect(resolved.modes.radarr.bad_release).toBe('enforce');

    // A hand-edited garbage row reads as null ⇒ all-census (a malformed cell can never accidentally enforce).
    await t.db
      .update(appSettings)
      .set({ value: { modes: 'garbage' } })
      .where(eq(appSettings.key, 'arr_queue_cleanup_config'));
    expect(await getArrQueueCleanupConfig(t.db)).toBeNull();
    expect(await resolveArrQueueCleanupConfig(t.db)).toEqual(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);
  });

  // --- evaluator (D-04/D-06) ---

  it('CENSUS: writes one row per item, NEVER calls an *arr write, all mode census', async () => {
    const sonarr = makeInstanceStub([haveBetter(1), badRelease(2), retryImport(3), unknownItem(4)], {
      explodeOnWrite: true,
    });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: clone(),
    });
    expect(report.rowsWritten).toBe(4);
    expect(report.totalFailure).toBe(false);
    expect(sonarr.calls.deletes).toHaveLength(0);
    expect(sonarr.calls.processMonitored).toBe(0);
    expect(sonarr.calls.searches).toHaveLength(0);

    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.mode === 'census')).toBe(true);
    expect(rows.every((r) => r.outcome === 'observed')).toBe(true);
    expect(rows.every((r) => r.action === 'none')).toBe(true);
    // Each class is represented (the unknown item classified unknown, never acted).
    expect(new Set(rows.map((r) => r.actionClass))).toEqual(
      new Set(['have_better', 'bad_release', 'retry_import', 'unknown']),
    );
  });

  it('ENFORCE have_better: removes + blocklists, no re-search (action removed_blocklisted)', async () => {
    const radarr = makeInstanceStub([haveBetter(10)]);
    const cfg = clone();
    cfg.modes.radarr.have_better = 'enforce';
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });

    expect(radarr.calls.deletes).toEqual([{ id: 10, removeFromClient: true, blocklist: true }]);
    expect(radarr.calls.searches).toHaveLength(0);
    const [row] = await t.db.select().from(arrQueueCleanupActions);
    expect(row!.action).toBe('removed_blocklisted');
    expect(row!.outcome).toBe('done');
  });

  it('ENFORCE bad_release: monitored → blocklist + re-search; unmonitored → blocklist only', async () => {
    const cfg = clone();
    cfg.modes.sonarr.bad_release = 'enforce';

    const monitored = makeInstanceStub([badRelease(20)], { monitored: true });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: monitored.client }), config: cfg });
    expect(monitored.calls.deletes).toHaveLength(1);
    expect(monitored.calls.searches).toEqual([20]);
    let rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows[0]!.action).toBe('blocklisted_searched');

    await t.db.delete(arrQueueCleanupActions);
    const unmonitored = makeInstanceStub([badRelease(21)], { monitored: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: unmonitored.client }), config: cfg });
    expect(unmonitored.calls.searches).toHaveLength(0);
    rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows[0]!.action).toBe('removed_blocklisted');
  });

  it('ENFORCE retry_import: runs ProcessMonitoredDownloads at most ONCE per instance per run', async () => {
    const cfg = clone();
    cfg.modes.radarr.retry_import = 'enforce';
    const radarr = makeInstanceStub([retryImport(30, 'a'), retryImport(31, 'b')]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });
    expect(radarr.calls.processMonitored).toBe(1); // one estate-wide command covers both
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows.every((r) => r.action === 'retried_import' && r.outcome === 'done')).toBe(true);
  });

  it('RAIL cap: maxActionsPerRun stops further actions (skipped_cap), census row still written', async () => {
    const cfg = clone({ maxActionsPerRun: 1 });
    cfg.modes.radarr.have_better = 'enforce';
    const radarr = makeInstanceStub([haveBetter(40), haveBetter(41)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });
    expect(radarr.calls.deletes).toHaveLength(1); // capped at 1
    const rows = await t.db.select().from(arrQueueCleanupActions).orderBy(arrQueueCleanupActions.queueItemId);
    expect(rows.map((r) => r.action)).toEqual(['removed_blocklisted', 'skipped_cap']);
  });

  it('RAIL min-age: a freshly-added item is skipped_young and never acted on', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const cfg = clone({ minItemAgeHours: 2 });
    cfg.modes.radarr.have_better = 'enforce';
    const fresh = haveBetter(50);
    fresh.addedAt = new Date(now.getTime() - 30 * 60 * 1000); // 30 min old < 2h
    const radarr = makeInstanceStub([fresh]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg, now });
    expect(radarr.calls.deletes).toHaveLength(0);
    const [row] = await t.db.select().from(arrQueueCleanupActions);
    expect(row!.action).toBe('skipped_young');
    expect(row!.outcome).toBe('observed');
  });

  it('ERROR-CONTINUE: an *arr write failure records outcome error, counts the cap, and the run continues', async () => {
    const cfg = clone();
    cfg.modes.radarr.have_better = 'enforce';
    const radarr = makeInstanceStub([haveBetter(60), haveBetter(61)], { deleteError: true });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: radarr.client }),
      config: cfg,
    });
    expect(report.instances.find((i) => i.instance === 'radarr')!.errors).toBe(2);
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(2); // both observed despite the write failures
    expect(rows.every((r) => r.outcome === 'error' && r.error !== null)).toBe(true);
  });

  it('ESCALATION: a retry_import at/over retryEscalateRuns prior runs is handled as bad_release', async () => {
    const cfg = clone({ retryEscalateRuns: 2 });
    cfg.modes.sonarr.bad_release = 'enforce';
    // Seed 2 prior retry_import observations for (sonarr, dl-esc) — the escalation lookback (test dir is
    // exempt from the single-writer guard).
    await t.db.insert(arrQueueCleanupActions).values([
      { instance: 'sonarr', queueItemId: 1, downloadId: 'dl-esc', actionClass: 'retry_import', mode: 'census', action: 'none', outcome: 'observed' },
      { instance: 'sonarr', queueItemId: 1, downloadId: 'dl-esc', actionClass: 'retry_import', mode: 'census', action: 'none', outcome: 'observed' },
    ]);
    const sonarr = makeInstanceStub([retryImport(70, 'dl-esc')], { monitored: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: cfg });
    // It escalated to bad_release + acted (delete, unmonitored ⇒ no search).
    expect(sonarr.calls.deletes).toHaveLength(1);
    const latest = await t.db
      .select()
      .from(arrQueueCleanupActions)
      .where(eq(arrQueueCleanupActions.queueItemId, 70));
    expect(latest[0]!.actionClass).toBe('bad_release');
  });

  it('totalFailure when EVERY instance queue read fails, and no rows are written', async () => {
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: {
        sonarr: makeInstanceStub([], { readError: true }).client,
        radarr: makeInstanceStub([], { readError: true }).client,
        lidarr: makeInstanceStub([], { readError: true }).client,
      },
      config: clone(),
    });
    expect(report.totalFailure).toBe(true);
    expect(report.rowsWritten).toBe(0);
    expect(await t.db.select().from(arrQueueCleanupActions)).toHaveLength(0);
  });

  it('getArrQueueCleanupStatus reports the resolved config, ladder, and 7-day summary', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: makeInstanceStub([haveBetter(80), badRelease(81)]).client }),
      config: clone(),
    });
    const status = await getArrQueueCleanupStatus({ db: t.db });
    expect(status.source).toBe('default');
    expect(status.ladder.level).toBe(0);
    const hb = status.summary.find((c) => c.instance === 'sonarr' && c.actionClass === 'have_better');
    expect(hb?.observed).toBe(1);
  });

  // --- digest (D-07) ---

  it('DIGEST: fires on a CLEAN failure ledger when the janitor observed anything (OR-enqueue)', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: makeInstanceStub([haveBetter(90), unknownItem(91)]).client }),
      config: clone(),
    });
    const report = await runFailureDigest({ db: t.db, adminEmail: 'admin@example.test' });
    expect(report.openCount).toBe(0);
    expect(report.enqueued).toBe(1);
    expect(report.queueObserved).toBe(2);

    const [row] = await t.db.select().from(notificationOutbox);
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.count).toBe(0);
    expect(payload.queueCleanup).toBeTruthy();
  });

  it('DIGEST: a clean ledger AND a janitor-silent 24h enqueues NOTHING', async () => {
    const report = await runFailureDigest({ db: t.db, adminEmail: 'admin@example.test' });
    expect(report.enqueued).toBe(0);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('DIGEST section payload rolls up per instance × class with top reasons', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: makeInstanceStub([haveBetter(100), haveBetter(101), badRelease(102)]).client }),
      config: clone(),
    });
    const section = await buildQueueCleanupDigestSection({ db: t.db });
    expect(section).not.toBeNull();
    expect(section!.observed).toBe(3);
    const radarr = section!.instances.find((i) => i.instance === 'radarr')!;
    const hb = radarr.classes.find((c) => c.actionClass === 'have_better')!;
    expect(hb.census).toBe(2);
    expect(hb.topReasons[0]!.count).toBe(2);
  });

  it('LADDER nag: promotionDue when census data spans ≥3 distinct days at L0', async () => {
    const now = new Date('2026-08-15T00:00:00Z');
    const day = (d: string) =>
      ({
        instance: 'sonarr' as const,
        queueItemId: 1,
        downloadId: 'd',
        actionClass: 'have_better' as const,
        mode: 'census' as const,
        action: 'none' as const,
        outcome: 'observed' as const,
        createdAt: new Date(d),
      });
    await t.db.insert(arrQueueCleanupActions).values([
      day('2026-08-12T00:00:00Z'),
      day('2026-08-13T00:00:00Z'),
      day('2026-08-14T00:00:00Z'),
    ]);
    const ladder = await getQueueCleanupLadder({ db: t.db, config: clone(), now });
    expect(ladder.level).toBe(0);
    expect(ladder.promotionDue).toBe(true);

    // Only one day of census ⇒ not due.
    await t.db.delete(arrQueueCleanupActions);
    await t.db.insert(arrQueueCleanupActions).values([day('2026-08-14T00:00:00Z')]);
    const ladder2 = await getQueueCleanupLadder({ db: t.db, config: clone(), now });
    expect(ladder2.promotionDue).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render (D-07) — the digest email subject + body, pure.
// ---------------------------------------------------------------------------

describe('renderOutboxEmail — activity_failure_digest janitor section (D-07)', () => {
  const section = {
    observed: 5,
    actions: 2,
    instances: [
      {
        instance: 'radarr',
        classes: [
          { actionClass: 'have_better', census: 3, enforced: 0, topReasons: [{ reason: 'Not an upgrade', count: 3 }] },
        ],
      },
    ],
    ladder: { level: 0, ageDays: 4, nextCriteria: 'L0→L1: enforce have_better…' },
    promotionDue: false,
  };

  it('renders a janitor-only census subject + body when the failure ledger is clean (count 0)', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: section },
    });
    expect(mail).not.toBeNull();
    expect(mail!.subject).toContain('Queue janitor census — 5 observed');
    expect(mail!.subject).not.toContain('promotion due');
    expect(mail!.text).toContain('Queue janitor (last 24h): 5 observed, 2 actioned.');
    expect(mail!.text).toContain('have better: 3 census');
    expect(mail!.text).toContain('/admin/janitor');
  });

  it('appends [janitor: promotion due] to the subject when the nag fires (alongside open failures)', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: {
        to: 'admin@example.test',
        count: 2,
        items: [{ title: 'Stuck', failureKind: 'import_blocked', sourceApp: 'radarr' }],
        queueCleanup: { ...section, promotionDue: true },
      },
    });
    expect(mail!.subject).toContain('2 stuck imports need attention');
    expect(mail!.subject).toContain('[janitor: promotion due]');
    // Both blocks present.
    expect(mail!.text).toContain('Open import failures at digest time');
    expect(mail!.text).toContain('Queue janitor (last 24h)');
  });
});
