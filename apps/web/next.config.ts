import type { NextConfig } from 'next';
import { resolve } from 'node:path';

/**
 * ADR-091 / DESIGN-050 (RFC 9700 §4.16, clickjacking): no page of the app may be framed by another site — the OAuth
 * consent page above all (a framed Approve button is the attack). Every route answers with both the legacy
 * `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. Nothing embeds the app (the storage page's Grafana
 * footnote is a link, never an iframe), so the rule applies to every path.
 */
export const FRAME_DENY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
] as const;

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  async headers() {
    return [{ source: '/:path*', headers: FRAME_DENY_HEADERS.map((h) => ({ ...h })) }];
  },
};

export default nextConfig;
