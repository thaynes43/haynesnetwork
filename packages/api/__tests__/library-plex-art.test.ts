// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season/episode art seam. Pure functions (no DB): the
// signed item-scoped thumb reference (mint + verify) that upholds THE INVARIANT (a thumb can only be
// fetched bound to the accessible item it was read for), and the transcode-upstream resolver on the
// MATCHED server (token header-only, closed size set, self-versioning ETag) — the same discipline the
// ytdl-sub proxy proves, but server-parameterized.
import { describe, expect, it } from 'vitest';
import {
  buildPlexArtUrl,
  isPlexServerSlug,
  plexArtEtag,
  resolvePlexArtUpstream,
  signPlexArtRef,
  verifyPlexArtRef,
} from '../src/library-plex-art';

const ENV = {
  PLEX_HAYNESTOWER_TOKEN: 't-tower',
  PLEX_HAYNESOPS_TOKEN: 't-ops',
  PLEX_HAYNESKUBE_TOKEN: 't-kube',
  PLEX_HAYNESTOWER_URL: 'https://tower.example',
  PLEX_HAYNESOPS_URL: 'http://ops.example:32400',
};

const ITEM = '11111111-1111-4111-8111-111111111111';
const THUMB = '/library/metadata/9001/thumb/1699';

describe('isPlexServerSlug', () => {
  it('accepts the three servers of record and rejects anything else', () => {
    for (const s of ['haynestower', 'haynesops', 'hayneskube'])
      expect(isPlexServerSlug(s)).toBe(true);
    for (const s of ['', 'plex', 'k8plex', 'haynes']) expect(isPlexServerSlug(s)).toBe(false);
  });
});

describe('signPlexArtRef / verifyPlexArtRef (THE INVARIANT — item-scoped, tamper-proof)', () => {
  it('a freshly-minted signature verifies for the SAME tuple', () => {
    const sig = signPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', ENV);
    expect(verifyPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', sig, ENV)).toBe(true);
  });

  it('rejects a tampered item / server / thumb / size / signature (no cross-item or cross-title reuse)', () => {
    const sig = signPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', ENV);
    // A DIFFERENT (e.g. inaccessible) item can't reuse an accessible item's signature.
    expect(
      verifyPlexArtRef(
        '22222222-2222-4222-8222-222222222222',
        'haynestower',
        THUMB,
        'grid',
        sig,
        ENV,
      ),
    ).toBe(false);
    // A different server / a different (sibling-library) thumb / a different size all fail.
    expect(verifyPlexArtRef(ITEM, 'haynesops', THUMB, 'grid', sig, ENV)).toBe(false);
    expect(
      verifyPlexArtRef(ITEM, 'haynestower', '/library/metadata/424242/thumb/1', 'grid', sig, ENV),
    ).toBe(false);
    expect(verifyPlexArtRef(ITEM, 'haynestower', THUMB, 'still', sig, ENV)).toBe(false);
    expect(verifyPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', sig + 'x', ENV)).toBe(false);
  });

  it('rejects an unknown server slug or size outright (never trusts the query verbatim)', () => {
    const sig = signPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', ENV);
    expect(verifyPlexArtRef(ITEM, 'not-a-server', THUMB, 'grid', sig, ENV)).toBe(false);
    expect(verifyPlexArtRef(ITEM, 'haynestower', THUMB, 'x9999', sig, ENV)).toBe(false);
  });
});

describe('buildPlexArtUrl', () => {
  it('builds a signed /api/library/plex-art URL that round-trips through verify', () => {
    const url = buildPlexArtUrl(ITEM, 'haynestower', THUMB, 'grid', ENV);
    expect(url).not.toBeNull();
    const q = new URLSearchParams(url!.split('?')[1]);
    expect(q.get('item')).toBe(ITEM);
    expect(q.get('server')).toBe('haynestower');
    expect(q.get('thumb')).toBe(THUMB);
    expect(q.get('size')).toBe('grid');
    expect(verifyPlexArtRef(ITEM, 'haynestower', THUMB, 'grid', q.get('sig')!, ENV)).toBe(true);
    // The token is NEVER in the minted URL.
    expect(url).not.toContain('t-tower');
  });

  it('returns null for an unsafe thumb path (→ no icon, never a broken img)', () => {
    expect(buildPlexArtUrl(ITEM, 'haynestower', 'http://evil.test/x', 'grid', ENV)).toBeNull();
    expect(buildPlexArtUrl(ITEM, 'haynestower', '/library/../secret', 'grid', ENV)).toBeNull();
  });
});

describe('resolvePlexArtUpstream (matched-server transcode variant)', () => {
  it('builds the transcode upstream on the MATCHED server with the token in a header, never the URL', () => {
    const up = resolvePlexArtUpstream('haynestower', THUMB, 'grid', ENV)!;
    expect(up.url).toBe(
      'https://tower.example/photo/:/transcode' +
        `?width=300&height=450&minSize=1&upscale=1&format=webp&url=${encodeURIComponent(THUMB)}`,
    );
    expect(up.headers['X-Plex-Token']).toBe('t-tower');
    expect(up.url).not.toContain('t-tower');
    expect(up.fallbackUrl).toBe(`https://tower.example${THUMB}`);
  });

  it('the still variant carries 16:9 dims and resolves on a DIFFERENT matched server', () => {
    const up = resolvePlexArtUpstream('haynesops', THUMB, 'still', ENV)!;
    expect(up.url).toContain('http://ops.example:32400/photo/:/transcode?width=320&height=180');
    expect(up.headers['X-Plex-Token']).toBe('t-ops');
  });

  it('the ETag is strong and server-scoped (two servers, identical path → different ETag)', () => {
    const a = resolvePlexArtUpstream('haynestower', THUMB, 'grid', ENV)!.etag;
    expect(a).toMatch(/^".+"$/);
    expect(a).toBe(plexArtEtag('haynestower', THUMB, 'grid'));
    expect(plexArtEtag('haynesops', THUMB, 'grid')).not.toBe(a);
    expect(plexArtEtag('haynestower', THUMB, 'still')).not.toBe(a);
  });

  it('returns null for a bad slug, an unsafe path, or absent Plex env', () => {
    expect(resolvePlexArtUpstream('nope', THUMB, 'grid', ENV)).toBeNull();
    expect(resolvePlexArtUpstream('haynestower', '/etc/passwd', 'grid', ENV)).toBeNull();
    expect(resolvePlexArtUpstream('haynestower', THUMB, 'grid', {})).toBeNull();
  });
});
