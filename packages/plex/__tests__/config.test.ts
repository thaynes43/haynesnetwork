import { describe, expect, it } from 'vitest';
import { assertPlexEnv, PLEX_CLUSTER_URL_DEFAULTS } from '../src/config';
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
