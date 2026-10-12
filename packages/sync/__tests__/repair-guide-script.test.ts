// ADR-109 / DESIGN-055 (PLAN-077 P1) — the Repair Guide's in-cluster tool parses its commands strictly: a read can never
// be mistaken for a write, and `settings` writes only with --set / --known-issue.
import { describe, expect, it } from 'vitest';
import { parseRepairGuideArgs } from '../src/scripts/repair-guide';

describe('repair-guide.ts arguments', () => {
  it('preview a movie, an episode, a season with chosen episodes', () => {
    expect(parseRepairGuideArgs(['preview', '--tmdb', '769'])).toMatchObject({ command: 'preview', tmdb: 769 });
    expect(parseRepairGuideArgs(['preview', '--tvdb', '1', '--episode', 'S01E05'])).toMatchObject({
      episode: { season: 1, episode: 5 },
    });
    expect(
      parseRepairGuideArgs(['preview', '--tvdb', '1', '--season', '1', '--episodes', '1,5', '--replace-file']),
    ).toMatchObject({ season: 1, episodes: [1, 5], replaceFile: true });
  });

  it('evidence needs a person; settings parses the switch', () => {
    expect(() => parseRepairGuideArgs(['evidence', '--tmdb', '769'])).toThrow(/--email/);
    expect(parseRepairGuideArgs(['evidence', '--tmdb', '769', '--email', 'A@B.C'])).toMatchObject({ email: 'a@b.c' });
    expect(
      parseRepairGuideArgs(['evidence', '--tmdb', '769', '--email', 'a@b.c', '--plex-user-id', '77', '--plex-username', 'Member']),
    ).toMatchObject({ plexUserId: '77', plexUsername: 'member' });
    expect(() => parseRepairGuideArgs(['evidence', '--tmdb', '769', '--email', 'a@b.c', '--plex-user-id', 'x'])).toThrow(
      /numeric/,
    );
    expect(parseRepairGuideArgs(['settings'])).toMatchObject({ command: 'settings' });
    expect(
      parseRepairGuideArgs(['settings', '--set', 'replacement_preview=on,season_guard=off', '--known-issue', 'haynesops']),
    ).toMatchObject({ set: { replacement_preview: true, season_guard: false }, knownIssue: ['haynesops'] });
    expect(parseRepairGuideArgs(['settings', '--known-issue', 'none'])).toMatchObject({ knownIssue: [] });
  });

  it('search-plan reads a movie or one episode (DESIGN-055 D-07, PLAN-077 P2)', () => {
    expect(parseRepairGuideArgs(['search-plan', '--tmdb', '9428'])).toMatchObject({ command: 'search-plan', tmdb: 9428 });
    expect(parseRepairGuideArgs(['search-plan', '--tvdb', '425007', '--episode', 'S02E06'])).toMatchObject({
      command: 'search-plan',
      episode: { season: 2, episode: 6 },
    });
    expect(() => parseRepairGuideArgs(['search-plan', '--tvdb', '425007', '--season', '2'])).toThrow(/--episode/);
    expect(parseRepairGuideArgs(['settings', '--set', 'import_check=on'])).toMatchObject({ set: { import_check: true } });
  });

  it('refuses what it does not understand', () => {
    expect(parseRepairGuideArgs([])).toBe('help');
    expect(() => parseRepairGuideArgs(['delete'])).toThrow(/unknown command/);
    expect(() => parseRepairGuideArgs(['preview', '--tmdb', '1', '--tvdb', '2'])).toThrow(/exactly one/);
    expect(() => parseRepairGuideArgs(['preview', '--tvdb', '2'])).toThrow(/--episode or --season/);
    expect(() => parseRepairGuideArgs(['settings', '--set', 'everything=on'])).toThrow(/unknown remedy/);
    expect(() => parseRepairGuideArgs(['settings', '--set', 'season_guard=yes'])).toThrow(/=on or =off/);
    expect(() => parseRepairGuideArgs(['preview', '--tmdb', '1', '--episode', 'S1'])).toThrow(/S01E05/);
  });
});
