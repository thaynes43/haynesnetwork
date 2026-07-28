import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, mamGateState, notificationOutbox, permissionAudit } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  computeDesiredGate,
  computeStuck,
  computeTrendOverride,
  deriveResumeFloor,
  evaluateMamGovernor,
  getMamGovernorConfig,
  getMamGovernorStatus,
  governorConfigError,
  resolveGovernorConfig,
  resolveGovernorConfigResolution,
  setMamGovernorConfig,
  type GateTrendSample,
  type MamGovernorClients,
  type MamGovernorConfig,
  type MamGovernorTuning,
} from '../src/mam-governor';
import { GovernorConfigInvalidError } from '../src/errors';

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

// threshold 15, floor 10, dead band [10, 15); trend override at +15 (never bites in this narrow band).
const TUNING: MamGovernorTuning = {
  limit: 20,
  buffer: 5,
  resumeFloor: 10,
  trendPauseDelta: 15,
  zeroHeadroomAlertHours: 48,
};
// The live Elite-VIP tuning that flapped: limit 200, buffer 15 ⇒ threshold 185, floor 170, dead band
// [170, 185). trendPauseDelta 15 — a single-interval rise of ≥ 15 inside the band pauses (ADR-082 C-01).
const INCIDENT_TUNING: MamGovernorTuning = {
  limit: 200,
  buffer: 15,
  resumeFloor: 170,
  trendPauseDelta: 15,
  zeroHeadroomAlertHours: 48,
};
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

describe('computeTrendOverride (ADR-082 C-01/C-02, pure)', () => {
  const now = new Date('2026-07-28T12:00:00Z');
  const fresh: GateTrendSample = { count: 150, observedAt: new Date('2026-07-28T11:50:00Z') }; // 10 min ago
  const stale: GateTrendSample = { count: 150, observedAt: new Date('2026-07-28T11:20:00Z') }; // 40 min ago

  it('FIRES on a dead-band rise ≥ delta while OPEN (172 vs 150 = +22 ≥ 15)', () => {
    const r = computeTrendOverride({
      unsatisfied: 172,
      countOk: true,
      priorOpen: true,
      baseDesiredOpen: true,
      tuning: INCIDENT_TUNING,
      previous: fresh,
      now,
    });
    expect(r).toEqual({ delta: 22, fires: true });
  });

  it('does NOT fire on a sub-delta rise (165 vs 150 = +15 fires; 164 = +14 holds)', () => {
    expect(
      computeTrendOverride({
        unsatisfied: 164,
        countOk: true,
        priorOpen: true,
        baseDesiredOpen: true,
        tuning: INCIDENT_TUNING,
        previous: fresh,
        now,
      }),
    ).toEqual({ delta: 14, fires: false });
  });

  it('is CLOSE-ONLY: never fires when the gate is already CLOSED (priorOpen false)', () => {
    expect(
      computeTrendOverride({
        unsatisfied: 180,
        countOk: true,
        priorOpen: false, // closed — the override only pauses an OPEN gate
        baseDesiredOpen: false,
        tuning: INCIDENT_TUNING,
        previous: fresh,
        now,
      }).fires,
    ).toBe(false);
  });

  it('does NOT fire on a MISSING previous sample (first run) — delta null', () => {
    expect(
      computeTrendOverride({
        unsatisfied: 184,
        countOk: true,
        priorOpen: true,
        baseDesiredOpen: true,
        tuning: INCIDENT_TUNING,
        previous: null,
        now,
      }),
    ).toEqual({ delta: null, fires: false });
  });

  it('does NOT fire on a STALE previous sample (gap > 2 intervals) — never a delta against ancient data', () => {
    expect(
      computeTrendOverride({
        unsatisfied: 184,
        countOk: true,
        priorOpen: true,
        baseDesiredOpen: true,
        tuning: INCIDENT_TUNING,
        previous: stale,
        now,
      }),
    ).toEqual({ delta: null, fires: false });
  });

  it('does NOT fire OUTSIDE the dead band (below the floor, or when the edge already pauses)', () => {
    // 160 < floor 170 (below the band): a big rise there just keeps the gate open, no trend pause.
    expect(
      computeTrendOverride({
        unsatisfied: 160,
        countOk: true,
        priorOpen: true,
        baseDesiredOpen: true,
        tuning: INCIDENT_TUNING,
        previous: { count: 130, observedAt: fresh.observedAt },
        now,
      }).fires,
    ).toBe(false);
    // 185 ≥ threshold: the edge already pauses (baseDesiredOpen false), so it is an edge pause, not trend.
    expect(
      computeTrendOverride({
        unsatisfied: 185,
        countOk: true,
        priorOpen: true,
        baseDesiredOpen: false,
        tuning: INCIDENT_TUNING,
        previous: fresh,
        now,
      }).fires,
    ).toBe(false);
  });

  it('does NOT fire on a failed count (fail-closed owns that path)', () => {
    expect(
      computeTrendOverride({
        unsatisfied: 0,
        countOk: false,
        priorOpen: true,
        baseDesiredOpen: false,
        tuning: INCIDENT_TUNING,
        previous: fresh,
        now,
      }).fires,
    ).toBe(false);
  });
});

