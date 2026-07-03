import { describe, expect, it } from 'vitest';
import { ForbiddenHostError, assertUserFacingUrl, isUserFacingUrl } from '../src/index';

// DESIGN-003 D-04 / test strategy: table-driven R-14 checks against the domain assert
// (the DB CHECK twin is exercised in packages/db/__tests__/migrations.test.ts).

const REJECTED: Array<[string, string]> = [
  ['https://sonarr.haynesops.com', 'LAN-only haynesops.com ingress (CLAUDE.md rule 3)'],
  ['http://plex.haynesnetwork.com', 'plain http'],
  ['https://haynesnetwork.com', 'bare apex — at least one subdomain label required'],
  ['https://evil.haynesnetwork.com.attacker.io', 'suffix attack (end-anchor, DESIGN-001 D-05)'],
  ['https://evil.com/?x=.haynesnetwork.com', 'lookalike in query string'],
  ['https://a.haynesnetwork.com:8443', 'explicit port'],
  ['https://user:pass@a.haynesnetwork.com', 'credentials'],
  ['https://192.168.1.10', 'IP literal'],
  [
    'https://PLEX.haynesnetwork.com',
    'uppercase host (DB CHECK is case-sensitive; normalize first)',
  ],
  ['not a url', 'garbage'],
  ['', 'empty string'],
];

const ACCEPTED: string[] = [
  'https://plex.haynesnetwork.com',
  'https://plex.haynesnetwork.com/web/index.html',
  'https://ai.haynesnetwork.com',
  'https://deep.sub.haynesnetwork.com/path?query=1',
];

describe('assertUserFacingUrl (R-14, mirrors app_catalog_url_haynesnetwork_only)', () => {
  it.each(REJECTED)('rejects %s (%s)', (url) => {
    expect(isUserFacingUrl(url)).toBe(false);
    expect(() => assertUserFacingUrl(url)).toThrow(ForbiddenHostError);
  });

  it.each(ACCEPTED.map((u) => [u]))('accepts %s', (url) => {
    expect(isUserFacingUrl(url)).toBe(true);
    expect(() => assertUserFacingUrl(url)).not.toThrow();
  });
});
