import { describe, expect, it } from 'vitest';
import { catalogUrlError, normalizeCatalogUrl } from '../catalog-url';

// BRANCH-A: the catalog accepts arbitrary http(s) URLs (no host allow/deny rules).
describe('catalogUrlError (client mirror)', () => {
  it.each([
    'google.com',
    'www.google.com',
    'https://google.com',
    'https://plex.haynesnetwork.com',
    'sonarr.haynesops.com',
    'plex.example.com:32400',
    'localhost:8080',
  ])('accepts %s', (url) => {
    expect(catalogUrlError(url)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['not a url', 'spaces'],
    ['javascript:alert(1)', 'non-http scheme'],
    ['ftp://example.com', 'non-http scheme'],
    ['eeeee', 'no TLD'],
    ['https://eeeee', 'host has no TLD'],
  ])('rejects %s (%s)', (url) => {
    expect(catalogUrlError(url)).not.toBeNull();
  });
});

describe('normalizeCatalogUrl (canonical form)', () => {
  it.each([
    ['google.com', 'https://google.com'],
    ['www.google.com', 'https://www.google.com'],
    ['https://google.com', 'https://google.com'],
    ['http://foo.internal:8080/x', 'http://foo.internal:8080/x'],
    ['https://plex.haynesnetwork.com/web', 'https://plex.haynesnetwork.com/web'],
    ['sonarr.haynesops.com', 'https://sonarr.haynesops.com'],
    ['plex.example.com:32400', 'https://plex.example.com:32400'],
    ['localhost:8080', 'https://localhost:8080'],
  ])('%s → %s', (raw, expected) => {
    const res = normalizeCatalogUrl(raw);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toBe(expected);
  });

  it('errors on empty / non-http / credentials / no-TLD', () => {
    expect(normalizeCatalogUrl('   ')).toEqual({ ok: false, error: 'Enter a URL.' });
    expect(normalizeCatalogUrl('javascript:alert(1)')).toEqual({
      ok: false,
      error: 'Only http:// and https:// links are allowed.',
    });
    expect(normalizeCatalogUrl('https://user:pw@x.com')).toEqual({
      ok: false,
      error: 'Remove the username and password from the URL.',
    });
    expect(normalizeCatalogUrl('https://eeeee')).toEqual({
      ok: false,
      error: 'Add a top-level domain, e.g. example.com.',
    });
  });
});