describe('governorConfigError (ADR-082 C-04, pure)', () => {
  const ok: MamGovernorConfig = { limit: 200, buffer: 90, resumeFloor: 60, trendPauseDelta: 15 };
  it('accepts a valid decoupled config (edge 110, floor 60 < edge)', () => {
    expect(governorConfigError(ok)).toBeNull();
  });
  it('rejects limit > 200 (the hard MAM cap)', () => {
    expect(governorConfigError({ ...ok, limit: 201 })).toMatch(/hard cap/);
  });
  it('rejects a non-positive edge (buffer ≥ limit)', () => {
    expect(governorConfigError({ limit: 20, buffer: 20, resumeFloor: 0, trendPauseDelta: 15 })).toMatch(
      /pause edge/,
    );
  });
  it('rejects a negative resume floor', () => {
    expect(governorConfigError({ ...ok, resumeFloor: -1 })).toMatch(/cannot be negative/);
  });
  it('rejects a resume floor ≥ the edge (the ADR-077 wedge class)', () => {
    expect(governorConfigError({ limit: 200, buffer: 90, resumeFloor: 110, trendPauseDelta: 15 })).toMatch(
      /below the pause edge/,
    );
  });
  it('rejects a trend delta < 1', () => {
    expect(governorConfigError({ ...ok, trendPauseDelta: 0 })).toMatch(/at least 1/);
  });
  it('rejects non-integers', () => {
    expect(governorConfigError({ ...ok, limit: 200.5 })).toMatch(/whole number/);
  });
});

