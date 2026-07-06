import { describe, expect, it } from 'vitest';
import { classifyRunItem, ledgerExportQuery, summarizeRun } from '../ledger';

// DESIGN-009 D-05 / ADR-022 — the report classification contract: success keys off `ok`,
// the search badge off `searched`, and error TEXT alone never fails an item.
describe('classifyRunItem', () => {
  it('classifies an added + searched item', () => {
    expect(
      classifyRunItem({ mediaItemId: 'a', ok: true, outcome: 'added', searched: true }),
    ).toEqual({ kind: 'added', searched: true, searchFailed: false, note: null });
  });

  it('classifies a monitored (flip) item', () => {
    expect(
      classifyRunItem({ mediaItemId: 'a', ok: true, outcome: 'monitored', searched: true }),
    ).toEqual({ kind: 'monitored', searched: true, searchFailed: false, note: null });
  });

  it('an ok item missing outcome defaults to added (legacy restore rows)', () => {
    expect(classifyRunItem({ mediaItemId: 'a', ok: true }).kind).toBe('added');
  });

  it('ok:true WITH error text stays a success — search failed, item did not (D-05)', () => {
    const c = classifyRunItem({
      mediaItemId: 'a',
      ok: true,
      outcome: 'added',
      searchError: 'indexer throttled',
    });
    expect(c.kind).toBe('added');
    expect(c.searched).toBe(false);
    expect(c.searchFailed).toBe(true);
    expect(c.note).toBe('indexer throttled');
  });

  it('a skipped:-prefixed failure is a skip, with the reason surfaced', () => {
    const c = classifyRunItem({
      mediaItemId: 'a',
      ok: false,
      error: 'skipped: already present and monitored in the live *arr',
    });
    expect(c.kind).toBe('skipped');
    expect(c.note).toBe('already present and monitored in the live *arr');
  });

  it('any other ok:false is a real failure', () => {
    const c = classifyRunItem({ mediaItemId: 'a', ok: false, error: 'root folder not found' });
    expect(c.kind).toBe('failed');
    expect(c.note).toBe('root folder not found');
  });
});

describe('summarizeRun', () => {
  it('counts each outcome and the searched total', () => {
    expect(
      summarizeRun([
        { mediaItemId: 'a', ok: true, outcome: 'added', searched: true },
        { mediaItemId: 'b', ok: true, outcome: 'monitored', searched: true },
        { mediaItemId: 'c', ok: false, error: 'skipped: already present in the live *arr' },
        { mediaItemId: 'd', ok: false, error: 'boom' },
      ]),
    ).toEqual({ added: 1, monitored: 1, skipped: 1, failed: 1, searched: 2 });
  });
});

// ADR-022 C-03 — the export URL mirrors the FILTER (comma lists, monitored=true|false,
// hasFile only when narrowing), matching buildExportFilterFromParams' lenient parser.
describe('ledgerExportQuery', () => {
  it('always carries the tab arrKind and drops empty dims', () => {
    expect(ledgerExportQuery({ arrKind: 'radarr' })).toBe('arrKind=radarr');
  });

  it('serializes every active dim in the route contract shape', () => {
    const qs = ledgerExportQuery({
      arrKind: 'sonarr',
      query: '  heist ',
      monitored: false,
      hasFile: 'none',
      genres: ['Action', 'Drama'],
      resolutions: ['1080p'],
      requesters: ['manofoz'],
      sourceCollections: ['emmycollection'],
      ratingMin: 7,
      ratingMax: 9,
    });
    const params = new URLSearchParams(qs);
    expect(params.get('arrKind')).toBe('sonarr');
    expect(params.get('query')).toBe('heist');
    expect(params.get('monitored')).toBe('false');
    expect(params.get('hasFile')).toBe('none');
    expect(params.get('genres')).toBe('Action,Drama');
    expect(params.get('resolutions')).toBe('1080p');
    expect(params.get('requesters')).toBe('manofoz');
    expect(params.get('sourceCollections')).toBe('emmycollection');
    expect(params.get('ratingMin')).toBe('7');
    expect(params.get('ratingMax')).toBe('9');
  });

  it("hasFile 'any' is the absent default, never serialized", () => {
    expect(ledgerExportQuery({ arrKind: 'lidarr', hasFile: 'any' })).toBe('arrKind=lidarr');
  });
});
