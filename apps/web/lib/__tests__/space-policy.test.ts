// ADR-031 / DESIGN-014 (PLAN-014) — the /admin/storage "Space policy" card's pure helpers: the
// immutable policy merges (the card sends the whole value to storage.policy.set), the live
// over/under-target readout, the cooldown next-eligible label, and the graduation verdict copy.
import { describe, expect, it } from 'vitest';
import type { GraduationReadiness, SpacePolicy } from '../space-policy';
import {
  arrayEnabled,
  effectiveCooldownDays,
  graduationVerdict,
  nextEligibleLabel,
  overTargetLabel,
  saveRateLabel,
  withArrayConfig,
  withEnabled,
} from '../space-policy';

const CAPS = {
  maxItems: { enabled: false, value: 25 },
  targetBytes: { enabled: false, value: 1 },
};
const P: SpacePolicy = {
  enabled: false,
  mode: 'over-target',
  cooldownDays: 7,
  minCandidates: 1,
  perArray: {},
  perKind: { movie: { ...CAPS }, tv: { ...CAPS } },
};

describe('policy merges (immutable, whole-object replace)', () => {
  it('withEnabled flips the global flag without mutating the source', () => {
    const next = withEnabled(P, true);
    expect(next.enabled).toBe(true);
    expect(P.enabled).toBe(false);
  });

  it('withArrayConfig opts an array in and preserves prior fields', () => {
    const on = withArrayConfig(P, 'haynestower', { enabled: true });
    expect(on.perArray.haynestower).toEqual({ enabled: true });
    const withCooldown = withArrayConfig(on, 'haynestower', { cooldownDays: 14 });
    expect(withCooldown.perArray.haynestower).toEqual({ enabled: true, cooldownDays: 14 });
    expect(P.perArray).toEqual({}); // source untouched
  });

  it('effectiveCooldownDays / arrayEnabled read the override else the default', () => {
    expect(effectiveCooldownDays(P, 'haynestower')).toBe(7);
    expect(arrayEnabled(P, 'haynestower')).toBe(false);
    const merged = withArrayConfig(P, 'haynestower', { enabled: true, cooldownDays: 10 });
    expect(effectiveCooldownDays(merged, 'haynestower')).toBe(10);
    expect(arrayEnabled(merged, 'haynestower')).toBe(true);
  });
});

describe('readouts', () => {
  it('overTargetLabel says over/under/none', () => {
    expect(overTargetLabel(90, 80)).toBe('90% used vs 80% target — over target');
    expect(overTargetLabel(70, 80)).toBe('70% used vs 80% target — under target');
    expect(overTargetLabel(90, null)).toBe('90% used · no target set');
    expect(overTargetLabel(null, 80)).toBe('utilization unavailable');
  });

  it('nextEligibleLabel is relative', () => {
    const now = new Date('2026-07-07T00:00:00Z');
    expect(nextEligibleLabel(null, now)).toBe('eligible now');
    expect(nextEligibleLabel('2026-07-01T00:00:00Z', now)).toBe('eligible now'); // past
    expect(nextEligibleLabel('2026-07-12T00:00:00Z', now)).toBe('eligible in 5 days');
    expect(nextEligibleLabel('2026-07-07T06:00:00Z', now)).toBe('eligible in under a day');
  });

  it('saveRateLabel', () => {
    expect(saveRateLabel(12.5)).toBe('12.5%');
    expect(saveRateLabel(null)).toBe('—');
  });
});

describe('graduationVerdict', () => {
  const base: GraduationReadiness = {
    thresholds: { minCompletedBatches: 3, maxSaveRatePct: 10, maxRestores: 0 },
    completedPolicyBatches: 0,
    recent: [],
    aggregate: { proposed: 0, rescued: 0, deleted: 0, skipped: 0, saveRatePct: null },
    restoresOfSwept: 0,
    meetsCriteria: false,
  };

  it('ready when meetsCriteria', () => {
    const g = { ...base, completedPolicyBatches: 4, meetsCriteria: true, aggregate: { ...base.aggregate, saveRatePct: 5 } };
    expect(graduationVerdict(g)).toContain('Ready');
  });

  it('names the missing batches', () => {
    expect(graduationVerdict({ ...base, completedPolicyBatches: 1 })).toContain('1 of 3');
  });

  it('names a too-high save-rate and restores', () => {
    const g: GraduationReadiness = {
      ...base,
      completedPolicyBatches: 5,
      aggregate: { proposed: 20, rescued: 6, deleted: 14, skipped: 0, saveRatePct: 30 },
      restoresOfSwept: 2,
    };
    const v = graduationVerdict(g);
    expect(v).toContain('save-rate 30% > 10%');
    expect(v).toContain('2 restores of swept items');
  });
});
