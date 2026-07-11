import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mamGateState, notificationOutbox } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  computeDesiredGate,
  computeStuck,
  evaluateMamGovernor,
  resolveGovernorConfig,
  type MamGovernorClients,
  type MamGovernorTuning,
} from '../src/mam-governor';

// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor evaluator. These tests are the plan's
// acceptance proof: a deploy at 13/15 headroom writes a BASELINE and pages nothing; crossing the threshold
// enqueues EXACTLY ONE mam_gate_paused (same-tx with the mam_gate_state flip); a repeat enqueues zero (no
// double-page); headroom returning enqueues mam_gate_resumed; a failed count fails CLOSED; and headroom
// pinned at 0 for >48h enqueues mam_gate_stuck once. The same-tx outbox coupling is proven BOTH directions
// (transition ⇒ 1 row + flipped state committed together; no transition ⇒ 0 rows, state still refreshed).

const TUNING: MamGovernorTuning = { limit: 20, buffer: 5, zeroHeadroomAlertHours: 48 }; // threshold 15
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
  it('closes at unsatisfied >= limit - buffer, opens below it; fail-closed on !countOk', () => {
    expect(computeDesiredGate(counts(14), true, TUNING)).toEqual({
      desiredOpen: true,
      threshold: 15,
    });
    expect(computeDesiredGate(counts(15), true, TUNING)).toEqual({
      desiredOpen: false,
      threshold: 15,
    });
    expect(computeDesiredGate(counts(0), false, TUNING)).toEqual({
      desiredOpen: false,
      threshold: 15,
    });
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
  it('defaults to 20/5/48 and reads env overrides; clamps buffer < limit', async () => {
    expect(await resolveGovernorConfig({ env: {} })).toEqual({
      limit: 20,
      buffer: 5,
      zeroHeadroomAlertHours: 48,
    });
    expect(
      await resolveGovernorConfig({
        env: { MAM_UNSATISFIED_LIMIT: '50', MAM_UNSATISFIED_BUFFER: '10' },
      }),
    ).toEqual({
      limit: 50,
      buffer: 10,
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

  it('first run at 13/15 headroom writes a BASELINE, gate OPEN, and pages nothing (live-validation)', async () => {
    const stub = makeStub({ unsatisfied: 13, indexerEnabled: true });
    const r = await evaluateMamGovernor({
      db: t.db,
      clients: stub.clients,
      targets: TARGETS,
      tuning: TUNING,
    });
    expect(r.gateOpen).toBe(true);
    expect(r.event).toBeNull();
    expect(r.enqueued).toBe(0);
    expect(stub.calls.set).toHaveLength(0); // no actuation — already enabled
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    const rows = await t.db.select().from(mamGateState);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gateOpen).toBe(true);
    expect(rows[0]!.unsatisfiedCount).toBe(13);
    expect(rows[0]!.threshold).toBe(15);
  });

  it('crossing the threshold enqueues EXACTLY ONE mam_gate_paused same-tx; a repeat enqueues zero', async () => {
    await evaluateMamGovernor({
      db: t.db,
      clients: makeStub({ unsatisfied: 13, indexerEnabled: true }).clients,
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
