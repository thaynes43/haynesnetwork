import { describe, expect, it } from 'vitest';
import { catalogUrlError } from '../catalog-url';

// The DESIGN-003 R-14 table, mirrored client-side (server stays authoritative).
describe('catalogUrlError (R-14 client mirror)', () => {
  it.each([
    'https://plex.haynesnetwork.com',
    'https://seerr.haynesnetwork.com/requests?filter=new',
    'https://a.b.haynesnetwork.com/deep/path',
  ])('accepts %s', (url) => {
    expect(catalogUrlError(url)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['not a url', 'unparseable'],
    ['http://plex.haynesnetwork.com', 'http'],
    ['https://sonarr.haynesops.com', 'haynesops host (hard rule 3)'],
    ['https://haynesnetwork.com', 'bare apex'],
    ['https://evil.com/?x=.haynesnetwork.com', 'lookalike query'],
    ['https://evil.haynesnetwork.com.attacker.io', 'suffix attack'],
    ['https://a.haynesnetwork.com:8443', 'port'],
    ['https://user:pw@a.haynesnetwork.com', 'credentials'],
    ['https://192.168.1.10', 'IP literal'],
  ])('rejects %s (%s)', (url) => {
    expect(catalogUrlError(url)).not.toBeNull();
  });
});
