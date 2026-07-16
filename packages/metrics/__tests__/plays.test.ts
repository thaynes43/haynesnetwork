// ADR-068 / DESIGN-040 — the estate play scoreboard read model: summing by section type,
// photo/unknown exclusion, string-number tolerance, per-instance degradation (allSettled +
// deadline), and the single-flight TTL memo (injected clock). Offline — stub readers only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregatePlayTotals,
  createPlayScoreboard,
  SCOREBOARD_TTL_MS,
  type EstatePlayTotals,
  type ScoreboardLibraryRow,
  type ScoreboardReader,
} from '../src/plays';

function reader(slug: string, rows: ScoreboardLibraryRow[]): ScoreboardReader {
  return { slug, getLibrariesTable: async () => rows };
}

// The 2026-07-16 HaynesTower ground truth (Home Videos is section_type 'movie' — it sums
// into moviePlays by TYPE, not by name).
const haynestower: ScoreboardLibraryRow[] = [
  { section_type: 'movie', plays: 3449, duration: 3449 * 3600 },
  { section_type: 'show', plays: 25238, duration: 25238 * 1800 },
  { section_type: 'artist', plays: 2316, duration: 2316 * 240 },
  { section_type: 'movie', plays: 30, duration: 30 * 600 }, // Home Videos
  { section_type: 'photo', plays: 999, duration: 999_999 }, // excluded entirely
];

describe('aggregatePlayTotals (D-01/D-02)', () => {
  it('sums plays AND duration by section type across instances; photo/unknown excluded', async () => {
    const totals = await aggregatePlayTotals([
      reader('haynestower', haynestower),
      reader('haynesops', [
        { section_type: 'movie', plays: 100, duration: 100 * 3600 },
        { section_type: 'show', plays: 50, duration: 50 * 1800 },
        { section_type: 'clip', plays: 77, duration: 77_000 }, // unknown type: excluded
      ]),
    ]);
    expect(totals.moviePlays).toBe(3449 + 30 + 100);
    expect(totals.episodePlays).toBe(25238 + 50);
    expect(totals.trackPlays).toBe(2316);
    // Hours: every counted kind's duration, photo/unknown contributing nothing.
    const seconds =
      (3449 + 100) * 3600 + (25238 + 50) * 1800 + 2316 * 240 + 30 * 600;
    expect(totals.hoursWatched).toBe(Math.round(seconds / 3600));
    expect(totals.unavailable).toBe(false);
    expect(totals.instances).toEqual([
      { slug: 'haynestower', ok: true },
      { slug: 'haynesops', ok: true },
    ]);
  });

  it('tolerates Tautulli string numerics; non-finite/negative coerce to 0', async () => {
    const totals = await aggregatePlayTotals([
      reader('haynesops', [
        { section_type: 'movie', plays: '42', duration: '7200' },
        { section_type: 'show', plays: 'n/a', duration: null },
        { section_type: 'artist', plays: -5, duration: -60 },
      ]),
    ]);
    expect(totals.moviePlays).toBe(42);
    expect(totals.episodePlays).toBe(0);
    expect(totals.trackPlays).toBe(0);
    expect(totals.hoursWatched).toBe(2);
  });

  it('a failed instance contributes nothing and never blocks (partial degradation)', async () => {
    const totals = await aggregatePlayTotals([
      { slug: 'hayneskube', getLibrariesTable: async () => Promise.reject(new Error('boom')) },
      reader('haynestower', [{ section_type: 'movie', plays: 7, duration: 3600 }]),
    ]);
    expect(totals.moviePlays).toBe(7);
    expect(totals.instances).toEqual([
      { slug: 'hayneskube', ok: false },
      { slug: 'haynestower', ok: true },
    ]);
    expect(totals.unavailable).toBe(false);
  });

  it('all instances failed ⇒ unavailable (the render-nothing signal)', async () => {
    const totals = await aggregatePlayTotals([
      { slug: 'a', getLibrariesTable: async () => Promise.reject(new Error('down')) },
      { slug: 'b', getLibrariesTable: async () => Promise.reject(new Error('down')) },
    ]);
    expect(totals.unavailable).toBe(true);
    expect(totals.moviePlays).toBe(0);
  });

  it('zero configured readers ⇒ unavailable (local dev without Tautulli env)', async () => {
    const totals = await aggregatePlayTotals([]);
    expect(totals.unavailable).toBe(true);
    expect(totals.instances).toEqual([]);
  });

  it('a hung instance loses the deadline race and is marked failed (D-02)', async () => {
    vi.useFakeTimers();
    const hung: ScoreboardReader = {
      slug: 'haynestower',
      getLibrariesTable: () =>
        new Promise((resolve) => setTimeout(() => resolve([]), 60_000)),
    };
    const pending = aggregatePlayTotals(
      [hung, reader('haynesops', [{ section_type: 'movie', plays: 1, duration: 60 }])],
      { deadlineMs: 3_000 },
    );
    await vi.advanceTimersByTimeAsync(3_001);
    const totals = await pending;
    expect(totals.instances).toEqual([
      { slug: 'haynestower', ok: false },
      { slug: 'haynesops', ok: true },
    ]);
    expect(totals.moviePlays).toBe(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPlayScoreboard — the TTL memo (D-03)', () => {
  function countingReaders(rows: ScoreboardLibraryRow[] = [{ section_type: 'movie', plays: 1, duration: 60 }]) {
    let calls = 0;
    const r: ScoreboardReader = {
      slug: 'haynesops',
      getLibrariesTable: async () => {
        calls += 1;
        return rows;
      },
    };
    return { r, calls: () => calls };
  }

  it('serves the memo within the TTL; re-aggregates after it lapses (injected clock)', async () => {
    let clock = 1_000_000;
    const { r, calls } = countingReaders();
    const source = createPlayScoreboard({ readers: [r], now: () => clock });

    const first = await source.get();
    expect(calls()).toBe(1);
    clock += SCOREBOARD_TTL_MS - 1;
    expect(await source.get()).toBe(first); // fresh memo — the SAME object, no re-read
    expect(calls()).toBe(1);
    clock += 2; // now past the TTL
    await source.get();
    expect(calls()).toBe(2);
  });

  it('concurrent stale reads coalesce into ONE aggregation (single-flight)', async () => {
    const { r, calls } = countingReaders();
    const source = createPlayScoreboard({ readers: [r], now: () => 5 });
    const [a, b] = await Promise.all([source.get(), source.get()]);
    expect(calls()).toBe(1);
    expect(a).toBe(b);
  });

  it('an unavailable result is served but NOT memoized — recovery is next-request', async () => {
    let up = false;
    let calls = 0;
    const flaky: ScoreboardReader = {
      slug: 'haynesops',
      getLibrariesTable: async () => {
        calls += 1;
        if (!up) throw new Error('down');
        return [{ section_type: 'movie', plays: 9, duration: 60 }];
      },
    };
    const source = createPlayScoreboard({ readers: [flaky], now: () => 5 });

    const down: EstatePlayTotals = await source.get();
    expect(down.unavailable).toBe(true);
    up = true;
    const recovered = await source.get(); // no TTL wait — the failure was not cached
    expect(recovered.unavailable).toBe(false);
    expect(recovered.moviePlays).toBe(9);
    expect(calls).toBe(2);
  });
});
