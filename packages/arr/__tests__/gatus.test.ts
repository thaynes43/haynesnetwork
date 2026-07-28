// ADR-079 / DESIGN-004 D-25 — GatusClient ACL regression. Exercised against fetch stubs only
// (no live call); wire shapes live-verified in-cluster 2026-07-28. The two quirks under test:
// the uptime endpoints answer a PLAIN-TEXT float (the one non-JSON read in this package), and
// the statuses read derives current status from `results[last].success` (never the response's
// top-level `uptime`, which is null on the wire).
import { describe, expect, it } from 'vitest';
import { GatusClient } from '../src/gatus';
import {
  GATUS_CLUSTER_URL_DEFAULT,
  GATUS_DEFAULT_UPTIME_ENDPOINT_KEY,
  resolveGatusEnv,
} from '../src/config';
import { ArrParseError } from '../src/errors';
import { stubFetch } from './helpers';

function client(routes: Parameters<typeof stubFetch>[0], endpointKey = 'external_haynesnetwork') {
  const stub = stubFetch(routes);
  return {
    client: new GatusClient({
      baseUrl: 'http://gatus.test:80',
      endpointKey,
      fetchImpl: stub.fetchImpl,
      retryDelayMs: 0,
    }),
    ...stub,
  };
}

describe('GatusClient.getUptime (plain-text float)', () => {
  it('parses the plain-text ratio and hits the windowed path for the configured key', async () => {
    // stubFetch JSON-stringifies bodies; for a bare number that IS the plain-text wire form.
    const { client: c, calls } = client([
      { method: 'GET', path: '/api/v1/endpoints/external_haynesnetwork/uptimes/30d', body: 0.999783 },
    ]);
    await expect(c.getUptime('30d')).resolves.toBe(0.999783);
    expect(calls[0]!.url.pathname).toBe('/api/v1/endpoints/external_haynesnetwork/uptimes/30d');
  });

  it('rejects an empty body (Number("") is 0 — a silent fake-perfect ratio must fail loud)', async () => {
    const { client: c } = client([
      { method: 'GET', path: '/api/v1/endpoints/external_haynesnetwork/uptimes/24h' },
    ]);
    await expect(c.getUptime('24h')).rejects.toBeInstanceOf(ArrParseError);
  });

  it('rejects a non-numeric body and an out-of-range ratio (schema drift fails loud)', async () => {
    const bad = client([
      { method: 'GET', path: '/api/v1/endpoints/external_haynesnetwork/uptimes/7d', body: 'nope' },
    ]);
    await expect(bad.client.getUptime('7d')).rejects.toBeInstanceOf(ArrParseError);
    const over = client([
      { method: 'GET', path: '/api/v1/endpoints/external_haynesnetwork/uptimes/7d', body: 1.5 },
    ]);
    await expect(over.client.getUptime('7d')).rejects.toBeInstanceOf(ArrParseError);
  });
});

describe('GatusClient.isUp (statuses — last result wins, top-level uptime ignored)', () => {
  it('returns the NEWEST result and never parses the null top-level uptime', async () => {
    const { client: c } = client([
      {
        method: 'GET',
        path: '/api/v1/endpoints/external_haynesnetwork/statuses',
        // The live wire: uptime is null at the top level; results oldest → newest.
        body: { name: 'haynesnetwork.com', uptime: null, results: [{ success: true }, { success: false }] },
      },
    ]);
    await expect(c.isUp()).resolves.toBe(false);
  });

  it('rejects an empty results array (an endpoint with no history has no honest status)', async () => {
    const { client: c } = client([
      { method: 'GET', path: '/api/v1/endpoints/external_haynesnetwork/statuses', body: { results: [] } },
    ]);
    await expect(c.isUp()).rejects.toBeInstanceOf(ArrParseError);
  });
});

describe('resolveGatusEnv (always resolvable, keyless — ADR-079 C-08)', () => {
  it('defaults to the in-cluster Service DNS + the apex check key with an empty env', () => {
    expect(resolveGatusEnv({})).toEqual({
      baseUrl: GATUS_CLUSTER_URL_DEFAULT,
      endpointKey: GATUS_DEFAULT_UPTIME_ENDPOINT_KEY,
    });
  });

  it('honors overrides and trims whitespace', () => {
    expect(
      resolveGatusEnv({ GATUS_URL: ' http://gatus.test:80 ', GATUS_UPTIME_ENDPOINT_KEY: ' my_key ' }),
    ).toEqual({ baseUrl: 'http://gatus.test:80', endpointKey: 'my_key' });
  });
});
