// DESIGN-039 amendment 2026-10-07 (OC-014) — the GB Call Pacer: at most `perMinute` Google Books requests in any
// 60-second window, per process. Pure (no DB); fake timers drive the default setTimeout sleep and Date.now clock, so
// no real time passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGbCallPacer } from '../src/index';

describe('createGbCallPacer (the per-minute request ceiling)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T07:32:03Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets the first perMinute requests through at once and holds the next until the oldest is a minute old', async () => {
    const pacer = createGbCallPacer({ perMinute: 3 });
    const started: number[] = [];
    const request = async (): Promise<void> => {
      await pacer.beforeCall();
      started.push(Date.now());
    };
    const t0 = Date.now();
    await request();
    vi.advanceTimersByTime(10_000);
    await request();
    await request();
    expect(started.map((t) => t - t0)).toEqual([0, 10_000, 10_000]);

    // The fourth request waits: the window holds three, the oldest (t0) leaves it at t0 + 60s.
    const fourth = request();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(started).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await fourth;
    expect(started[3]! - t0).toBe(60_000);
    expect(pacer.waits()).toBe(1);
    expect(pacer.waitedMs()).toBe(50_000);
  });

  it('never lets more than perMinute requests start in any 60-second window, however they are called', async () => {
    const pacer = createGbCallPacer({ perMinute: 4 });
    const started: number[] = [];
    // Ten callers at once (the shape of a concurrent burst): they take their turns one at a time.
    const all = Promise.all(
      Array.from({ length: 10 }, async () => {
        await pacer.beforeCall();
        started.push(Date.now());
      }),
    );
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await all;
    expect(started).toHaveLength(10);
    const t0 = started[0]!;
    // 4 at t0, 4 at t0+60s, 2 at t0+120s.
    expect(started.map((t) => t - t0)).toEqual([
      0, 0, 0, 0, 60_000, 60_000, 60_000, 60_000, 120_000, 120_000,
    ]);
    for (const t of started) {
      expect(started.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(4);
    }
  });

  it('perMinute 0 (or not a number) turns pacing off', async () => {
    for (const perMinute of [0, Number.NaN, -5]) {
      const pacer = createGbCallPacer({ perMinute });
      for (let i = 0; i < 500; i += 1) await pacer.beforeCall();
      expect(pacer.perMinute()).toBe(0);
      expect(pacer.waits()).toBe(0);
    }
  });

  it('uses an injected clock and sleep when given (no timers at all)', async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const pacer = createGbCallPacer({
      perMinute: 2,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await pacer.beforeCall();
    now += 5_000;
    await pacer.beforeCall();
    await pacer.beforeCall(); // waits 55s for the first to leave the window
    await pacer.beforeCall(); // waits 5s more for the second
    expect(sleeps).toEqual([55_000, 5_000]);
    expect(pacer.waits()).toBe(2);
    expect(pacer.waitedMs()).toBe(60_000);
  });
});
