// ADR-038 C-06 / DESIGN-017 D-04 — the ytdl-sub Plex-thumb proxy upstream resolver. Pure function (no
// DB): it must accept ONLY a Plex-metadata thumb path and reject anything that could smuggle a different
// host / traversal, and it must put the token in a header, never the URL.
import { describe, expect, it } from 'vitest';
import { isValidPlexThumbPath, resolveYtdlsubThumbUpstream } from '../src/ytdlsub-poster';

const ENV = {
  PLEX_HAYNESTOWER_TOKEN: 't-tower',
  PLEX_HAYNESOPS_TOKEN: 't-ops',
  PLEX_HAYNESKUBE_TOKEN: 't-kube',
  PLEX_HAYNESKUBE_URL: 'http://plex.media.svc.cluster.local:32400',
};

describe('isValidPlexThumbPath', () => {
  it('accepts a Plex metadata thumb path', () => {
    expect(isValidPlexThumbPath('/library/metadata/9001/thumb/1699999999')).toBe(true);
  });

  it('rejects a non-library path, a scheme, traversal, whitespace, and over-long input', () => {
    for (const bad of [
      '/etc/passwd',
      '/library/../secret',
      'http://evil.test/x',
      '/library/metadata/1/thumb/1?x=http://evil',
      '/library/metadata/1 /thumb',
      '',
      '/library/' + 'a'.repeat(600),
    ]) {
      expect(isValidPlexThumbPath(bad)).toBe(false);
    }
  });
});

describe('resolveYtdlsubThumbUpstream', () => {
  it('builds the k8plex upstream with the token in a header, never the URL', () => {
    const up = resolveYtdlsubThumbUpstream('/library/metadata/9001/thumb/1699', ENV);
    expect(up).not.toBeNull();
    expect(up!.url).toBe('http://plex.media.svc.cluster.local:32400/library/metadata/9001/thumb/1699');
    expect(up!.headers['X-Plex-Token']).toBe('t-kube');
    expect(up!.url).not.toContain('t-kube');
  });

  it('returns null for an invalid thumb path', () => {
    expect(resolveYtdlsubThumbUpstream('http://evil.test/x', ENV)).toBeNull();
    expect(resolveYtdlsubThumbUpstream('/etc/passwd', ENV)).toBeNull();
  });

  it('returns null (never throws) when the Plex env is absent', () => {
    expect(resolveYtdlsubThumbUpstream('/library/metadata/1/thumb/2', {})).toBeNull();
  });
});
