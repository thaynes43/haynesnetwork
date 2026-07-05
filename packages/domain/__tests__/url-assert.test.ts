import { describe, expect, it } from 'vitest';
import { InvalidCatalogUrlError, assertCatalogUrl, normalizeCatalogUrl } from '../src/index';

// ADR-013 / BRANCH-A: the catalog accepts arbitrary http(s) URLs, normalized from common
// forms. No host rules — *.haynesops.com is allowed too. Table-driven against the
// canonical normalizer (the scheme-only DB CHECK twin is exercised in @hnet/db migrations).

// [input, canonical output]
const ACCEPTED: Array<[string, string]> = [
  ['google.com', 'https://google.com'],
  ['www.google.com', 'https://www.google.com'],
  ['https://google.com', 'https://google.com'],
  ['http://foo.internal:8080/x', 'http://foo.internal:8080/x'],
  ['https://plex.haynesnetwork.com/web', 'https://plex.haynesnetwork.com/web'],
  ['sonarr.haynesops.com', 'https://sonarr.haynesops.com'],
  ['plex.example.com:32400', 'https://plex.example.com:32400'], // bare host:port
  ['localhost:8080', 'https://localhost:8080'], // localhost is allowed despite no dot
];

// [input, reason]
const REJECTED: Array<[string, string]> = [
  ['', 'empty string'],
  ['not a url', 'garbage (spaces)'],
  ['javascript:alert(1)', 'non-http(s) scheme'],
  ['mailto:x@y.com', 'non-http(s) scheme'],
  ['ftp://example.com', 'non-http(s) scheme'],
  ['https://user:pw@x.com', 'embedded credentials'],
  ['eeeee', 'no domain / TLD'],
  ['https://eeeee', 'host has no TLD'],
];

describe('normalizeCatalogUrl / assertCatalogUrl (ADR-013, arbitrary-URL normalization)', () => {
  it.each(ACCEPTED)('accepts %s → %s', (input, canonical) => {
    const res = normalizeCatalogUrl(input);
    expect(res).toEqual({ ok: true, url: canonical });
    expect(assertCatalogUrl(input)).toBe(canonical);
  });

  it.each(REJECTED)('rejects %s (%s)', (input) => {
    expect(normalizeCatalogUrl(input).ok).toBe(false);
    expect(() => assertCatalogUrl(input)).toThrow(InvalidCatalogUrlError);
  });
});
