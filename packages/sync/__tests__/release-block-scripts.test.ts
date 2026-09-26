// ADR-093 / DESIGN-052 D-15 / D-17 (PLAN-072 S8 / S9) — the coordinator's one-off scripts parse their arguments
// strictly (the seed needs exactly one of --dry-run / --apply; the Seerr switch takes one command).
import { describe, expect, it } from 'vitest';
import { parseSeedArgs } from '../src/scripts/release-block-seed';
import { parseSeerrWatchlistArgs } from '../src/scripts/seerr-watchlist';

describe('release-block-seed arguments', () => {
  it('needs exactly one of --dry-run and --apply; the files are optional', () => {
    expect(parseSeedArgs(['--dry-run'])).toEqual({ apply: false, legacySab: null, manual: null });
    expect(parseSeedArgs(['--apply', '--legacy-sab=/tmp/sab.tsv', '--manual=/tmp/m.json'])).toEqual(
      {
        apply: true,
        legacySab: '/tmp/sab.tsv',
        manual: '/tmp/m.json',
      },
    );
    expect(
      parseSeedArgs(['--dry-run', '--legacy-sab', '/tmp/sab.tsv', '--manual', '/tmp/m.json']),
    ).toEqual({
      apply: false,
      legacySab: '/tmp/sab.tsv',
      manual: '/tmp/m.json',
    });
    expect(() => parseSeedArgs(['--dry-run', '--manual'])).toThrow(/needs a file/);
    expect(parseSeedArgs(['--help'])).toBe('help');
    expect(() => parseSeedArgs([])).toThrow(/--dry-run or --apply/);
    expect(() => parseSeedArgs(['--dry-run', '--apply'])).toThrow(/exclusive/);
    expect(() => parseSeedArgs(['--dry-run', '--nope'])).toThrow(/unknown/);
  });
});

describe('seerr-watchlist arguments', () => {
  it('parses --show, --enroll and --anime-tags', () => {
    expect(parseSeerrWatchlistArgs(['--show'])).toEqual({ kind: 'show' });
    expect(parseSeerrWatchlistArgs(['--enroll=off'])).toEqual({
      kind: 'enroll',
      enabled: false,
      onlyUserIds: null,
    });
    expect(parseSeerrWatchlistArgs(['--enroll=all'])).toEqual({
      kind: 'enroll',
      enabled: true,
      onlyUserIds: null,
    });
    expect(parseSeerrWatchlistArgs(['--enroll=2,5'])).toEqual({
      kind: 'enroll',
      enabled: true,
      onlyUserIds: [2, 5],
    });
    expect(parseSeerrWatchlistArgs(['--anime-tags=0:1'])).toEqual({
      kind: 'anime-tags',
      serverId: 0,
      tags: [1],
    });
    expect(() => parseSeerrWatchlistArgs(['--enroll=x'])).toThrow();
    expect(() => parseSeerrWatchlistArgs(['--anime-tags=1'])).toThrow();
    expect(() => parseSeerrWatchlistArgs(['--show', '--enroll=all'])).toThrow(/exactly one/);
  });
});
