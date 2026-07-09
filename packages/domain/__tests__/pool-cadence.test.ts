// DESIGN-010/014 amendment (2026-07-09, build D) — the honest pool re-evaluation cadence. Proves the
// crontab HOUR-field parser (the forms Maintainerr emits, incl. the live install's "0 0-23/8 * * *" →
// 8 h) and getPoolRefreshCadence's fetch → parse → in-process cache, plus graceful degradation (a
// Maintainerr outage serves the last good value, or null when there is none — the label is omitted,
// never wrong).
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetPoolCadenceCacheForTests,
  buildMaintainerrClientBundle,
  getPoolRefreshCadence,
  parseCronEveryHours,
} from '../src/index';

/** A read bundle whose GET /api/settings returns `cron` (or throws when `reachable` is false). */
function cadenceBundle(state: { cron: string | null; reachable: boolean }) {
  const fetchImpl = (async (input: unknown) => {
    if (!state.reachable) return new Response('unreachable', { status: 502 });
    const url = new URL(String(input));
    if (url.pathname === '/api/settings') {
      return new Response(JSON.stringify({ rules_handler_job_cron: state.cron }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return buildMaintainerrClientBundle({ baseUrl: 'http://mtr.test:6246', apiKey: 'k', retryDelayMs: 0, fetchImpl });
}

describe('parseCronEveryHours', () => {
  afterEach(() => __resetPoolCadenceCacheForTests());

  it('reads the step forms Maintainerr emits (the live default is every 8 h)', () => {
    expect(parseCronEveryHours('0 0-23/8 * * *')).toBe(8); // the live rules_handler_job_cron
    expect(parseCronEveryHours('0 0-23/12 * * *')).toBe(12); // the live collection_handler_job_cron
    expect(parseCronEveryHours('0 */6 * * *')).toBe(6);
    expect(parseCronEveryHours('15 */6 * * *')).toBe(6);
  });

  it('reads every-hour and single/list hour forms', () => {
    expect(parseCronEveryHours('0 * * * *')).toBe(1);
    expect(parseCronEveryHours('0 0 * * *')).toBe(24); // daily
    expect(parseCronEveryHours('0 0,12 * * *')).toBe(12);
    expect(parseCronEveryHours('0 0,8,16 * * *')).toBe(8);
  });

  it('returns null for empty / too-short / unparseable crons (label omitted, never wrong)', () => {
    expect(parseCronEveryHours('')).toBeNull();
    expect(parseCronEveryHours('0')).toBeNull();
    expect(parseCronEveryHours('0 abc * * *')).toBeNull();
  });
});

describe('getPoolRefreshCadence', () => {
  afterEach(() => __resetPoolCadenceCacheForTests());

  it('fetches + parses the rule-handler cron', async () => {
    const bundle = cadenceBundle({ cron: '0 0-23/8 * * *', reachable: true });
    expect(await getPoolRefreshCadence({ maintainerr: bundle })).toEqual({
      everyHours: 8,
      cron: '0 0-23/8 * * *',
    });
  });

  it('caches in-process within the TTL; force re-reads', async () => {
    const state = { cron: '0 0-23/8 * * *', reachable: true };
    const bundle = cadenceBundle(state);
    expect((await getPoolRefreshCadence({ maintainerr: bundle })).everyHours).toBe(8);
    state.cron = '0 */4 * * *'; // Maintainerr's cron changes underneath us
    expect((await getPoolRefreshCadence({ maintainerr: bundle })).everyHours).toBe(8); // cached
    expect((await getPoolRefreshCadence({ maintainerr: bundle, force: true })).everyHours).toBe(4);
  });

  it('degrades to null when Maintainerr is unreachable and nothing is cached', async () => {
    const bundle = cadenceBundle({ cron: null, reachable: false });
    expect(await getPoolRefreshCadence({ maintainerr: bundle })).toEqual({ everyHours: null, cron: null });
  });

  it('serves the last good value when a later fetch fails', async () => {
    const state = { cron: '0 0-23/8 * * *', reachable: true };
    const bundle = cadenceBundle(state);
    expect((await getPoolRefreshCadence({ maintainerr: bundle })).everyHours).toBe(8);
    state.reachable = false;
    expect((await getPoolRefreshCadence({ maintainerr: bundle, force: true })).everyHours).toBe(8); // stale-good
  });

  it('returns null everyHours when Maintainerr omits the cron', async () => {
    const bundle = cadenceBundle({ cron: null, reachable: true });
    expect(await getPoolRefreshCadence({ maintainerr: bundle })).toEqual({ everyHours: null, cron: null });
  });
});
