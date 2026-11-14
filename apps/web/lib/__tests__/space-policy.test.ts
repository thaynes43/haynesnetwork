// ADR-031 / DESIGN-014 (PLAN-014); ADR-073 (2026-07-18) — the /admin/storage "Space policy" card's pure
// helpers: the immutable policy merges (the card sends the whole value to storage.policy.set), the live
// over/under-target readout, and the graduation verdict copy. (The cooldown next-eligible label was
// retired with the cooldown itself — ADR-073.)
import { describe, expect, it } from 'vitest';
import type { GraduationReadiness, SpacePolicy } from '../space-policy';
import {
  arrayEnabled,
  graduationVerdict,
  overTargetLabel,
  saveRateLabel,
  withArrayConfig,
  withEnabled,
} from '../space-policy';

import { toDraft, draftToPolicy } from '../batch-policy-form';

const CAPS = {
  maxItems: { enabled: false, value: 25 },
  targetBytes: { enabled: false, value: 1 },
};
const P: SpacePolicy = {
  enabled: false,
  mode: 'over-target',
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
    const withMin = withArrayConfig(on, 'haynestower', { minCandidates: 14 });
    expect(withMin.perArray.haynestower).toEqual({ enabled: true, minCandidates: 14 });
    expect(P.perArray).toEqual({}); // source untouched
  });

  it('arrayEnabled reads the per-array opt-in flag', () => {
    expect(arrayEnabled(P, 'haynestower')).toBe(false);
    const merged = withArrayConfig(P, 'haynestower', { enabled: true });
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
    const g = {
      ...base,
      completedPolicyBatches: 4,
      meetsCriteria: true,
      aggregate: { ...base.aggregate, saveRatePct: 5 },
    };
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

describe('settings cards preserve Dynamic Pace on save', () => {
  it.each([false, true])(
    'carries the complete pace config through both card save conversions (enabled=%s)',
    (enabled) => {
      const dynamicPace = {
        enabled,
        observeOnly: !enabled,
        movieMaxItems: 50,
        horizonDays: 30,
        floorBytes: 130_604_353_957,
        ceilingBytes: 3_591_025_375_575,
      };
      const policy = { ...P, dynamicPace };
      const draft = toDraft(policy);
      draft.minCandidates = '12';
      const saved = draftToPolicy(draft, policy); // BatchPolicyCard.onSave uses this exact seam
      expect(saved.dynamicPace).toEqual(dynamicPace);
      expect(saved.minCandidates).toBe(12);
      expect(withEnabled(policy, true).dynamicPace).toEqual(dynamicPace);
      expect(withArrayConfig(policy, 'haynestower', { enabled: true }).dynamicPace).toEqual(
        dynamicPace,
      );
      expect(policy.dynamicPace).toEqual(dynamicPace);
    },
  );
});
