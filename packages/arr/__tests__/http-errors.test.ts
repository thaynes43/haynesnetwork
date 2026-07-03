// Error taxonomy + retry semantics for the shared fetch wrapper (DESIGN-005 D-18:
// timeouts, typed errors, retry(2) for idempotent GETs only).
import { describe, expect, it } from 'vitest';
import { ArrHttpError, ArrParseError, ArrTimeoutError } from '../src/errors';
import { SonarrClient } from '../src/read';
import { SonarrWriteClient } from '../src/write';
import { fixture, stubFetch, stubFetchHanging, stubFetchSequence, TEST_OPTS } from './helpers';

const BASE = { baseUrl: 'http://sonarr.test:8989', ...TEST_OPTS };

describe('ArrHttpError', () => {
  it('carries the HTTP status and never the API key', async () => {
    const { fetchImpl } = stubFetch([
      { path: '/api/v3/system/status', status: 500, body: { message: 'boom' } },
    ]);
    const client = new SonarrClient({ ...BASE, fetchImpl });
    const error = await client.getSystemStatus().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrHttpError);
    expect((error as ArrHttpError).status).toBe(500);
    expect((error as ArrHttpError).message).not.toContain('test-api-key');
  });
});

describe('ArrParseError (schema drift)', () => {
  it('throws when the *arr response drifts from the D-02 contract', async () => {
    // Simulate upstream drift: `id` becomes a string in a future Sonarr release.
    const drifted = fixture<Array<Record<string, unknown>>>('sonarr.series-list').map(
      (series, index) => (index === 0 ? { ...series, id: 'no-longer-a-number' } : series),
    );
    const { fetchImpl } = stubFetch([{ path: '/api/v3/series', body: drifted }]);
    const client = new SonarrClient({ ...BASE, fetchImpl });
    const error = await client.listSeries().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrParseError);
    expect((error as ArrParseError).issues.join('\n')).toContain('0.id');
    expect((error as ArrParseError).message).toContain('schema drift');
  });

  it('throws on non-JSON bodies', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway error</html>', { status: 200 })) as unknown as typeof fetch;
    const client = new SonarrClient({ ...BASE, fetchImpl });
    await expect(client.getSystemStatus()).rejects.toBeInstanceOf(ArrParseError);
  });
});

describe('retry semantics (D-18: idempotent GETs only)', () => {
  it('retries a GET through transient 503s and succeeds', async () => {
    const { fetchImpl, calls } = stubFetchSequence([
      { status: 503, body: { message: 'busy' } },
      { status: 200, body: fixture('sonarr.system-status') },
    ]);
    const client = new SonarrClient({ ...BASE, fetchImpl });
    const status = await client.getSystemStatus();
    expect(status.version).toBe('4.0.18.2978');
    expect(calls).toHaveLength(2);
  });

  it('gives up after 3 GET attempts', async () => {
    const { fetchImpl, calls } = stubFetchSequence([{ status: 503, body: {} }]);
    const client = new SonarrClient({ ...BASE, fetchImpl });
    await expect(client.getSystemStatus()).rejects.toBeInstanceOf(ArrHttpError);
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry non-retryable statuses (401)', async () => {
    const { fetchImpl, calls } = stubFetchSequence([{ status: 401, body: {} }]);
    const client = new SonarrClient({ ...BASE, fetchImpl });
    await expect(client.getSystemStatus()).rejects.toBeInstanceOf(ArrHttpError);
    expect(calls).toHaveLength(1);
  });

  it('NEVER retries writes — a failed POST is attempted exactly once', async () => {
    const { fetchImpl, calls } = stubFetchSequence([{ status: 503, body: {} }]);
    const client = new SonarrWriteClient({ ...BASE, fetchImpl });
    await expect(client.markHistoryFailed(666)).rejects.toBeInstanceOf(ArrHttpError);
    expect(calls).toHaveLength(1);
  });
});

describe('ArrTimeoutError', () => {
  it('aborts a hung request after timeoutMs', async () => {
    const { fetchImpl } = stubFetchHanging();
    const client = new SonarrClient({ ...BASE, fetchImpl, timeoutMs: 10 });
    const error = await client.getSystemStatus().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrTimeoutError);
    expect((error as ArrTimeoutError).timeoutMs).toBe(10);
  });
});
