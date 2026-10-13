// ADR-109 / DESIGN-055 (PLAN-077 P1) — the Repair Guide's in-cluster tool parses its commands strictly: a read can never
// be mistaken for a write, and `settings` writes only with --set / --known-issue.
import { describe, expect, it } from 'vitest';
import { formatAudioScan, formatCarryResult, formatReleaseList, formatSeasonPlan, formatTitleCheckBackfill, parseRepairGuideArgs } from '../src/scripts/repair-guide';
import type { SeasonRemapView, WatchCarryResult } from '@hnet/domain';

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
    // P4 decision 35: the sides may name different counts, and a target may list episodes apart.
    expect(parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--place', '17:33-34,5-8:3-4,29-30:25+32'])).toMatchObject({
      placements: [
        { from: [17], to: [33, 34] },
        { from: [5, 6, 7, 8], to: [3, 4] },
        { from: [29, 30], to: [25, 32] },
      ],
    });
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--place', '14-15'])).toThrow(/--place/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '5', '--place', '14:13+13'])).toThrow(/--place/);
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
      parkings: [{ ...ref(1, 'Special'), label: 'S00E01 · Special', seasonNumber: 0 }],
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
          numberedAs: 'S01E10 · Stilt Walkers', evidence: { verdict: 'agrees', namedLabel: null }, holds: null,
          reasons: [
            { code: 'score_below_minimum', class: 'overridable', text: 'Lower quality than the library usually keeps', arrText: 'Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0' },
          ],
        },
        {
          key: 'bbbbbbbbbbbbbbbb', keys: ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'], title: 'Regular.Show.The.Lost.Tapes.S01E11.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA',
          sizeBytes: null, qualityName: 'WEBDL-1080p', qualityPlain: '1080p', languages: ['English'], customFormatScore: 75,
          ageHours: 369, indexer: 'DrunkenSlug (Prowlarr)', protocol: 'usenet', releaseGroup: 'BiOMA', state: 'not_allowed', recommended: false,
          numberedAs: null, evidence: { verdict: 'silent', namedLabel: null }, holds: null,
          reasons: [{ code: 'blocklisted', class: 'hard', text: 'Blocked after an earlier download of it failed or was removed', arrText: 'Release is blocklisted' }],
        },
        {
          key: 'dddddddddddddddd', keys: ['dddddddddddddddd'], title: 'Regular.Show.The.Lost.Tapes.S01E11E12.720p.WEB.H.264-JFF',
          sizeBytes: null, qualityName: 'WEBDL-720p', qualityPlain: '720p', languages: ['English'], customFormatScore: 0,
          ageHours: 10, indexer: 'NZBgeek (Prowlarr)', protocol: 'usenet', releaseGroup: 'JFF', state: 'override', recommended: false,
          numberedAs: null, evidence: { verdict: 'silent', namedLabel: null },
          holds: ['S01E11 · Spice It Up', 'S01E12 · Secret Menu Item'],
          reasons: [{ code: 'quality_not_wanted', class: 'overridable', text: 'Not a quality the library usually keeps (720p)', arrText: 'WEBDL-720p is not wanted in profile' }],
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
    // P5 decision 17: a release that holds two missing episodes names both.
    expect(lines[7]).toBe('      holds: S01E11 · Spice It Up + S01E12 · Secret Menu Item');
  });

  it('copy-plan and copy-run name one episode, optionally the original, and need the digest and evidence (DESIGN-055 P4 decision 25)', () => {
    expect(parseRepairGuideArgs(['copy-plan', '--tvdb', '274453', '--episode', 'S20E03'])).toMatchObject({
      command: 'copy-plan',
      episode: { season: 20, episode: 3 },
    });
    expect(parseRepairGuideArgs(['copy-plan', '--tvdb', '1', '--episode', 'S06E10', '--copy-of', '13'])).toMatchObject({ copyOf: 13 });
    expect(
      parseRepairGuideArgs(['copy-run', '--tvdb', '1', '--episode', 'S06E10', '--digest', 'abcdef0123456789', '--evidence', 'subtitles match at 5:00']),
    ).toMatchObject({ command: 'copy-run', digest: 'abcdef0123456789', evidence: 'subtitles match at 5:00' });
    expect(() => parseRepairGuideArgs(['copy-run', '--tvdb', '1', '--episode', 'S06E10', '--digest', 'abcdef0123456789'])).toThrow(/--evidence/);
    expect(() => parseRepairGuideArgs(['copy-plan', '--tvdb', '1', '--season', '6'])).toThrow(/--episode/);
    expect(() => parseRepairGuideArgs(['copy-plan', '--tvdb', '1', '--episode', 'S06E10', '--evidence', 'subtitles match'])).toThrow(/copy-run/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '6', '--copy-of', '3'])).toThrow(/copy-plan/);
  });

  it('audio-preference reads, and writes only with the digest it printed; language-plan and audio-scan read (DESIGN-055 P6)', () => {
    expect(parseRepairGuideArgs(['audio-preference', '--tvdb', '475718', '--episode', 'S01E12', '--language', 'ENG'])).toMatchObject({
      command: 'audio-preference',
      tvdb: 475718,
      episode: { season: 1, episode: 12 },
      language: 'eng',
    });
    expect(
      parseRepairGuideArgs(['audio-preference', '--tvdb', '1', '--season', '1', '--language', 'eng', '--digest', 'abcdef0123456789abcdef01']),
    ).toMatchObject({ season: 1, digest: 'abcdef0123456789abcdef01' });
    expect(parseRepairGuideArgs(['audio-preference', '--tmdb', '769', '--language', 'eng'])).toMatchObject({ tmdb: 769 });
    expect(() => parseRepairGuideArgs(['audio-preference', '--tvdb', '1', '--episode', 'S01E01'])).toThrow(/--language/);
    expect(() => parseRepairGuideArgs(['audio-preference', '--tvdb', '1', '--language', 'eng'])).toThrow(/--episode or --season/);
    expect(() => parseRepairGuideArgs(['audio-preference', '--tvdb', '1', '--episode', 'S01E01', '--language', 'english'])).toThrow(/three-letter/);
    expect(parseRepairGuideArgs(['language-plan', '--tvdb', '1', '--episode', 'S01E05', '--language', 'eng'])).toMatchObject({ command: 'language-plan' });
    expect(() => parseRepairGuideArgs(['language-plan', '--tvdb', '1', '--season', '1', '--language', 'eng'])).toThrow(/--episode/);
    expect(() => parseRepairGuideArgs(['language-plan', '--tvdb', '1', '--episode', 'S01E05', '--language', 'eng', '--digest', 'abcdef0123456789'])).toThrow(/--digest/);
    expect(parseRepairGuideArgs(['audio-scan'])).toMatchObject({ command: 'audio-scan' });
    expect(parseRepairGuideArgs(['audio-scan', '--json', '--apply-original', 'eng'])).toMatchObject({ json: true, applyOriginal: 'eng' });
    expect(() => parseRepairGuideArgs(['audio-scan', '--tvdb', '1'])).toThrow(/audio-scan takes only/);
    // DESIGN-055 P6 decision 14 (#955): the owner's household default, as staff.
    expect(parseRepairGuideArgs(['audio-scan', '--apply-household'])).toMatchObject({ command: 'audio-scan', household: true });
    expect(() => parseRepairGuideArgs(['audio-scan', '--apply-household', '--apply-original', 'eng'])).toThrow(/one of/);
    expect(
      parseRepairGuideArgs(['audio-preference', '--tvdb', '321285', '--episode', 'S01E01', '--language', 'eng', '--household']),
    ).toMatchObject({ household: true, language: 'eng' });
    expect(() => parseRepairGuideArgs(['language-plan', '--tvdb', '1', '--episode', 'S01E05', '--language', 'eng', '--household'])).toThrow(
      /--household is for audio-preference/,
    );
    expect(() => parseRepairGuideArgs(['preview', '--tmdb', '1', '--household'])).toThrow(/--apply-household is for audio-scan/);
    expect(() => parseRepairGuideArgs(['preview', '--tmdb', '1', '--language', 'eng'])).toThrow(/--language is for/);
    expect(() => parseRepairGuideArgs(['preview', '--tmdb', '1', '--apply-original', 'eng'])).toThrow(/--apply-original is for/);
  });

  it('prints the audio scan: one line per show, open ones first', () => {
    const lines = formatAudioScan({
      seriesScanned: 965,
      filesRead: 63647,
      findings: [
        {
          tvdbId: 74550, seriesId: 1, mediaItemId: null, title: 'Star Trek: Voyager', original: 'eng', filesWithOriginal: 154,
          filesFirstOther: 110, leadingLanguages: ['ger'], sample: { episodeId: 9, label: 'S02E01', fileName: 'x.mkv' }, plexDefault: 'ger',
          plex: [{ server: 'HaynesOps', current: '', unreachable: false }], preferenceSet: false,
          english: { files: 154, leadOther: 110, sample: { episodeId: 9, label: 'S02E01' } },
        },
        {
          tvdbId: 475718, seriesId: 1061, mediaItemId: null, title: 'Regular Show: The Lost Tapes', original: 'eng', filesWithOriginal: 20,
          filesFirstOther: 8, leadingLanguages: ['por'], sample: { episodeId: 2, label: 'S01E12', fileName: 'y.mkv' }, plexDefault: 'por',
          plex: [{ server: 'HaynesTower', current: 'en-US', unreachable: false }, { server: 'HaynesOps', current: 'en-US', unreachable: false }],
          preferenceSet: true,
          english: { files: 20, leadOther: 8, sample: { episodeId: 2, label: 'S01E12' } },
        },
      ],
    });
    expect(lines[0]).toBe('scanned 965 series with files (63647 files); 2 put another language ahead of the original one');
    expect(lines[1]).toBe(
      'OPEN tvdb 74550 Star Trek: Voyager | original eng | 110/154 files lead with ger | Plex starts S02E01 in ger | HaynesOps=account default',
    );
    expect(lines[2]).toMatch(/^set {2}tvdb 475718 .*HaynesTower=en-US HaynesOps=en-US$/);
  });

  it('ordering-plan and ordering-run name the show and Plex’s ordering, and the run needs the digest (ADR-114 C-08)', () => {
    expect(parseRepairGuideArgs(['ordering-plan', '--tvdb', '281414', '--ordering', 'tvdbAiring'])).toMatchObject({
      command: 'ordering-plan',
      tvdb: 281414,
      ordering: 'tvdbAiring',
    });
    expect(parseRepairGuideArgs(['ordering-run', '--tvdb', '281414', '--ordering', 'default', '--digest', 'abcdef0123456789'])).toMatchObject({
      ordering: '',
      digest: 'abcdef0123456789',
    });
    expect(() => parseRepairGuideArgs(['ordering-run', '--tvdb', '281414', '--ordering', 'tvdbAiring'])).toThrow(/--digest/);
    expect(() => parseRepairGuideArgs(['ordering-plan', '--tvdb', '281414', '--ordering', 'tvdb'])).toThrow(/--ordering needs/);
    expect(() => parseRepairGuideArgs(['ordering-plan', '--tvdb', '281414'])).toThrow(/--ordering/);
    expect(() => parseRepairGuideArgs(['season-plan', '--tvdb', '1', '--season', '1', '--ordering', 'tvdbAiring'])).toThrow(/--ordering is for/);
  });

  it('carry-status takes a carry or a show; carry-finish and carry-revert need the carry id (ADR-114 C-06, C-07)', () => {
    const id = '0f7c2a8e-1b2c-4d3e-8f9a-0b1c2d3e4f50';
    expect(parseRepairGuideArgs(['carry-status', '--carry', id])).toMatchObject({ command: 'carry-status', carry: id });
    expect(parseRepairGuideArgs(['carry-status', '--tvdb', '261511'])).toMatchObject({ command: 'carry-status', tvdb: 261511 });
    expect(parseRepairGuideArgs(['carry-finish', '--carry', id])).toMatchObject({ command: 'carry-finish', carry: id });
    expect(parseRepairGuideArgs(['carry-revert', '--carry', id])).toMatchObject({ command: 'carry-revert', carry: id });
    expect(() => parseRepairGuideArgs(['carry-finish', '--tvdb', '1'])).toThrow(/--carry/);
    expect(() => parseRepairGuideArgs(['carry-status'])).toThrow(/exactly one/);
    expect(() => parseRepairGuideArgs(['carry-revert', '--carry', 'nope'])).toThrow(/--carry needs/);
    expect(() => parseRepairGuideArgs(['season-run', '--tvdb', '1', '--season', '1', '--digest', 'abcdef01', '--carry', id])).toThrow(/--carry is for/);
  });

  it('prints a carry’s verification by account index, never a name', () => {
    const result: WatchCarryResult = {
      carryId: 'c-1',
      status: 'mismatch',
      accounts: {
        haynestower: {
          'account 1': { written: 3, failed: 0, watchedCarried: 2, resumesCarried: 1, cleanItems: 1, newViews: 0, lost: 0, mismatches: 0 },
          'account 2': { written: 1, failed: 1, watchedCarried: 0, resumesCarried: 0, cleanItems: 0, newViews: 1, lost: 0, mismatches: 1 },
        },
      },
      totals: { accounts: 2, written: 4, failed: 1, mismatches: 1, watchedCarried: 2, resumesCarried: 1, newViews: 1, lost: 0 },
      mismatchDetail: [
        { server: 'haynestower', account: 'account 2', ratingKey: '46420', episode: 'S1E7', want: { viewCount: 1, viewOffset: 0, lastViewedAt: null }, got: { viewCount: 0, viewOffset: 0, lastViewedAt: null } },
      ],
    };
    const text = formatCarryResult(result);
    expect(text).toContain('Watch carry c-1: MISMATCH. 2 account(s) with state; 4 item(s) written (1 failed); 2 watched file(s) on their item');
    expect(text).toContain('  haynestower account 1: watched 2, resume 1, clean 1, written 3');
    expect(text).toContain('  haynestower account 2: watched 0, resume 0, clean 0, written 1, FAILED 1, new views 1, MISMATCH 1');
    expect(text).toContain('  mismatch haynestower account 2 S1E7 (item 46420): want plays 1 at 0 ms, got plays 0 at 0 ms');
    expect(text).toContain('carry-finish --carry c-1');
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
