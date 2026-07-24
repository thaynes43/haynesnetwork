import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mamGateState, notificationOutbox } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  computeDesiredGate,
  computeStuck,
  deriveResumeFloor,
  evaluateMamGovernor,
  resolveGovernorConfig,
  type MamGovernorClients,
  type MamGovernorTuning,
} from '../src/mam-governor';

// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor evaluator. These tests are the plan's
// acceptance proof: a deploy below the resume floor writes an OPEN BASELINE and pages nothing; a deploy in the
// dead band writes a CLOSED baseline (first sight ⇒ conservative); crossing the pause threshold enqueues
// EXACTLY ONE mam_gate_paused (same-tx with the mam_gate_state flip); a repeat enqueues zero (no double-page);
// dropping below the RESUME FLOOR (not merely the threshold) enqueues mam_gate_resumed; a failed count fails
// CLOSED; and headroom pinned at 0 for >48h enqueues mam_gate_stuck once. The same-tx outbox coupling is
// proven BOTH directions (transition ⇒ 1 row + flipped state committed together; no transition ⇒ 0 rows,
// state still refreshed).
//
// ADR-077 (PLAN-061 — resume hysteresis) — the 2026-07-23 gate-violation fix. Pause (≥ threshold) and resume
// (< resumeFloor) are DISTINCT levels; the dead band [resumeFloor, threshold) HOLDS the current state.
// Incident regression + dead-band-hold cases below prove the flap can no longer occur.

const TUNING: MamGovernorTuning = { limit: 20, buffer: 5, resumeFloor: 10, zeroHeadroomAlertHours: 48 }; // threshold 15, floor 10
// The live Elite-VIP tuning that flapped: limit 200, buffer 15 ⇒ threshold 185, floor 170.
const INCIDENT_TUNING: MamGovernorTuning = { limit: 200, buffer: 15, resumeFloor: 170, zeroHeadroomAlertHours: 48 };
const TARGETS = { category: 'books-mam', indexerId: 17 };

function counts(unsatisfied: number, downloading = 0) {
  return {
    total: unsatisfied,
    downloading,
    seedingUnder72: unsatisfied - downloading,
    unsatisfied,
  };
}

interface Stub {
  clients: MamGovernorClients;
  state: { indexerEnabled: boolean };
  calls: { count: number; get: number; set: boolean[] };
}

function makeStub(opts: {
  unsatisfied?: number;
  downloading?: number;
  countError?: boolean;
  indexerEnabled: boolean;
  readError?: boolean;
  setError?: boolean;
}): Stub {
  const state = { indexerEnabled: opts.indexerEnabled };
  const calls = { count: 0, get: 0, set: [] as boolean[] };
  return {
    state,
    calls,
    clients: {
      qb: {
        async countUnsatisfied() {
          calls.count += 1;
          if (opts.countError) throw new Error('qb unreachable');
          return counts(opts.unsatisfied ?? 0, opts.downloading ?? 0);
        },
      },
      prowlarr: {
        async getIndexerEnabled() {
          calls.get += 1;
          if (opts.readError) throw new Error('prowlarr unreachable');
          return state.indexerEnabled;
        },
        async setIndexerEnabled(_id, enabled) {
          calls.set.push(enabled);
          if (opts.setError) throw new Error('put failed');
          state.indexerEnabled = enabled;
        },
      },
    },
  };
}

