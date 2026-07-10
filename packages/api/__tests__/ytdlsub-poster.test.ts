// ADR-038 C-06 / ADR-041 / DESIGN-017 D-04+D-07 — the ytdl-sub Plex-thumb proxy upstream resolver.
// Pure functions (no DB): the resolver must accept ONLY a Plex-metadata thumb path and a CLOSED size
// allow-list, put the token in a header (never the URL), build the sized WebP transcode variant with
// the original art as the fallback tier, and mint a strong (size, thumb) ETag. The ThumbLruCache is
// byte-capped memoization — recency-refreshing, oldest-evicting, over-cap-skipping.
import { describe, expect, it } from 'vitest';
import {
  ThumbLruCache,
  isValidPlexThumbPath,
  isYtdlsubThumbSize,
  resolveYtdlsubThumbUpstream,
  ytdlsubThumbEtag,
} from '../src/ytdlsub-poster';

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

describe('resolveYtdlsubThumbUpstream (ADR-041 — sized transcode variants)', () => {
  const THUMB = '/library/metadata/9001/thumb/1699';

  it('builds the k8plex photo-transcode upstream (webp, grid dims, encoded thumb) with the token in a header, never the URL', () => {
    const up = resolveYtdlsubThumbUpstream(THUMB, 'grid', ENV);
    expect(up).not.toBeNull();
    expect(up!.url).toBe(
      'http://plex.media.svc.cluster.local:32400/photo/:/transcode' +
        `?width=300&height=450&minSize=1&upscale=1&format=webp&url=${encodeURIComponent(THUMB)}`,
    );
    expect(up!.headers['X-Plex-Token']).toBe('t-kube');
    expect(up!.url).not.toContain('t-kube');
  });

  it('the still variant carries 16:9 dims; the fallback tier is the ORIGINAL art path', () => {
    const up = resolveYtdlsubThumbUpstream(THUMB, 'still', ENV)!;
    expect(up.url).toContain('width=320&height=180');
    expect(up.fallbackUrl).toBe(`http://plex.media.svc.cluster.local:32400${THUMB}`);
    expect(up.fallbackUrl).not.toContain('t-kube');
  });

  it('the size allow-list is CLOSED — an unknown size resolves to null (not arbitrary dimensions)', () => {
    expect(isYtdlsubThumbSize('grid')).toBe(true);
    expect(isYtdlsubThumbSize('still')).toBe(true);
    expect(isYtdlsubThumbSize('x9999')).toBe(false);
    expect(
      resolveYtdlsubThumbUpstream(THUMB, 'x9999' as never, ENV),
    ).toBeNull();
  });

  it('the ETag is strong, stable per (size, thumb), and rotates across sizes AND thumbs', () => {
    const a = resolveYtdlsubThumbUpstream(THUMB, 'grid', ENV)!.etag;
    expect(a).toMatch(/^".+"$/);
    expect(a).toBe(ytdlsubThumbEtag(THUMB, 'grid'));
    expect(resolveYtdlsubThumbUpstream(THUMB, 'still', ENV)!.etag).not.toBe(a);
    // Plex thumb paths embed lastWrite ⇒ replaced art = new path = new ETag.
    expect(ytdlsubThumbEtag('/library/metadata/9001/thumb/1800', 'grid')).not.toBe(a);
  });

  it('returns null for an invalid thumb path', () => {
    expect(resolveYtdlsubThumbUpstream('http://evil.test/x', 'grid', ENV)).toBeNull();
    expect(resolveYtdlsubThumbUpstream('/etc/passwd', 'grid', ENV)).toBeNull();
  });

  it('returns null (never throws) when the Plex env is absent', () => {
    expect(resolveYtdlsubThumbUpstream('/library/metadata/1/thumb/2', 'grid', {})).toBeNull();
  });
});

describe('ThumbLruCache (ADR-041 C-04 — memoization, not a store)', () => {
  const entry = (n: number, tag = 'e') => ({
    body: new Uint8Array(n),
    contentType: 'image/webp',
    etag: `"${tag}"`,
  });

  it('stores and returns entries, tracking total bytes', () => {
    const cache = new ThumbLruCache(100, 50);
    cache.set('a', entry(10, 'a'));
    expect(cache.get('a')?.etag).toBe('"a"');
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(10);
  });

  it('evicts the LEAST-RECENTLY-USED entry at the byte cap (get refreshes recency)', () => {
    const cache = new ThumbLruCache(30, 30);
    cache.set('a', entry(10, 'a'));
    cache.set('b', entry(10, 'b'));
    cache.set('c', entry(10, 'c'));
    cache.get('a'); // refresh a — b is now oldest
    cache.set('d', entry(10, 'd')); // over cap ⇒ evict b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.bytes).toBe(30);
  });

  it('skips bodies over the per-entry cap (served, never cached) and replaces same-key entries', () => {
    const cache = new ThumbLruCache(100, 20);
    cache.set('big', entry(21));
    expect(cache.get('big')).toBeUndefined();
    cache.set('a', entry(10, 'v1'));
    cache.set('a', entry(15, 'v2'));
    expect(cache.get('a')?.etag).toBe('"v2"');
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(15);
  });
});
