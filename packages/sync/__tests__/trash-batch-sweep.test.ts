// ADR-025 / DESIGN-011 — the `trash-batch-sweep` sync mode wiring: runSync drives
// sweepExpiredBatches through the injected Maintainerr bundle, returns a `sweep` report (never a
// per-source loop / sync_runs row), and surfaces an unsafe-install refusal as sweepError +
// totalFailure. The guarded per-item deletion itself is covered by the domain suite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMaintainerrClientBundle, type MaintainerrClientBundle } from '@hnet/domain';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

function stubMaintainerr(safe: boolean): MaintainerrClientBundle {
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const ok = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.17.0' });
    if (method === 'GET' && path === '/settings/test/plex') return ok({ status: safe ? 'OK' : 'NOK', code: 1 });
    if (method === 'GET' && path === '/rules/constants')
      return ok({ applications: safe ? [{ name: 'Radarr' }, { name: 'Sonarr' }, { name: 'Tautulli' }, { name: 'Overseerr' }] : [{ name: 'Sonarr' }] });
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections') return ok([]);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return buildMaintainerrClientBundle({ baseUrl: 'http://maintainerr.test:6246', apiKey: 'k', retryDelayMs: 0, fetchImpl });
}

describe('runSync — trash-batch-sweep mode (ADR-025)', () => {
  let t: TestDb;
  beforeAll(async () => (t = await bootMigratedDb()));
  afterAll(async () => t?.stop());

  it('runs the sweep (no expired batches ⇒ batchesSwept 0), no per-source rows', async () => {
    const report = await runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: stubMaintainerr(true), db: t.db });
    expect(report.mode).toBe('trash-batch-sweep');
    expect(report.sources).toEqual([]);
    expect(report.sweep).toMatchObject({ batchesSwept: 0 });
    expect(report.totalFailure).toBe(false);
  });

  it('an unsafe Maintainerr install fails the sweep (sweepError + totalFailure)', async () => {
    const report = await runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: stubMaintainerr(false), db: t.db });
    expect(report.sweep).toBeNull();
    expect(report.sweepError).toBeDefined();
    expect(report.totalFailure).toBe(true);
  });

  it('requires a maintainerr bundle', async () => {
    await expect(runSync({ mode: 'trash-batch-sweep', clients: {}, db: t.db })).rejects.toThrow(/maintainerr/);
  });
});