describe('computeDesiredGate + computeStuck (pure)', () => {
  it('OPEN gate closes only at/above the threshold (holds through the dead band)', () => {
    // OPEN gate: holds open across the whole dead band, closes only when it reaches the threshold.
    expect(computeDesiredGate(counts(9), true, TUNING, true)).toEqual({
      desiredOpen: true,
      threshold: 15,
      resumeFloor: 10,
    });
    expect(computeDesiredGate(counts(14), true, TUNING, true).desiredOpen).toBe(true); // dead band, holds open
    expect(computeDesiredGate(counts(15), true, TUNING, true).desiredOpen).toBe(false); // reaches threshold ⇒ pause
  });

  it('CLOSED gate reopens only below the resume floor (holds through the dead band)', () => {
    expect(computeDesiredGate(counts(9), true, TUNING, false).desiredOpen).toBe(true); // below floor ⇒ reopen
    expect(computeDesiredGate(counts(10), true, TUNING, false).desiredOpen).toBe(false); // at floor, holds closed
    expect(computeDesiredGate(counts(14), true, TUNING, false).desiredOpen).toBe(false); // dead band, holds closed
    expect(computeDesiredGate(counts(15), true, TUNING, false).desiredOpen).toBe(false); // over threshold, closed
  });

  it('the incident value can no longer resume: closed gate at 184 stays closed (threshold 185, floor 170)', () => {
    expect(computeDesiredGate(counts(184), true, INCIDENT_TUNING, false).desiredOpen).toBe(false);
    expect(computeDesiredGate(counts(169), true, INCIDENT_TUNING, false).desiredOpen).toBe(true); // < floor 170
  });

  it('fail-closed on !countOk regardless of the prior gate state', () => {
    expect(computeDesiredGate(counts(0), false, TUNING, true).desiredOpen).toBe(false);
    expect(computeDesiredGate(counts(0), false, TUNING, false).desiredOpen).toBe(false);
  });

  it('derives the resume floor as limit - 2*buffer, clamped to [0, threshold - 1]', () => {
    expect(deriveResumeFloor(20, 5, 15)).toBe(10); // code default
    expect(deriveResumeFloor(200, 15, 185)).toBe(170); // live Elite-VIP
    expect(deriveResumeFloor(5, 4, 1)).toBe(0); // 2*buffer > limit ⇒ clamp up to 0
    expect(deriveResumeFloor(10, 0, 10)).toBe(9); // buffer 0 ⇒ clamp down to threshold - 1 (never == threshold)
  });

  it('starts the zero-headroom timer at the cap, fires stuck after 48h once, clears below the cap', () => {
    const t0 = new Date('2026-07-11T00:00:00Z');
    const started = computeStuck(undefined, counts(20), true, TUNING, t0);
    expect(started.zeroHeadroomSince).toEqual(t0);
    expect(started.stuckEvent).toBeNull();
    const later = new Date('2026-07-13T01:00:00Z'); // 49h later
    const prev = { zeroHeadroomSince: t0, pinnedAlertedAt: null };
    const fired = computeStuck(prev, counts(20), true, TUNING, later);
    expect(fired.stuckEvent).toBe('mam_gate_stuck');
    expect(fired.pinnedAlertedAt).toEqual(later);
    // Already alerted this episode ⇒ no re-fire.
    const again = computeStuck(
      { zeroHeadroomSince: t0, pinnedAlertedAt: later },
      counts(20),
      true,
      TUNING,
      new Date('2026-07-13T02:00:00Z'),
    );
    expect(again.stuckEvent).toBeNull();
    // Headroom returns ⇒ timer cleared.
    const cleared = computeStuck(prev, counts(5), true, TUNING, later);
    expect(cleared.zeroHeadroomSince).toBeNull();
  });
});

describe('resolveGovernorConfig (the PLAN-040 seam)', () => {
  it('defaults to 20/5/10/48 (resume floor derived limit - 2*buffer) and reads env overrides; clamps buffer < limit', async () => {
    expect(await resolveGovernorConfig({ env: {} })).toEqual({
      limit: 20,
      buffer: 5,
      resumeFloor: 10,
      zeroHeadroomAlertHours: 48,
    });
    expect(
      await resolveGovernorConfig({
        // Live Elite-VIP tuning ⇒ threshold 185, derived floor 170.
        env: { MAM_UNSATISFIED_LIMIT: '200', MAM_UNSATISFIED_BUFFER: '15' },
      }),
    ).toEqual({
      limit: 200,
      buffer: 15,
      resumeFloor: 170,
      zeroHeadroomAlertHours: 48,
    });
    // buffer >= limit is clamped so the gate can never be permanently wedged closed.
    expect(
      (
        await resolveGovernorConfig({
          env: { MAM_UNSATISFIED_LIMIT: '5', MAM_UNSATISFIED_BUFFER: '99' },
        })
      ).buffer,
    ).toBe(4);
  });

  it('honors a valid MAM_RESUME_FLOOR override (absolute count, 0 <= floor < threshold)', async () => {
    const t = await resolveGovernorConfig({
      env: { MAM_UNSATISFIED_LIMIT: '200', MAM_UNSATISFIED_BUFFER: '15', MAM_RESUME_FLOOR: '150' },
    });
    expect(t.resumeFloor).toBe(150); // overrides the derived 170
    expect(t.limit - t.buffer).toBe(185); // threshold unchanged
  });

  it('falls back to the derived floor (and warns) on an invalid MAM_RESUME_FLOOR (>= threshold, negative, garbage)', async () => {
    for (const bad of ['185', '999', '-3', 'nope', '']) {
      const warnings: string[] = [];
      const t = await resolveGovernorConfig({
        env: { MAM_UNSATISFIED_LIMIT: '200', MAM_UNSATISFIED_BUFFER: '15', MAM_RESUME_FLOOR: bad },
        warn: (message) => warnings.push(message),
      });
      expect(t.resumeFloor).toBe(170); // derived default
      // An empty string is "unset" (no warning); a present-but-invalid value warns exactly once.
      expect(warnings).toHaveLength(bad === '' ? 0 : 1);
    }
  });
});

