// ADR-079 / DESIGN-004 D-25 — the uptime-badge read model: snapshot honesty (measured
// requires the status AND 30d reads; 24h/7d degrade alone; never rejects) and the
// single-flight TTL memo (fresh serve, coalesced concurrent reads, unmeasured NOT memoized).
import { describe, expect, it } from 'vitest';
import {
  createUptimeSource,
  readUptimeSnapshot,
  UNMEASURED_SNAPSHOT,
  type UptimeReader,
  type UptimeWindow,
} from '../src/uptime';

const RATIOS: Record<UptimeWindow, number> = { '24h': 1, '7d': 0.99913, '30d': 0.999783 };

function reader(overrides: Partial<UptimeReader> = {}): UptimeReader {
  return {
    isUp: async () => true,
    getUptime: async (window) => RATIOS[window],
    ...overrides,
  };
}

describe('readUptimeSnapshot (honesty rules — ADR-079 C-02)', () => {
  it('happy path: measured with all four fields', async () => {
    await expect(readUptimeSnapshot(reader())).resolves.toEqual({
      measured: true,
      up: true,
      uptime24h: 1,
      uptime7d: 0.99913,
      uptime30d: 0.999783,
    });
  });

  it('a failed STATUS read ⇒ unmeasured (all null, never a partial headline)', async () => {
    const snap = await readUptimeSnapshot(
      reader({ isUp: async () => Promise.reject(new Error('down')) }),
    );
    expect(snap).toEqual(UNMEASURED_SNAPSHOT);
  });

  it('a failed 30d read ⇒ unmeasured (the headline ratio is required)', async () => {
    const snap = await readUptimeSnapshot(
      reader({
        getUptime: async (window) => {
          if (window === '30d') throw new Error('boom');
          return RATIOS[window];
        },
      }),
    );
    expect(snap).toEqual(UNMEASURED_SNAPSHOT);
  });

  it('a failed 24h/7d read degrades that window to null alone (tooltip-only loss)', async () => {
    const snap = await readUptimeSnapshot(
      reader({
        getUptime: async (window) => {
          if (window === '24h') throw new Error('boom');
          return RATIOS[window];
        },
      }),
    );
    expect(snap).toEqual({
      measured: true,
      up: true,
      uptime24h: null,
      uptime7d: 0.99913,
      uptime30d: 0.999783,
    });
  });

  it('a read slower than the deadline loses the race ⇒ unmeasured, and never rejects', async () => {
    const snap = await readUptimeSnapshot(
      reader({ isUp: () => new Promise((resolve) => setTimeout(() => resolve(true), 50)) }),
      { deadlineMs: 5 },
    );
    expect(snap).toEqual(UNMEASURED_SNAPSHOT);
  });
});

describe('createUptimeSource (single-flight TTL memo — the createPlayScoreboard contract)', () => {
  it('serves the memo inside the TTL, re-reads after it expires', async () => {
    let now = 0;
    let reads = 0;
    const source = createUptimeSource({
      reader: reader({
        isUp: async () => {
          reads += 1;
          return true;
        },
      }),
      ttlMs: 60_000,
      now: () => now,
    });
    await source.get();
    await source.get();
    expect(reads).toBe(1); // fresh memo served
    now = 60_001;
    await source.get();
    expect(reads).toBe(2); // stale ⇒ one re-read
  });

  it('coalesces concurrent reads into ONE upstream aggregation', async () => {
    let reads = 0;
    let release!: (up: boolean) => void;
    const source = createUptimeSource({
      reader: reader({
        isUp: () =>
          new Promise((resolve) => {
            reads += 1;
            release = resolve;
          }),
      }),
    });
    const a = source.get();
    const b = source.get();
    release(true);
    const [snapA, snapB] = await Promise.all([a, b]);
    expect(reads).toBe(1);
    expect(snapA).toEqual(snapB);
    expect(snapA.measured).toBe(true);
  });

  it('an unmeasured result is served but NOT memoized — recovery is next-request', async () => {
    let healthy = false;
    const source = createUptimeSource({
      reader: reader({
        isUp: async () => {
          if (!healthy) throw new Error('gatus down');
          return true;
        },
      }),
      ttlMs: 60_000,
      now: () => 0, // time never advances — only the no-memo path can re-read
    });
    expect((await source.get()).measured).toBe(false);
    healthy = true;
    const recovered = await source.get();
    expect(recovered.measured).toBe(true);
    expect(recovered.up).toBe(true);
  });
});
