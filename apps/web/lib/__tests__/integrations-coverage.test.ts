// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations coverage card's pending vs. ready decision.
// Fix 3b: a linked-but-never-synced integration is "first sync in progress", never a "0% / 0 of 0" badge.
import { describe, expect, it } from 'vitest';
import { coverageView, isFirstSyncPending } from '../integrations-coverage';

describe('coverageView', () => {
  it('is PENDING when linked but never synced — no 0% dead-end', () => {
    expect(coverageView({ lastSyncedAt: null, coverage: { total: 0, covered: 0, pct: 0 } })).toEqual({
      kind: 'pending',
    });
  });

  it('stays PENDING even if coverage numbers somehow arrive before the sync stamp', () => {
    expect(coverageView({ lastSyncedAt: null, coverage: { total: 3, covered: 1, pct: 33 } })).toEqual({
      kind: 'pending',
    });
  });

  it('shows real coverage once synced', () => {
    expect(
      coverageView({ lastSyncedAt: '2026-07-14T00:00:00.000Z', coverage: { total: 3, covered: 1, pct: 33 } }),
    ).toEqual({ kind: 'coverage', pct: 33, covered: 1, total: 3 });
  });

  it('shows an HONEST 0% once synced against a genuinely empty want shelf (not pending)', () => {
    expect(
      coverageView({ lastSyncedAt: '2026-07-14T00:00:00.000Z', coverage: { total: 0, covered: 0, pct: 0 } }),
    ).toEqual({ kind: 'coverage', pct: 0, covered: 0, total: 0 });
  });
});

describe('isFirstSyncPending', () => {
  it('is true only while linked and never synced', () => {
    expect(isFirstSyncPending(true, null)).toBe(true);
    expect(isFirstSyncPending(true, '2026-07-14T00:00:00.000Z')).toBe(false);
    expect(isFirstSyncPending(false, null)).toBe(false);
  });
});
