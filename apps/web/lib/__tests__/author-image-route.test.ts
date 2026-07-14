// DESIGN-026 D-04 amendment (group-card art) — the /api/books/author-image proxy route, tested at
// the handler level like poster-route.test.ts (the @hnet/api resolver + @hnet/auth session are
// mocked; the gating/304/tier WIRING is the real thing). Load-bearing: the route is BOTH
// session-gated (401) AND books-section-gated (404) exactly like its parent /api/books/cover; the
// id/version shapes are closed; the primary tier carries the strong ETag + long Cache-Control
// while the fallback tier gets a short max-age and NO ETag (ADR-041 C-02).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerSession = vi.hoisted(() => vi.fn());
const effectiveSectionLevel = vi.hoisted(() => vi.fn());
const getAbsAuthorImage = vi.hoisted(() => vi.fn());
const ETAG = '"author-etag"';

vi.mock('@hnet/auth', () => ({ getServerSession }));
vi.mock('@hnet/api', () => ({
  effectiveSectionLevel,
  getAbsAuthorImage,
  absAuthorImageEtag: () => ETAG,
  // The real closed shapes (mirrored from books-author-art.ts — pinned there by its own tests).
  isValidAbsAuthorId: (id: string) => /^[0-9a-fA-F-]{6,64}$/.test(id),
  isValidAbsAuthorVersion: (v: string) => /^[0-9]{1,16}$/.test(v),
}));

import { GET } from '../../app/api/books/author-image/route';

const ID = '8748856c-ef45-40a2-9f7c-f9147a5d12c4';
const V = '1783996366698';

function call(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request(`http://app.local/api/books/author-image?${query}`, { headers }));
}

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { id: 'u1', role: 'member' } });
  effectiveSectionLevel.mockReset().mockReturnValue('read_only');
  getAbsAuthorImage.mockReset().mockResolvedValue(null);
});

describe('GET /api/books/author-image — gates (session AND books section, like the parent route)', () => {
  it('unauthenticated → 401, resolver never touched', async () => {
    getServerSession.mockResolvedValue(null);
    const res = await call(`id=${ID}&v=${V}`);
    expect(res.status).toBe(401);
    expect(getAbsAuthorImage).not.toHaveBeenCalled();
  });

  it('a caller whose books section is disabled → 404, resolver never touched', async () => {
    effectiveSectionLevel.mockReturnValue('disabled');
    const res = await call(`id=${ID}&v=${V}`);
    expect(res.status).toBe(404);
    expect(effectiveSectionLevel).toHaveBeenCalledWith('member', 'books');
    expect(getAbsAuthorImage).not.toHaveBeenCalled();
  });

  it('rejects junk ids/versions with 404 (closed shapes — not an open image proxy)', async () => {
    for (const q of ['id=../secret&v=1', `id=${ID}&v=v1.png`, `id=${ID}`, `v=${V}`, '']) {
      expect((await call(q)).status, q).toBe(404);
    }
    expect(getAbsAuthorImage).not.toHaveBeenCalled();
  });
});

describe('GET /api/books/author-image — tiers + conditional revalidation (ADR-041 idiom)', () => {
  it('streams the primary (sized WebP) tier with the strong ETag + long Cache-Control', async () => {
    getAbsAuthorImage.mockResolvedValue({
      body: new Uint8Array(8),
      contentType: 'image/webp',
      tier: 'primary',
    });
    const res = await call(`id=${ID}&v=${V}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(getAbsAuthorImage).toHaveBeenCalledWith(ID, V);
  });

  it('an If-None-Match hit → 304 without touching the resolver', async () => {
    const res = await call(`id=${ID}&v=${V}`, { 'if-none-match': ETAG });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(getAbsAuthorImage).not.toHaveBeenCalled();
  });

  it('the fallback tier (original after a resize quirk) gets a SHORT max-age and NO ETag', async () => {
    getAbsAuthorImage.mockResolvedValue({
      body: new Uint8Array(20),
      contentType: 'image/jpeg',
      tier: 'fallback',
    });
    const res = await call(`id=${ID}&v=${V}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('a resolver miss (unknown author / ABS down) → 404 (the card only links here when ABS holds a photo)', async () => {
    const res = await call(`id=${ID}&v=${V}`);
    expect(res.status).toBe(404);
  });
});
