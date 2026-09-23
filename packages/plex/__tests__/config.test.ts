import { describe, expect, it } from 'vitest';
import { assertPlexEnv, PLEX_CLUSTER_URL_DEFAULTS, PLEX_DISCOVER_BASE_URL } from '../src/config';
import { PlexConfigError } from '../src/errors';

describe('assertPlexEnv', () => {
  it('reads per-server URL + token, defaulting URLs to the cluster service DNS', () => {
    const cfg = assertPlexEnv({
      PLEX_HAYNESTOWER_TOKEN: 't1',
      PLEX_HAYNESOPS_TOKEN: 't2',
      PLEX_HAYNESKUBE_TOKEN: 't3',
      PLEX_HAYNESKUBE_URL: 'http://k8plex.local:32400',
    });
    expect(cfg.haynestower.baseUrl).toBe(PLEX_CLUSTER_URL_DEFAULTS.haynestower);
    expect(cfg.hayneskube.baseUrl).toBe('http://k8plex.local:32400');
    expect(cfg.haynesops.token).toBe('t2');
  });

  it('throws PlexConfigError naming every missing token — and never the values', () => {
    try {
      assertPlexEnv({ PLEX_HAYNESTOWER_TOKEN: 'secret-value' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlexConfigError);
      const e = err as PlexConfigError;
      expect(e.missing).toEqual(['PLEX_HAYNESOPS_TOKEN', 'PLEX_HAYNESKUBE_TOKEN']);
      expect(e.message).not.toContain('secret-value');
    }
  });
});

// DESIGN-049 D-09 step 6 (PLAN-068) — the watchlist lives on the plex.tv discover provider.
describe('assertPlexEnv — the discover provider base URL', () => {
  const tokens = { PLEX_HAYNESTOWER_TOKEN: 't1', PLEX_HAYNESOPS_TOKEN: 't2', PLEX_HAYNESKUBE_TOKEN: 't3' };

  it('defaults to discover.provider.plex.tv on every server', () => {
    const cfg = assertPlexEnv(tokens);
    expect(cfg.haynesops.plexDiscoverBaseUrl).toBe(PLEX_DISCOVER_BASE_URL);
    expect(PLEX_DISCOVER_BASE_URL).toBe('https://discover.provider.plex.tv');
  });

  it('is overridable via PLEX_DISCOVER_URL (e2e points it at the stub)', () => {
    const cfg = assertPlexEnv({ ...tokens, PLEX_DISCOVER_URL: ' http://127.0.0.1:9999 ' });
    expect(cfg.haynestower.plexDiscoverBaseUrl).toBe('http://127.0.0.1:9999');
    expect(cfg.hayneskube.plexDiscoverBaseUrl).toBe('http://127.0.0.1:9999');
  });
});
