// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the Activity live-progress pure helpers: the ADAPTIVE poll cadence
// (fast while downloading so the % ticks, relaxed otherwise) and the stage → Fix-PhaseChip mapping. Framework
// -free so they are exhaustively unit-tested here — the owner judges the "feels like Fix" consistency, so the
// numbers + tones are pinned.
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FAST_POLL_MS,
  ACTIVITY_SLOW_POLL_MS,
  activityPollIntervalMs,
  activityStagePhase,
  isTerminalActivityStage,
} from '../activity-progress';

describe('activityPollIntervalMs — the adaptive cadence', () => {
  it('polls FAST (2.5s) while any item is downloading — the % must visibly tick', () => {
    expect(activityPollIntervalMs({ hasDownloading: true })).toBe(ACTIVITY_FAST_POLL_MS);
    expect(ACTIVITY_FAST_POLL_MS).toBe(2_500);
  });
  it('relaxes to 5s when nothing is downloading (the #278 default)', () => {
    expect(activityPollIntervalMs({ hasDownloading: false })).toBe(ACTIVITY_SLOW_POLL_MS);
    expect(ACTIVITY_SLOW_POLL_MS).toBe(5_000);
  });
});

describe('isTerminalActivityStage — the after-fire watch stop condition', () => {
  it('only `completed` is terminal; `failed` keeps polling so a retry is seen to move it', () => {
    expect(isTerminalActivityStage('completed')).toBe(true);
    expect(isTerminalActivityStage('failed')).toBe(false);
    expect(isTerminalActivityStage('downloading')).toBe(false);
    expect(isTerminalActivityStage('searching')).toBe(false);
    expect(isTerminalActivityStage(null)).toBe(false);
  });
});

describe('activityStagePhase — stage → the Fix PhaseChip vocabulary', () => {
  it('downloading carries a determinate % meter + a pulse (the "in motion" chip)', () => {
    const p = activityStagePhase('downloading', 42);
    expect(p).toMatchObject({ phase: 'downloading', tone: 'info', progressPct: 42, pulse: true, meter: true });
    expect(String(p.label)).toContain('42%');
  });
  it('clamps + rounds the download percent (7% → 100% never overflows the meter)', () => {
    expect(activityStagePhase('downloading', 142.6).progressPct).toBe(100);
    expect(activityStagePhase('downloading', -5).progressPct).toBe(0);
    expect(activityStagePhase('downloading', 33.4).progressPct).toBe(33);
  });
  it('downloading with no byte count yet shows the indeterminate meter (no false 0%)', () => {
    const p = activityStagePhase('downloading', null);
    expect(p.progressPct).toBeUndefined();
    expect(p.meter).toBe(true);
    expect(p.pulse).toBe(true);
  });
  it('searching / importing pulse an indeterminate sliver; the terminals hold still', () => {
    expect(activityStagePhase('searching', null)).toMatchObject({ pulse: true, meter: true, tone: 'neutral' });
    expect(activityStagePhase('importing', null)).toMatchObject({ pulse: true, meter: true, tone: 'info' });
    expect(activityStagePhase('completed', null)).toMatchObject({ pulse: false, meter: false, tone: 'success' });
    expect(activityStagePhase('failed', null)).toMatchObject({ pulse: false, meter: false, tone: 'danger' });
  });
});
