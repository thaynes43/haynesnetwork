// ADR-093 / DESIGN-052 D-15 / D-17 (PLAN-072 S8 / S9) — the coordinator's one-off scripts parse their arguments
// strictly (the seed needs exactly one of --dry-run / --apply; the Seerr switch takes one command).
import { describe, expect, it } from 'vitest';
import { parseSeedArgs } from '../src/scripts/release-block-seed';
import { parseSeerrWatchlistArgs } from '../src/scripts/seerr-watchlist';

describe('release-block-seed arguments', () => {
  it('needs exactly one of --dry-run, --apply and --pool; the files are optional (and refused with --pool)', () => {
    expect(parseSeedArgs(['--dry-run'])).toEqual({
      apply: false,
      pool: false,
      legacySab: null,
      manual: null,
    });
    expect(parseSeedArgs(['--apply', '--legacy-sab=/tmp/sab.tsv', '--manual=/tmp/m.json'])).toEqual(
      {
        apply: true,
        pool: false,
        legacySab: '/tmp/sab.tsv',
        manual: '/tmp/m.json',
      },
    );
    expect(
      parseSeedArgs(['--dry-run', '--legacy-sab', '/tmp/sab.tsv', '--manual', '/tmp/m.json']),
    ).toEqual({
      apply: false,
      pool: false,
      legacySab: '/tmp/sab.tsv',
      manual: '/tmp/m.json',
    });
    // PLAN-072 S6(e) — the read-only pool report.
    expect(parseSeedArgs(['--pool'])).toEqual({
      apply: false,
      pool: true,
      legacySab: null,
      manual: null,
    });
    expect(() => parseSeedArgs(['--pool', '--apply'])).toThrow(/exclusive/);
    expect(() => parseSeedArgs(['--pool', '--manual=/tmp/m.json'])).toThrow(/read-only/);
    expect(() => parseSeedArgs(['--dry-run', '--manual'])).toThrow(/needs a file/);
    expect(parseSeedArgs(['--help'])).toBe('help');
    expect(() => parseSeedArgs([])).toThrow(/--dry-run, --apply or --pool/);
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