describe('resolveGovernorConfig (the PLAN-040 seam)', () => {
  it('defaults to 20/5/10/48 (resume floor derived limit - 2*buffer) and reads env overrides; clamps buffer < limit', async () => {
    expect(await resolveGovernorConfig({ env: {} })).toEqual({
      limit: 20,
      buffer: 5,
      resumeFloor: 10,
      trendPauseDelta: 15,
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
      trendPauseDelta: 15,
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

  it('an OPEN gate GENTLY climbing holds through the dead band (172, 184) and pauses at the threshold (185)', async () => {
    // Open baseline just below the floor (169 < 170 ⇒ open), then small single-interval rises (+3, +12,
    // both < the +15 trend delta) so the dead band HOLDS open — pausing only when the count reaches the edge.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients, // < floor 170 ⇒ open baseline
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    for (const u of [172, 184]) {
      const held = makeStub({ unsatisfied: u, indexerEnabled: true });
      const r = await evaluateMamGovernor({
        db: t.db,
        clients: held.clients,
        targets: TARGETS,
        tuning: INCIDENT_TUNING,
      });
      expect(r.gateOpen).toBe(true); // dead band holds open (gentle rise, trend does not bite)
      expect(r.event).toBeNull();
      expect(held.calls.set).toHaveLength(0);
    }

    const paused = makeStub({ unsatisfied: 185, indexerEnabled: true });
    const r2 = await evaluateMamGovernor({
      db: t.db,
      clients: paused.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r2.gateOpen).toBe(false); // reaches threshold ⇒ pause
    expect(r2.event).toBe('mam_gate_paused');
    expect(r2.reason).toBe('edge'); // paused by the edge, not the trend
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

    // Now OPEN holds open across three GENTLE dead-band samples (172, 173, 172; deltas +3/+1/−1, all under
    // the +15 trend delta) — still zero pages. (A large single-interval rise would trend-pause; covered below.)
    await t.db.delete(notificationOutbox);
    await t.db.delete(mamGateState);
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients, // open baseline (< floor 170)
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    for (const u of [172, 173, 172]) {
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

  // ADR-082 C-01 — the trend override: a fast climb inside the dead band pauses an OPEN gate even though
  // the count never reaches the edge (the 07-25 hazard the symmetric hold missed). Close-only + reason trend.
  it('TREND OVERRIDE: a dead-band rise ≥ delta pauses an OPEN gate (reason trend), and does not reopen until below the floor', async () => {
    // Open baseline just below the floor (169 < 170 ⇒ open); records last_observed = 169.
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    // 184 is inside the dead band [170, 185) and rose +15 (≥ trendPauseDelta) — trend pauses BEFORE the edge.
    const climbed = makeStub({ unsatisfied: 184, indexerEnabled: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: climbed.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r.gateOpen).toBe(false);
    expect(r.event).toBe('mam_gate_paused');
    expect(r.reason).toBe('trend');
    expect(r.delta).toBe(15);
    expect(climbed.calls.set).toEqual([false]); // actuated the indexer closed
    const outbox = await t.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect((outbox[0]!.payload as { reason?: string }).reason).toBe('trend');

    // CLOSE-ONLY: still in the dead band (175), the trend never reopens — resume waits for the floor.
    const held = makeStub({ unsatisfied: 175, indexerEnabled: false });
    const r2 = await evaluateMamGovernor({
      db: t.db,
      clients: held.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r2.gateOpen).toBe(false);
    expect(r2.event).toBeNull();
    expect(held.calls.set).toHaveLength(0);

    // Only once it drops below the floor (169 < 170) does it reopen.
    const reopened = makeStub({ unsatisfied: 169, indexerEnabled: false });
    const r3 = await evaluateMamGovernor({
      db: t.db,
      clients: reopened.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r3.gateOpen).toBe(true);
    expect(r3.event).toBe('mam_gate_resumed');
  });

  it('a GENTLE dead-band rise (below the delta) does NOT trend-pause', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    const gentle = makeStub({ unsatisfied: 178, indexerEnabled: true }); // +9 < 15
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: gentle.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
    });
    expect(r.gateOpen).toBe(true);
    expect(r.event).toBeNull();
    expect(r.delta).toBe(9);
    expect(gentle.calls.set).toHaveLength(0);
  });

  it('a STALE previous sample (gap > 2 intervals) disables the override — a big rise holds open', async () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
      now: t0,
    });
    // 31 minutes later (> 2 × 15-min intervals) the previous sample is ancient — no delta, so a +15 rise
    // in the dead band does NOT trend-pause (it holds open until the edge / a fresh in-band climb).
    const late = makeStub({ unsatisfied: 184, indexerEnabled: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: late.clients,
      targets: TARGETS,
      tuning: INCIDENT_TUNING,
      now: new Date(t0.getTime() + 31 * 60 * 1000),
    });
    expect(r.gateOpen).toBe(true); // stale sample ⇒ override disabled ⇒ dead band holds open
    expect(r.event).toBeNull();
    expect(r.delta).toBeNull();
    expect(late.calls.set).toHaveLength(0);
  });

  // ADR-082 C-03 — the DB-backed config: setMamGovernorConfig validates + audits; resolution reads DB
  // first (provenance db), then env, then default; getMamGovernorStatus surfaces gate + config + history.
  describe('DB-backed config + status (ADR-082 C-03/C-04/C-05)', () => {
    beforeEach(async () => {
      await t.db.delete(permissionAudit);
      await t.db.delete(appSettings);
      await t.db.delete(notificationOutbox);
      await t.db.delete(mamGateState);
    });

    it('setMamGovernorConfig stores the knobs AND an update_app_setting audit row in the same tx', async () => {
      const config: MamGovernorConfig = { limit: 200, buffer: 90, resumeFloor: 60, trendPauseDelta: 20 };
      const res = await setMamGovernorConfig({ db: t.db, config, actorId: null });
      expect(res.changed).toBe(true);
      expect(await getMamGovernorConfig(t.db)).toEqual(config);
      const audits = await t.db
        .select()
        .from(permissionAudit)
        .where(eq(permissionAudit.action, 'update_app_setting'));
      expect(audits).toHaveLength(1);
      expect((audits[0]!.detail as { key?: string }).key).toBe('mam_governor_config');
    });

    it('rejects an invalid config at the writer (GovernorConfigInvalidError) and stores NO row', async () => {
      await expect(
        // resumeFloor 150 ≥ edge 110 — the unsatisfiable-floor wedge class (ADR-077 C-03).
        setMamGovernorConfig({
          db: t.db,
          config: { limit: 200, buffer: 90, resumeFloor: 150, trendPauseDelta: 15 },
          actorId: null,
        }),
      ).rejects.toBeInstanceOf(GovernorConfigInvalidError);
      expect(await getMamGovernorConfig(t.db)).toBeNull(); // nothing stored
      expect(
        await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_app_setting')),
      ).toHaveLength(0);
    });

    it('resolution precedence is DB → env → default, with per-value provenance', async () => {
      // No row + no env ⇒ code defaults (all provenance 'default').
      const def = await resolveGovernorConfigResolution({ db: t.db, env: {} });
      expect(def.tuning).toEqual({
        limit: 20,
        buffer: 5,
        resumeFloor: 10,
        trendPauseDelta: 15,
        zeroHeadroomAlertHours: 48,
      });
      expect(def.provenance.limit).toBe('default');
      expect(def.provenance.resumeFloor).toBe('default');

      // Env only (still no DB row) ⇒ env tier.
      const viaEnv = await resolveGovernorConfigResolution({
        db: t.db,
        env: { MAM_UNSATISFIED_LIMIT: '150', MAM_UNSATISFIED_BUFFER: '20', MAM_TREND_PAUSE_DELTA: '12' },
      });
      expect(viaEnv.tuning.limit).toBe(150);
      expect(viaEnv.tuning.trendPauseDelta).toBe(12);
      expect(viaEnv.provenance.limit).toBe('env');
      expect(viaEnv.provenance.trendPauseDelta).toBe('env');

      // A DB row WINS over env (all four knobs come from DB); env is now dead.
      await setMamGovernorConfig({
        db: t.db,
        config: { limit: 200, buffer: 90, resumeFloor: 60, trendPauseDelta: 25 },
        actorId: null,
      });
      const viaDb = await resolveGovernorConfigResolution({
        db: t.db,
        env: { MAM_UNSATISFIED_LIMIT: '150', MAM_UNSATISFIED_BUFFER: '20' },
      });
      expect(viaDb.tuning).toEqual({
        limit: 200,
        buffer: 90,
        resumeFloor: 60,
        trendPauseDelta: 25,
        zeroHeadroomAlertHours: 48,
      });
      expect(viaDb.provenance.limit).toBe('db');
      expect(viaDb.provenance.buffer).toBe('db');
      expect(viaDb.provenance.resumeFloor).toBe('db');
      expect(viaDb.provenance.trendPauseDelta).toBe('db');
    });

    it('getMamGovernorStatus returns null gate before the first run, then the resolved config + gate + transitions', async () => {
      // Config-only, no governor run yet ⇒ gate null but config resolves from the DB row (provenance db).
      await setMamGovernorConfig({
        db: t.db,
        config: { limit: 200, buffer: 15, resumeFloor: 170, trendPauseDelta: 15 },
        actorId: null,
      });
      const pre = await getMamGovernorStatus({ db: t.db, env: {} });
      expect(pre.gate).toBeNull();
      expect(pre.config.limit).toEqual({ value: 200, source: 'db' });
      expect(pre.config.resumeFloor).toEqual({ value: 170, source: 'db' });

      // Run once at an open baseline, then a trend pause — the status now shows the gate + one transition.
      await evaluateMamGovernor({
        db: t.db,
        clients: makeStub({ unsatisfied: 169, indexerEnabled: true }).clients,
        targets: TARGETS,
        tuning: INCIDENT_TUNING,
      });
      await evaluateMamGovernor({
        db: t.db,
        clients: makeStub({ unsatisfied: 184, indexerEnabled: true }).clients,
        targets: TARGETS,
        tuning: INCIDENT_TUNING,
      });
      const post = await getMamGovernorStatus({ db: t.db, env: {} });
      expect(post.gate).not.toBeNull();
      expect(post.gate!.gateOpen).toBe(false);
      expect(post.gate!.unsatisfied).toBe(184);
      expect(post.gate!.inDeadBand).toBe(true);
      expect(post.gate!.lastDelta).toBe(15);
      expect(post.gate!.previousUnsatisfied).toBe(169);
      expect(post.transitions[0]!.event).toBe('mam_gate_paused');
      expect(post.transitions[0]!.reason).toBe('trend');
    });
  });
});
