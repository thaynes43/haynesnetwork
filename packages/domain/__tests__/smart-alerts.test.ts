import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationOutbox, smartDriveState } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  detectSmartTransition,
  evaluateSmartAlerts,
  type SmartDriveReading,
} from '../src/smart-alerts';

// ADR-040 / DESIGN-020 (PLAN-019) — the SMART-alert transition detector. These tests are the plan's
// acceptance proof: the KNOWN staging-pool bad state records a BASELINE and enqueues ZERO rows; a forced
// critical transition enqueues EXACTLY ONE; a repeat of that reading enqueues zero (no double-push).

function reading(over: Partial<SmartDriveReading> & { driveKey: string }): SmartDriveReading {
  return {
    label: over.driveKey,
    pool: null,
    criticalPool: false,
    smartStatus: 'pass',
    wearPct: 0,
    mediaErrors: 0,
    availableSpare: 100,
    availableSpareThreshold: 5,
    criticalWarning: 0,
    ...over,
  };
}

// The LIVE 2026-07-10 NAS cache state (owner-normative acceptance scenario).
const STAGING_1 = reading({
  driveKey: 'haynestower/nvme1',
  pool: 'Cache-staging',
  smartStatus: 'fail',
  wearPct: 100,
  criticalWarning: 4, // bit 2 set — the known baseline
});
const STAGING_2 = reading({
  driveKey: 'haynestower/nvme2',
  pool: 'Cache-staging',
  smartStatus: 'fail',
  wearPct: 100,
  criticalWarning: 4,
});
const APPS_0 = reading({ driveKey: 'haynestower/nvme0', pool: 'Cache-apps', criticalPool: true, wearPct: 57 });
const APPS_3 = reading({ driveKey: 'haynestower/nvme3', pool: 'Cache-apps', criticalPool: true, wearPct: 60 });
const BASELINE = [STAGING_1, STAGING_2, APPS_0, APPS_3];

describe('detectSmartTransition (pure)', () => {
  const prior = { smartStatus: 'pass' as const, wearPct: 57, mediaErrors: 0, availableSpare: 100, criticalWarning: 0 };

  it('pages on pass→FAIL', () => {
    const r = detectSmartTransition(prior, reading({ driveKey: 'x', smartStatus: 'fail', wearPct: 57 }));
    expect(r.event).toBe('smart_degraded');
    expect(r.reasons).toContain('smart_status');
  });

  it('pages on media_errors climbing', () => {
    const r = detectSmartTransition(prior, reading({ driveKey: 'x', wearPct: 57, mediaErrors: 1 }));
    expect(r.reasons).toContain('media_errors');
  });

  it('pages on available_spare crossing its threshold margin', () => {
    // threshold 5, margin 10 → crosses when spare drops to <= 15 from above.
    const r = detectSmartTransition(
      { ...prior, availableSpare: 40 },
      reading({ driveKey: 'x', wearPct: 57, availableSpare: 12, availableSpareThreshold: 5 }),
    );
    expect(r.reasons).toContain('available_spare');
  });

  it('pages only on a NEW critical_warning bit (a known bit never re-fires)', () => {
    // prior already has bit 2 (value 4); current still 4 → no new bit.
    const known = detectSmartTransition({ ...prior, criticalWarning: 4 }, reading({ driveKey: 'x', wearPct: 57, criticalWarning: 4 }));
    expect(known.event).toBeNull();
    // a NEW bit (value 1 added → 5) → pages.
    const fresh = detectSmartTransition({ ...prior, criticalWarning: 4 }, reading({ driveKey: 'x', wearPct: 57, criticalWarning: 5 }));
    expect(fresh.reasons).toContain('critical_warning');
  });

  it('pages on the CRITICAL pool crossing 80/90 %, but NOT the expendable pool', () => {
    const crit = detectSmartTransition({ ...prior, wearPct: 79 }, reading({ driveKey: 'x', criticalPool: true, wearPct: 91 }));
    expect(crit.reasons).toEqual(expect.arrayContaining(['wear_80', 'wear_90']));
    const expendable = detectSmartTransition({ ...prior, wearPct: 79 }, reading({ driveKey: 'x', criticalPool: false, wearPct: 91 }));
    expect(expendable.event).toBeNull();
  });

  it('the known staging baseline (FAILED + bit 2 + wear 100) produces NO transition', () => {
    const prev = { smartStatus: 'fail' as const, wearPct: 100, mediaErrors: 0, availableSpare: 100, criticalWarning: 4 };
    const r = detectSmartTransition(prev, STAGING_1);
    expect(r.event).toBeNull();
  });

  it('pages recovery on FAIL→pass', () => {
    const r = detectSmartTransition({ ...prior, smartStatus: 'fail' }, reading({ driveKey: 'x', smartStatus: 'pass', wearPct: 57 }));
    expect(r.event).toBe('smart_recovered');
  });
});

describe('evaluateSmartAlerts (embedded Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.db.delete(notificationOutbox);
    await t.db.delete(smartDriveState);
  });

  it('records a BASELINE for the known staging state and enqueues ZERO rows', async () => {
    const report = await evaluateSmartAlerts({ db: t.db, drives: BASELINE });
    expect(report.baselined).toBe(4);
    expect(report.enqueued).toBe(0);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    expect(await t.db.select().from(smartDriveState)).toHaveLength(4);
  });

  it('a forced media_errors 0→1 enqueues EXACTLY ONE smart_degraded row; a repeat enqueues zero', async () => {
    await evaluateSmartAlerts({ db: t.db, drives: BASELINE }); // baseline first
    const degraded = [{ ...STAGING_1, mediaErrors: 1 }, STAGING_2, APPS_0, APPS_3];

    const r2 = await evaluateSmartAlerts({ db: t.db, drives: degraded });
    expect(r2.enqueued).toBe(1);
    expect(r2.degraded).toBe(1);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('smart_degraded');
    expect((outbox[0]!.payload as { driveKey?: string }).driveKey).toBe('haynestower/nvme1');

    // Same still-degraded reading again — the state now matches, so NO double-push.
    const r3 = await evaluateSmartAlerts({ db: t.db, drives: degraded });
    expect(r3.enqueued).toBe(0);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(1);
  });

  it('the CRITICAL pool crossing a wear mark pages; the expendable pool crossing does NOT', async () => {
    const crit = reading({ driveKey: 'haynestower/nvme0', pool: 'Cache-apps', criticalPool: true, wearPct: 79 });
    const expendable = reading({
      driveKey: 'haynestower/nvme1',
      pool: 'Cache-staging',
      criticalPool: false,
      smartStatus: 'fail',
      wearPct: 50,
      criticalWarning: 4,
    });
    await evaluateSmartAlerts({ db: t.db, drives: [crit, expendable] });

    const r = await evaluateSmartAlerts({
      db: t.db,
      drives: [
        { ...crit, wearPct: 91 }, // crosses 80 AND 90 → one smart_degraded
        { ...expendable, wearPct: 85 }, // expendable: excluded from the wear marks → no page
      ],
    });
    expect(r.degraded).toBe(1);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect((outbox[0]!.payload as { driveKey?: string }).driveKey).toBe('haynestower/nvme0');
  });

  it('enqueues a smart_recovered row on FAIL→pass', async () => {
    const drive = reading({ driveKey: 'cluster/nvme0n1', smartStatus: 'fail', wearPct: 25 });
    await evaluateSmartAlerts({ db: t.db, drives: [drive] });
    const r = await evaluateSmartAlerts({ db: t.db, drives: [{ ...drive, smartStatus: 'pass' }] });
    expect(r.recovered).toBe(1);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('smart_recovered');
  });
});
