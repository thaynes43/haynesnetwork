// ADR-109 / DESIGN-055 (PLAN-077 P1) — the Repair Guide's in-cluster tool parses its commands strictly: a read can never
// be mistaken for a write, and `settings` writes only with --set / --known-issue.
import { describe, expect, it } from 'vitest';
import { formatReleaseList, formatSeasonPlan, formatTitleCheckBackfill, parseRepairGuideArgs } from '../src/scripts/repair-guide';
import type { SeasonRemapView } from '@hnet/domain';

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
    expect(parseRepairGuideArgs(['queue-check'])).toMatchObject({ command: 'queue-check' });
  });

  it('remap-plan reads a season, or plans a shift or a single move, read-only (DESIGN-055 D-04, PLAN-077 P4)', () => {
    expect(parseRepairGuideArgs(['remap-plan', '--tvdb', '451113', '--season', '1'])).toMatchObject({
      command: 'remap-plan',
      tvdb: 451113,
      season: 1,
    });
    expect(parseRepairGuideArgs(['remap-plan', '--tvdb', '451113', '--season', '1', '--shift', '11:+1:18'])).toMatchObject({
      remap: { kind: 'shift', from: 11, by: 1, through: 18 },
    });
    expect(parseRepairGuideArgs(['remap-plan', '--tvdb', '451113', '--season', '1', '--shift', '3:-1'])).toMatchObject({
      remap: { kind: 'shift', from: 3, by: -1, through: null },
    });
    expect(parseRepairGuideArgs(['remap-plan', '--tvdb', '451113', '--season', '1', '--move', '24:23'])).toMatchObject({
      remap: { kind: 'single', from: 24, to: 23 },
    });
    expect(() => parseRepairGuideArgs(['remap-plan', '--tvdb', '451113'])).toThrow(/a show needs --episode or --season|remap-plan needs/);
    expect(() => parseRepairGuideArgs(['remap-plan', '--tvdb', '1', '--season', '1', '--shift', '11:+2'])).toThrow(/--shift needs/);
    expect(() => parseRepairGuideArgs(['preview', '--tvdb', '1', '--season', '1', '--move', '1:2'])).toThrow(/for remap-plan/);
  });

  it('remap-run needs a claim and the digest of the plan staff checked (DESIGN-055 P4 decision 17)', () => {
    expect(
      parseRepairGuideArgs(['remap-run', '--tvdb', '475718', '--season', '1', '--move', '24:23', '--digest', 'a1b2c3d4e5f6a7b8']),
    ).toMatchObject({ command: 'remap-run', remap: { kind: 'single', from: 24, to: 23 }, digest: 'a1b2c3d4e5f6a7b8' });
    expect(() => parseRepairGuideArgs(['remap-run', '--tvdb', '1', '--season', '1', '--move', '2:1'])).toThrow(/--digest of the plan/);
    expect(() => parseRepairGuideArgs(['remap-run', '--tvdb', '1', '--season', '1', '--digest', 'a1b2c3d4'])).toThrow(/needs a claim/);
    expect(() => parseRepairGuideArgs(['remap-plan', '--tvdb', '1', '--season', '1', '--digest', 'a1b2c3d4'])).toThrow(/--digest is for remap-run/);
    expect(() => parseRepairGuideArgs(['remap-run', '--tvdb', '1', '--season', '1', '--move', '2:1', '--digest', 'nope'])).toThrow(/plan digest/);
  });

  it('title-check runs the backfill (optionally dry) or lists one series\' flags (DESIGN-055 D-05, PLAN-077 P4)', () => {
    expect(parseRepairGuideArgs(['title-check', '--backfill', '--dry-run', '--json'])).toMatchObject({
      command: 'title-check',
      backfill: true,
      dryRun: true,
      json: true,
    });
    expect(parseRepairGuideArgs(['title-check', '--flags', '1061'])).toMatchObject({ command: 'title-check', flagsSeriesId: 1061 });
    expect(() => parseRepairGuideArgs(['title-check'])).toThrow(/exactly one of --backfill or --flags/);
    expect(() => parseRepairGuideArgs(['title-check', '--backfill', '--flags', '1'])).toThrow(/exactly one/);
    expect(() => parseRepairGuideArgs(['title-check', '--flags', '1', '--dry-run'])).toThrow(/--dry-run goes with --backfill/);
    expect(() => parseRepairGuideArgs(['title-check', '--flags', 'x'])).toThrow(/whole number/);
    expect(() => parseRepairGuideArgs(['queue-check', '--backfill'])).toThrow(/are for title-check/);
  });

  it('prints the backfill counts, then one line per file whose name says it is another episode', () => {
    const lines = formatTitleCheckBackfill({
      dryRun: true,
      historyRecords: 22_500,
      historyFiles: 18_000,
      series: 950,
      filesJudged: 17_000,
      fromHistory: 16_500,
      fromSceneName: 500,
      noEvidence: 300,
      verdicts: { agrees: 9_000, disagrees: 1, ambiguous: 500, silent: 7_499 },
      written: 0,
      flagsOpened: 1,
      errors: 0,
      errorSamples: [],
      disagrees: [
        {
          seriesId: 1061,
          seriesTitle: 'Regular Show: The Lost Tapes',
          seasonNumber: 1,
          episodeFileId: 9024,
          episode: { episodeId: 118420, episodeNumber: 24, title: "Don's Back" },
          episodeIds: [118420],
          best: { episodeId: 118419, episodeNumber: 23, title: 'All You Can Fit' },
          score: 0,
          bestScore: 1,
          name: 'Regular.Show..The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-AndreMor',
          nameFrom: 'history',
        },
      ],
    });
    expect(lines[0]).toMatch(/dry run, nothing written.*22500 import records/);
    expect(lines[2]).toBe('agrees 9000, disagrees 1, ambiguous 500, silent 7499; would open 1 flags, wrote 0 rows');
    expect(lines[3]).toBe(
      'Regular Show: The Lost Tapes S01E24 "Don\'s Back" -> S01E23 "All You Can Fit" (score 0.00, best 1.00) file 9024 ' +
        '[history]: Regular.Show..The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-AndreMor',
    );
  });

  it('season-plan and season-run take placements, kept episodes, the digest and the Plex override (DESIGN-055 P4 decisions 18-24)', () => {
    expect(parseRepairGuideArgs(['season-plan', '--tvdb', '279257', '--season', '20'])).toMatchObject({ command: 'season-plan', tvdb: 279257, season: 20 });
    expect(
      parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--place', '14:13,19:21', '--place', '53-54:27-28', '--keep', '4,5', '--json']),
    ).toMatchObject({
      placements: [
        { from: [14], to: [13] },
        { from: [19], to: [21] },
        { from: [53, 54], to: [27, 28] },
      ],
      keep: [4, 5],
      json: true,
    });
    expect(
      parseRepairGuideArgs(['season-run', '--tvdb', '1', '--season', '5', '--place', '14:13', '--digest', 'abcdef0123456789', '--ignore-plex']),
    ).toMatchObject({ command: 'season-run', digest: 'abcdef0123456789', ignorePlex: true });
    expect(() => parseRepairGuideArgs(['season-run', '--tvdb', '1', '--season', '5'])).toThrow(/--digest/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1'])).toThrow(/--season/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--place', '14-15:13'])).toThrow(/--place/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--ignore-plex'])).toThrow(/season-run/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--shift', '11:+1'])).toThrow(/remap-plan/);
    expect(() => parseRepairGuideArgs(['remap-plan', '--tvdb', '1', '--season', '5', '--place', '1:2'])).toThrow(/season-plan/);
  });

  it('prints the season plan: steps, files that stay, files to place, the Plex check and the digest', () => {
    const ref = (n: number, title: string) => ({ id: 100 + n, episodeNumber: n, title, label: `S01E0${n} · ${title}` });
    const view = {
      seasonNumber: 1,
      seriesId: 777,
      seriesTitle: 'Show',
      steps: [
        { kind: 'park', fileId: 1, fileName: 'a.mkv', size: 1, releaseGroup: 'GRP', from: [ref(2, 'Bravo')], to: [{ ...ref(1, 'Special'), label: 'S00E01 · Special' }], why: 'name', nameSays: { name: 'Show.S01E02.Charlie', verdict: 'agrees', best: ref(3, 'Charlie') } },
      ],
      moved: 2,
      held: [{ fileId: 9, fileName: 'x.mkv', on: [ref(5, 'Echo')], reason: 'duplicate', names: ref(4, 'Delta'), name: 'Show.S01E05.Delta' }],
      unplaced: [{ fileId: 8, fileName: 'y.mkv', on: [ref(6, 'Foxtrot')], name: 'Show.S01E06', verdict: 'silent', suggestion: ref(7, 'Golf') }],
      open: [ref(7, 'Golf')],
      vacated: [],
      parking: { ...ref(1, 'Special'), label: 'S00E01 · Special', seasonNumber: 0 },
      refusal: null,
      refusalDetail: null,
      digest: 'abc123',
      plexCheck: { servers: [{ server: 'haynestower', items: 7, followsTvdb: 7, differs: 0, unknown: 0 }], wrongAfter: [], worse: 0, ok: true },
      plexError: null,
      remapOn: true,
      refusalText: null,
    } as unknown as SeasonRemapView;
    const out = formatSeasonPlan('Show', view);
    expect(out).toContain('Show, season 1 (Sonarr series 777): 2 files move in 1 steps, passing through S00E01 · Special (season 0).');
    expect(out).toContain('Plex haynestower: 7 of 7 titled items carry the TVDB title (0 untitled).');
    expect(out).toContain('Plex check: ok (no move makes a Plex title worse).');
    expect(out).toContain('  1. park   S01E02 · Bravo -> S00E01 · Special [name; name agrees] Show.S01E02.Charlie');
    expect(out).toContain('stays S01E05 · Echo (duplicate), its name says S01E04 · Delta: Show.S01E05.Delta');
    expect(out).toContain('unplaced S01E06 · Foxtrot (name silent): Show.S01E06 -> suggestion --place 6:7');
    expect(out).toContain('digest abc123');
  });

  it('release-list reads a movie or one episode, read-only, optionally as JSON (DESIGN-055 D-06, PLAN-077 P5)', () => {
    expect(parseRepairGuideArgs(['release-list', '--tmdb', '9428'])).toMatchObject({ command: 'release-list', tmdb: 9428 });
    expect(parseRepairGuideArgs(['release-list', '--tvdb', '475718', '--episode', 'S01E11', '--json'])).toMatchObject({
      command: 'release-list',
      tvdb: 475718,
      episode: { season: 1, episode: 11 },
      json: true,
    });
    expect(() => parseRepairGuideArgs(['release-list', '--tvdb', '475718', '--season', '1'])).toThrow(/--episode/);
    expect(() => parseRepairGuideArgs(['search-plan', '--tmdb', '1', '--json'])).toThrow(/--json/);
  });

  it("release-grab is staff's Release Pick: it needs the row key release-list printed (DESIGN-055 P5 decision 14)", () => {
    expect(parseRepairGuideArgs(['release-grab', '--tvdb', '475718', '--episode', 'S01E11', '--key', '0123456789abcdef'])).toMatchObject({
      command: 'release-grab',
      key: '0123456789abcdef',
    });
    expect(() => parseRepairGuideArgs(['release-grab', '--tvdb', '475718', '--episode', 'S01E11'])).toThrow(/--key/);
    expect(() => parseRepairGuideArgs(['release-grab', '--tvdb', '475718', '--episode', 'S01E11', '--key', 'nope'])).toThrow(/16-character/);
    expect(() => parseRepairGuideArgs(['release-list', '--tmdb', '1', '--key', '0123456789abcdef'])).toThrow(/only it/);
  });

  it('prints the Release Pick preview: the counts, then each row with its reasons beside the *arr words', () => {
    const lines = formatReleaseList('Regular Show: The Lost Tapes', {
      status: 'list',
      kind: 'sonarr',
      targetLabel: 'S01E11 · Spice It Up',
      listId: null,
      searchedAt: '2026-10-13T11:00:00.000Z',
      download: null,
      reasonsVersion: 1,
      recommendedKey: 'aaaaaaaaaaaaaaaa',
      offers: 1,
      counts: { grab: 0, override: 1, notAllowed: 1, sources: 5, dropped: 3 },
      rows: [
        {
          key: 'aaaaaaaaaaaaaaaa', keys: ['aaaaaaaaaaaaaaaa'], title: 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT',
          sizeBytes: 352_000_000, qualityName: 'WEBDL-1080p', qualityPlain: '1080p', languages: ['English'], customFormatScore: -9925,
          ageHours: 640, indexer: 'NZBgeek (Prowlarr)', protocol: 'usenet', releaseGroup: 'OldT', state: 'override', recommended: true,
          numberedAs: 'S01E10 · Stilt Walkers', evidence: { verdict: 'agrees', namedLabel: null },
          reasons: [
            { code: 'score_below_minimum', class: 'overridable', text: 'Lower quality than the library usually keeps', arrText: 'Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0' },
          ],
        },
        {
          key: 'bbbbbbbbbbbbbbbb', keys: ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'], title: 'Regular.Show.The.Lost.Tapes.S01E11.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA',
          sizeBytes: null, qualityName: 'WEBDL-1080p', qualityPlain: '1080p', languages: ['English'], customFormatScore: 75,
          ageHours: 369, indexer: 'DrunkenSlug (Prowlarr)', protocol: 'usenet', releaseGroup: 'BiOMA', state: 'not_allowed', recommended: false,
          numberedAs: null, evidence: { verdict: 'silent', namedLabel: null },
          reasons: [{ code: 'blocklisted', class: 'hard', text: 'Blocked after an earlier download of it failed or was removed', arrText: 'Release is blocklisted' }],
        },
      ],
    });
    expect(lines[0]).toBe('Regular Show: The Lost Tapes S01E11 · Spice It Up: list');
    expect(lines[1]).toMatch(/5 sources, 3 for other episodes or titles dropped; 0 grab, 1 override, 1 not allowed/);
    expect(lines[2]).toMatch(/^\* \[OVERRIDE\] Regular\.Show.*OldT \| WEBDL-1080p 0\.33 GB \| NZBgeek \(Prowlarr\) title:agrees \| key a{16}$/);
    expect(lines[3]).toBe(
      '      overridable: Lower quality than the library usually keeps  [Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0]',
    );
    expect(lines[4]).toMatch(/^ {2}\[NOT ALLOWED\] .*BiOMA \| WEBDL-1080p \? \| DrunkenSlug \(Prowlarr\) \+1 more title:silent \| key b{16}$/);
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