describe('evaluateMamGovernor (embedded Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.db.delete(notificationOutbox);
    await t.db.delete(mamGateState);
  });

  it('first run BELOW the resume floor writes a BASELINE, gate OPEN, and pages nothing (live-validation)', async () => {
    const stub = makeStub({ unsatisfied: 8, indexerEnabled: true }); // 8 < floor 10 ⇒ open
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: stub.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.gateOpen).toBe(true);
    expect(r.event).toBeNull();
    expect(r.enqueued).toBe(0);
    expect(r.resumeFloor).toBe(10);
    expect(stub.calls.set).toHaveLength(0); // no actuation — already enabled
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    const rows = await t.db.select().from(mamGateState);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gateOpen).toBe(true);
    expect(rows[0]!.unsatisfiedCount).toBe(8);
    expect(rows[0]!.threshold).toBe(15);
  });

  it('UNKNOWN prior state (first sight) is treated as CLOSED: a dead-band count writes a CLOSED baseline, no page', async () => {
    // 13 sits in the dead band [10, 15). With no state row the gate is conservatively CLOSED (reopen needs < 10).
    const stub = makeStub({ unsatisfied: 13, indexerEnabled: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: stub.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.previousGateOpen).toBeNull(); // first sight
    expect(r.gateOpen).toBe(false); // conservative CLOSED
    expect(r.event).toBeNull(); // baseline never pages
    expect(stub.calls.set).toEqual([false]); // actuated the indexer closed (was enabled)
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    expect((await t.db.select().from(mamGateState))[0]!.gateOpen).toBe(false);
  });

  it('crossing the threshold enqueues EXACTLY ONE mam_gate_paused same-tx; a repeat enqueues zero', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 8, indexerEnabled: true }).clients, // open baseline (< floor 10)
      targets: TARGETS,
      tuning: TUNING,
    });

    const paused = makeStub({ unsatisfied: 16, indexerEnabled: true });
    const r2 = await evaluateMamGovernor({
      db: t.db,
      clients: paused.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r2.event).toBe('mam_gate_paused');
    expect(r2.gateOpen).toBe(false);
    expect(paused.calls.set).toEqual([false]); // actuated the Prowlarr indexer disable
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('mam_gate_paused');
    expect((await t.db.select().from(mamGateState))[0]!.gateOpen).toBe(false); // flipped same-tx

    // Still over threshold, indexer already disabled — no transition, no double-page (state still refreshed).
    const stayPaused = makeStub({ unsatisfied: 16, indexerEnabled: false });
    const r3 = await evaluateMamGovernor({
      db: t.db,
      clients: stayPaused.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r3.event).toBeNull();
    expect(stayPaused.calls.set).toHaveLength(0);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(1);
  });

  it('INCIDENT REGRESSION: a CLOSED gate at 184 stays closed (threshold 185, floor 170) — no mam_gate_resumed', async () => {
    // Seed a CLOSED gate at 190 (over threshold), then the exact 07-22 23:49 value that used to resume.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 190, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect((await t.db.select().from(mamGateState))[0]!.gateOpen).toBe(false);

    const held = makeStub({ unsatisfied: 184, indexerEnabled: false });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: held.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r.gateOpen).toBe(false); // dead band holds closed — the flap can't start
    expect(r.event).toBeNull();
    expect(held.calls.set).toHaveLength(0); // already disabled, no actuation
    expect(
      (await t.db.select().from(notificationOutbox)).filter(
        (o) => o.eventType === 'mam_gate_resumed',
      ),
    ).toHaveLength(0);
  });

  it('a CLOSED gate reopens only once unsatisfied drops BELOW the floor (169 < 170)', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 190, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    const reopened = makeStub({ unsatisfied: 169, indexerEnabled: false });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: reopened.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r.gateOpen).toBe(true);
    expect(r.event).toBe('mam_gate_resumed');
    expect(reopened.calls.set).toEqual([true]);
  });

  it('an OPEN gate holds through the dead band (184) and pauses at the threshold (185)', async () => {
    // Open baseline below the floor, then a dead-band value: stays open, no page.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 100, indexerEnabled: true }).clients, // < floor 170 ⇒ open baseline
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    const held = makeStub({ unsatisfied: 184, indexerEnabled: true });
    const r1 = await evaluateMamGovernor({
      db: t.db,
      clients: held.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r1.gateOpen).toBe(true); // dead band holds open
    expect(r1.event).toBeNull();
    expect(held.calls.set).toHaveLength(0);

    const paused = makeStub({ unsatisfied: 185, indexerEnabled: true });
    const r2 = await evaluateMamGovernor({
      db: t.db,
      clients: paused.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r2.gateOpen).toBe(false); // reaches threshold ⇒ pause
    expect(r2.event).toBe('mam_gate_paused');
    expect(paused.calls.set).toEqual([false]);
  });

  it('holds in the dead band across CONSECUTIVE runs both directions — no event spam', async () => {
    // CLOSED holds closed across three dead-band samples (183, 184, 183) — zero pages.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 190, indexerEnabled: true }).clients, // closed baseline
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    for (const u of [183, 184, 183]) {
      const s = makeStub({ unsatisfied: u, indexerEnabled: false });
      const r = await evaluateMamGovernor({
        db: t.db,
        clients: s.clients,
        targets: TARGETS,
        tuning: INCIDENT_TUNING,
      });
      expect(r.gateOpen).toBe(false);
      expect(r.event).toBeNull();
      expect(s.calls.set).toHaveLength(0);
    }
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);

    // Now OPEN holds open across three dead-band samples (172, 180, 175) — still zero pages.
    await t.db.delete(notificationOutbox);
    await t.db.delete(mamGateState);
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 100, indexerEnabled: true }).clients, // open baseline
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    for (const u of [172, 180, 175]) {
      const s = makeStub({ unsatisfied: u, indexerEnabled: true });
      const r = await evaluateMamGovernor({
        db: t.db,
        clients: s.clients,
        targets: TARGETS,
        tuning: INCIDENT_TUNING,
      });
      expect(r.gateOpen).toBe(true);
      expect(r.event).toBeNull();
      expect(s.calls.set).toHaveLength(0);
    }
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('headroom returning enqueues mam_gate_resumed and re-enables the indexer', async () => {
    // Seed a paused state.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 16, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    const resumed = makeStub({ unsatisfied: 8, indexerEnabled: false });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: resumed.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.event).toBe('mam_gate_resumed');
    expect(r.gateOpen).toBe(true);
    expect(resumed.calls.set).toEqual([true]);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox.map((o) => o.eventType)).toContain('mam_gate_resumed');
  });

  it('fails CLOSED on a count failure: gate closes, indexer disabled, count_failed reason', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 8, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    const failed = makeStub({ countError: true, indexerEnabled: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: failed.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.countOk).toBe(false);
    expect(r.gateOpen).toBe(false);
    expect(r.event).toBe('mam_gate_paused');
    expect(failed.calls.set).toEqual([false]);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect((outbox[0]!.payload as { reason?: string }).reason).toBe('count_failed');
  });

  it('does NOT page a transition when the actuation fails (gate did not actually change)', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 8, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    // Want to pause (16 >= 15) but the PUT throws — the indexer stays enabled, so no false "paused" page.
    const stuck = makeStub({ unsatisfied: 16, indexerEnabled: true, setError: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: stuck.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.actuationError).toBeDefined();
    expect(r.event).toBeNull(); // gate did not actually flip
    expect(r.gateOpen).toBe(true);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('enqueues mam_gate_stuck once after 48h of pinned-at-0 headroom, then not again', async () => {
    const t0 = new Date('2026-07-11T00:00:00Z');
    // Baseline at the hard cap (20) — gate closes, no page (first run), zero-headroom timer starts.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 20, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: TUNING,
      now: t0,
    });
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);

    // 49h later, still pinned at 20 → stuck fires once.
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 20, indexerEnabled: false }).clients,
      targets: TARGETS,
      tuning: TUNING,
      now: new Date('2026-07-13T01:00:00Z'),
    });
    expect(r.stuckAlerted).toBe(true);
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox.map((o) => o.eventType)).toEqual(['mam_gate_stuck']);

    // 50h later, still pinned — deduped, no second stuck page.
    const r2 = await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 20, indexerEnabled: false }).clients,
      targets: TARGETS,
      tuning: TUNING,
      now: new Date('2026-07-13T02:00:00Z'),
    });
    expect(r2.stuckAlerted).toBe(false);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(1);
  });
});
