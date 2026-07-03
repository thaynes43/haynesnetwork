// Env contract tests (DESIGN-005 D-18): URL cluster-DNS defaults, required API keys,
// and the guarantee that key VALUES never leak into error messages.
import { describe, expect, it } from 'vitest';
import { ARR_CLUSTER_URL_DEFAULTS, assertArrEnv } from '../src/config';
import { ArrConfigError } from '../src/errors';
import { arrReadClientsFromEnv, LidarrClient, SeerrClient } from '../src/read';
import { arrWriteClientsFromEnv } from '../src/write';
import { fixture, stubFetch } from './helpers';

const FULL_ENV = {
  SONARR_API_KEY: 'sonarr-key',
  RADARR_API_KEY: 'radarr-key',
  LIDARR_API_KEY: 'lidarr-key',
  SEERR_API_KEY: 'seerr-key',
};

describe('assertArrEnv', () => {
  it('defaults URLs to the in-cluster service DNS (D-01)', () => {
    const config = assertArrEnv(FULL_ENV);
    expect(config.sonarr.baseUrl).toBe('http://sonarr.media.svc.cluster.local:8989');
    expect(config.radarr.baseUrl).toBe('http://radarr.media.svc.cluster.local:7878');
    expect(config.lidarr.baseUrl).toBe('http://lidarr.media.svc.cluster.local:8686');
    expect(config.seerr.baseUrl).toBe('http://seerr.media.svc.cluster.local:5055');
    expect(config.sonarr.apiKey).toBe('sonarr-key');
  });

  it('lets explicit URLs (LAN-ingress dev values) override the defaults', () => {
    const config = assertArrEnv({ ...FULL_ENV, SONARR_URL: 'https://sonarr.haynesops.com' });
    expect(config.sonarr.baseUrl).toBe('https://sonarr.haynesops.com');
    expect(config.radarr.baseUrl).toBe(ARR_CLUSTER_URL_DEFAULTS.radarr);
  });

  it('throws one ArrConfigError naming EVERY missing key variable', () => {
    const error = (() => {
      try {
        assertArrEnv({ SONARR_API_KEY: 'sonarr-key' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ArrConfigError);
    expect((error as ArrConfigError).missing).toEqual([
      'RADARR_API_KEY',
      'LIDARR_API_KEY',
      'SEERR_API_KEY',
    ]);
    // Values never leak — only variable NAMES appear in the message.
    expect((error as ArrConfigError).message).not.toContain('sonarr-key');
  });

  it('treats blank keys as missing', () => {
    expect(() => assertArrEnv({ ...FULL_ENV, LIDARR_API_KEY: '   ' })).toThrow(ArrConfigError);
  });
});

describe('env factories', () => {
  it('arrReadClientsFromEnv builds all four read clients', () => {
    const clients = arrReadClientsFromEnv(FULL_ENV);
    expect(clients.lidarr).toBeInstanceOf(LidarrClient);
    expect(clients.seerr).toBeInstanceOf(SeerrClient);
  });

  it('arrWriteClientsFromEnv builds the three *arr write clients (Seerr is read-only)', () => {
    const clients = arrWriteClientsFromEnv(FULL_ENV);
    expect(Object.keys(clients).sort()).toEqual(['lidarr', 'radarr', 'sonarr']);
  });

  it('factory-built clients hit the configured base URL', async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: '/api/v3/system/status', body: fixture('sonarr.system-status') },
    ]);
    // fetchImpl is injectable per client; the factory path uses global fetch, so build
    // one client directly from the factory's config to assert URL composition.
    const config = assertArrEnv({ ...FULL_ENV, SONARR_URL: 'http://sonarr.test:8989/' });
    const { SonarrClient } = await import('../src/read');
    const client = new SonarrClient({ ...config.sonarr, fetchImpl, retryDelayMs: 0 });
    await client.getSystemStatus();
    expect(calls[0]?.url.href).toBe('http://sonarr.test:8989/api/v3/system/status');
    expect(calls[0]?.headers.get('x-api-key')).toBe('sonarr-key');
  });
});
