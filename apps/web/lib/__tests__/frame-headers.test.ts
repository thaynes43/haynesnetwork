// RFC 9700 §4.16 (clickjacking) — ADR-091 / DESIGN-050, from the review: every route, the OAuth consent page above
// all, answers with `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` (next.config.ts `headers()`), so no
// other site can frame an Approve button.
import { describe, expect, it } from 'vitest';
import nextConfig, { FRAME_DENY_HEADERS } from '../../next.config';

describe('frame-deny headers (next.config.ts)', () => {
  it('apply to every path, with both the legacy and the CSP form', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ]);
    expect(FRAME_DENY_HEADERS).toHaveLength(2);
  });

  it('the /:path* source matches the OAuth pages, the login page and the root (path-to-regexp semantics)', () => {
    // Next compiles `/:path*` to "zero or more segments": one rule covers `/`, `/login`, `/oauth/consent`, …
    const re = /^\/(?:[^/]+(?:\/[^/]+)*)?\/?$/;
    for (const path of [
      '/',
      '/login',
      '/oauth/consent',
      '/oauth/authorize',
      '/settings/connections',
      '/mcp',
    ]) {
      expect(re.test(path), path).toBe(true);
    }
  });
});
