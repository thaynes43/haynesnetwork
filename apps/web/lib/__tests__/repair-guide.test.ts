// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide's pure rules (lib/repair-guide.ts): the
// step order each remedy switches, the "gone afterwards" lines (never pre-ticked: the component starts with none
// acknowledged), the refusals that end the guide without a confirm, and the confirm wording and fields.
import { describe, expect, it } from 'vitest';
import {
  GUIDE_REASON_LABELS,
  confirmFieldsFor,
  confirmLabelFor,
  filesLacking,
  firstGuideStep,
  goneLinesFor,
  joinServerNames,
  languagePlans,
  orderPlayTargets,
  ordinal,
  refusalFor,
  remapChoiceOn,
  stepAfterChoice,
  stepAfterReason,
  stepAfterLanguage,
  stepAfterTriage,
  trackAdvice,
  wantedLanguageInFile,
  type GuidePlan,
  type GuideRemedies,
} from '../repair-guide';

const ON: GuideRemedies = {
  replacement_preview: true,
  season_guard: true,
  language_check: true,
  playback_triage: true,
};
const OFF: GuideRemedies = {
  replacement_preview: false,
  season_guard: false,
  language_check: false,
  playback_triage: false,
};

const deletePlan = (verdict: 'ok' | 'same_release' | 'no_replacement' | 'unchecked', withFile = true): GuidePlan => ({
  kind: 'delete',
  scope: 'item',
  targetLabel: null,
  file: withFile
    ? { fileId: 1507, name: 'GoodFellas (1990) [Remux-2160p]-FRAMESTOR.mkv', releaseGroup: 'FRAMESTOR', qualityName: 'Remux-2160p', size: 87_610_002_547 }
    : null,
  replacement: {
    verdict,
    candidate:
      verdict === 'no_replacement' || verdict === 'unchecked'
        ? null
        : {
            title: 'Goodfellas.1990.UHD.BluRay.2160p.REMUX-FraMeSToR',
            releaseGroup: 'FraMeSToR',
            qualityName: 'Remux-2160p',
            size: 99_476_445_308,
            protocol: 'usenet',
            indexer: 'NinjaCentral (Prowlarr)',
            customFormatScore: 5950,
            fullSeason: false,
          },
    basis: verdict === 'same_release' ? 'identity' : null,
  },
  insteadOfPack: false,
  packCost: [],
  digest: 'abc123abc123',
});

const blocklistPlan = (packCost: number): GuidePlan => ({
  kind: 'blocklist',
  scope: 'episode',
  targetLabel: 'S01E01 · One',
  grab: { grabId: 801, sourceTitle: 'Show.S01.1080p-PK', releaseSource: null },
  packCost: Array.from({ length: packCost }, (_, i) => ({ episodeId: 2 + i, label: `S01E0${2 + i}` })),
  digest: 'def456def456',
});

const seasonPlan = (marks: number, actionable = marks > 0): GuidePlan => ({
  kind: 'season',
  seasonNumber: 1,
  targetLabel: 'Season 1',
  mode: 'blocklist',
  chosen: [],
  marks: Array.from({ length: marks }, (_, i) => ({
    grabId: 900 + i,
    downloadKey: `dl:${i}`,
    sourceTitle: `Release ${i}`,
    releaseSource: null,
    episodes: [{ episodeId: i, label: `S01E0${i + 1}` }],
    grabbedEpisodeIds: [i],
  })),
  heldBack: [],
  noRecord: [],
  deletes: [],
  refused: [],
  searchEpisodeIds: [],
  wholeSeason: false,
  actionable,
  digest: 'season',
});

describe('step order (each remedy switches its own step)', () => {
  it('starts with the episode picker, the season list, or the reason', () => {
    expect(firstGuideStep({ isTv: true, hasTarget: false, isSeason: false, remedies: ON })).toBe('pick');
    expect(firstGuideStep({ isTv: true, hasTarget: true, isSeason: true, remedies: ON })).toBe('episodes');
    expect(firstGuideStep({ isTv: true, hasTarget: true, isSeason: true, remedies: { ...ON, season_guard: false } })).toBe(
      'reason',
    );
    expect(firstGuideStep({ isTv: false, hasTarget: false, isSeason: false, remedies: ON })).toBe('reason');
  });

  it("Won't play reads the play, Wrong language the audio, only while their remedy is on", () => {
    expect(stepAfterReason('wont_play_corrupt', ON)).toBe('playback');
    expect(stepAfterReason('wrong_language', ON)).toBe('language');
    expect(stepAfterReason('wont_play_corrupt', { ...ON, playback_triage: false })).toBe('preview');
    expect(stepAfterReason('wrong_language', { ...ON, language_check: false })).toBe('preview');
    expect(stepAfterReason('wrong_content', ON)).toBe('preview');
  });

  it('subtitles never preview, and with no planning remedy the classic confirm follows', () => {
    expect(stepAfterTriage('missing_subtitles', ON)).toBe('confirm');
    expect(stepAfterTriage('wont_play_corrupt', { ...OFF, playback_triage: true })).toBe('confirm');
    expect(stepAfterTriage('wont_play_corrupt', { ...OFF, season_guard: true })).toBe('preview');
  });
});

describe('the Episode Re-map in the step order (DESIGN-055 D-04, PLAN-077 P4)', () => {
  it('a Title Check flag opens the re-map first, only for a TV episode', () => {
    expect(firstGuideStep({ isTv: true, hasTarget: true, isSeason: false, remedies: ON, remapStart: true })).toBe('remap');
    expect(firstGuideStep({ isTv: true, hasTarget: false, isSeason: false, remedies: ON, remapStart: true })).toBe('pick');
    expect(firstGuideStep({ isTv: false, hasTarget: false, isSeason: false, remedies: ON, remapStart: true })).toBe('reason');
    expect(firstGuideStep({ isTv: true, hasTarget: true, isSeason: false, remedies: OFF, remapStart: false })).toBe('reason');
  });

  it('puts the single move on "What\'s wrong?" and the shift on the season\'s first question', () => {
    expect(remapChoiceOn('reason', 'single', ON)).toBe(true);
    expect(remapChoiceOn('episodes', 'single', ON)).toBe(false);
    // With the season guard on, the shift sits beside "Which episodes are wrong?"; with it off, on "What's wrong?".
    expect(remapChoiceOn('episodes', 'shift', ON)).toBe(true);
    expect(remapChoiceOn('reason', 'shift', ON)).toBe(false);
    expect(remapChoiceOn('reason', 'shift', OFF)).toBe(true);
    expect(remapChoiceOn('episodes', 'shift', OFF)).toBe(false);
    expect(remapChoiceOn('reason', null, ON)).toBe(false);
  });

  it('the re-map choice leads to the re-map step; a reason keeps its own next step', () => {
    expect(stepAfterChoice('remap', ON)).toBe('remap');
    expect(stepAfterChoice('remap', OFF)).toBe('remap');
    expect(stepAfterChoice('wrong_content', ON)).toBe('preview');
    expect(stepAfterChoice('wont_play_corrupt', ON)).toBe('playback');
    expect(stepAfterChoice('missing_subtitles', ON)).toBe('confirm');
  });
});

describe('the language check mirror (D-08 rule 3)', () => {
  it('present only when every file carries it and every file could be read', () => {
    expect(wantedLanguageInFile([{ codes: ['por', 'eng'] }], 'eng')).toBe(true);
    expect(wantedLanguageInFile([{ codes: ['por', 'eng'] }, { codes: ['por'] }], 'eng')).toBe(false);
    expect(wantedLanguageInFile([{ codes: ['eng'] }, { codes: [] }], 'eng')).toBe(false);
    expect(wantedLanguageInFile([], 'eng')).toBe(false);
  });
});

describe('the preview: refusals, gone lines and the confirm', () => {
  it('Case C: the Same Release is a refusal (no confirm); so is nothing to replace it', () => {
    expect(refusalFor(deletePlan('same_release'), ON)).toBe('same_release');
    expect(refusalFor(deletePlan('no_replacement'), ON)).toBe('no_replacement');
    expect(refusalFor(deletePlan('ok'), ON)).toBeNull();
    // With the remedy off the delete is today's (the verdict is unchecked anyway).
    expect(refusalFor(deletePlan('same_release'), { ...ON, replacement_preview: false })).toBeNull();
    expect(refusalFor(seasonPlan(0, false), ON)).toBe('nothing_safe');
  });

  it('every destructive line must be ticked: the file (with its size), each blocked release, the pack', () => {
    const del = goneLinesFor(deletePlan('ok'));
    expect(del).toEqual([
      {
        key: 'delete:1507',
        text: 'GoodFellas (1990) [Remux-2160p]-FRAMESTOR.mkv (82 GB) is deleted for good. There is no recycle bin.',
      },
    ]);
    expect(goneLinesFor(deletePlan('ok', false))).toEqual([]); // nothing on disk, nothing gone
    expect(goneLinesFor(blocklistPlan(2)).map((l) => l.key)).toEqual(['block:801', 'pack:801']);
    expect(goneLinesFor(blocklistPlan(1))[1]!.text).toMatch(/the 1 other episode it holds too/);
    expect(goneLinesFor(seasonPlan(2)).map((l) => l.key)).toEqual(['block:900', 'block:901']);
    expect(goneLinesFor(null)).toEqual([]);
  });

  it('the confirm names the action', () => {
    expect(confirmLabelFor(deletePlan('ok'))).toBe('Delete it and search again');
    expect(confirmLabelFor(deletePlan('ok', false))).toBe('Search again');
    expect(confirmLabelFor(blocklistPlan(0))).toBe('Block it and search again');
    expect(confirmLabelFor(seasonPlan(3))).toBe('Block 3 downloads and search again');
    expect(confirmLabelFor(null)).toBe('Submit fix');
  });

  it('the confirm sends the digest and the choices the plan was built on', () => {
    expect(confirmFieldsFor(blocklistPlan(2), undefined)).toEqual({ blockWholePack: true, planDigest: 'def456def456' });
    const replaceOnly = deletePlan('ok');
    if (replaceOnly.kind === 'delete') replaceOnly.insteadOfPack = true;
    expect(confirmFieldsFor(replaceOnly, undefined)).toEqual({
      replaceFile: true,
      planDigest: 'abc123abc123',
    });
    expect(confirmFieldsFor(seasonPlan(1), [3, 1])).toEqual({ episodeIds: [3, 1], planDigest: 'season' });
  });
});

describe("Won't play triage helpers", () => {
  it('offers servers with no known issue first, and names them', () => {
    const play = [
      { serverSlug: 'haynesops', url: 'a' },
      { serverSlug: 'hayneskube', url: 'b' },
    ];
    expect(orderPlayTargets(play, ['haynesops']).map((p) => p.url)).toEqual(['b', 'a']);
    expect(joinServerNames(['haynesops', 'x'], { haynesops: 'HaynesOps' })).toBe('HaynesOps and x');
  });
});

describe('copy rules', () => {
  it('no em-dashes in the guide wording', () => {
    const copy = [
      ...Object.values(GUIDE_REASON_LABELS),
      ...goneLinesFor(blocklistPlan(2)).map((l) => l.text),
      ...goneLinesFor(deletePlan('ok')).map((l) => l.text),
      confirmLabelFor(seasonPlan(2)),
    ];
    for (const text of copy) expect(text).not.toContain('—');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ADR-109 C-07 / DESIGN-055 D-08 (PLAN-077 P6) — the language-aware Wrong language
// ---------------------------------------------------------------------------------------------------------------------

describe('Wrong language, language-aware (DESIGN-055 D-08, PLAN-077 P6)', () => {
  const P6: GuideRemedies = { ...ON, audio_preference: true, language_search: true };
  const lostTapesE12 = [{ label: 'S01E12 · Secret Menu Item', codes: ['por', 'eng'] }];
  const season = [
    { label: 'S01E05 · Gumball Machine', codes: ['por'] },
    { label: 'S01E06 · Boba or Bo-Bust', codes: ['eng'] },
    { label: 'S01E12 · Secret Menu Item', codes: ['por', 'eng'] },
  ];

  it('a file that has the language goes to the track advice, whatever else is on', () => {
    expect(stepAfterLanguage({ files: lostTapesE12, wanted: 'eng', isSeason: false, remedies: P6 })).toBe('language-present');
    expect(stepAfterLanguage({ files: lostTapesE12, wanted: 'eng', isSeason: false, remedies: ON })).toBe('language-present');
  });

  it('a file without it previews the Language Replace when it is on, else the Fix as before', () => {
    const portugueseOnly = [{ label: 'S01E05', codes: ['por'] }];
    expect(stepAfterLanguage({ files: portugueseOnly, wanted: 'eng', isSeason: false, remedies: P6 })).toBe('preview');
    expect(languagePlans('wrong_language', P6)).toBe(true);
    expect(languagePlans('wrong_language', ON)).toBe(false);
    // Language Replace on but no planning remedy: still a preview (the replace is shown before anything is removed).
    expect(stepAfterTriage('wrong_language', { ...OFF, language_check: true, language_search: true })).toBe('preview');
    expect(stepAfterLanguage({ files: portugueseOnly, wanted: 'eng', isSeason: false, remedies: OFF })).toBe('confirm');
  });

  it('a season whose files lack it lists those episodes, to be fixed one at a time', () => {
    expect(stepAfterLanguage({ files: season, wanted: 'eng', isSeason: true, remedies: P6 })).toBe('language-episodes');
    expect(filesLacking(season, 'eng')).toEqual(['S01E05 · Gumball Machine']);
    // A file whose audio could not be read is not listed as lacking.
    expect(filesLacking([{ label: 'S01E07', codes: [] }], 'eng')).toEqual([]);
  });

  it('names the track as Plex does, its place, and the track that plays first instead', () => {
    const tracks = [
      { position: 1, languageCode: 'por', displayTitle: 'Português (EAC3 5.1)', isDefault: true },
      { position: 2, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)', isDefault: false },
    ];
    expect(trackAdvice(tracks, 'eng')).toEqual({ pick: 'English (EAC3 5.1)', position: 2, total: 2, playsFirst: 'Português (EAC3 5.1)' });
    // Butterbean's Cafe: 16 tracks, Bulgarian flagged; Plex's terminology codes fold (deu → ger).
    const many = [
      { position: 1, languageCode: 'bul', displayTitle: 'български (AAC Stereo)', isDefault: true },
      ...Array.from({ length: 14 }, (_, i) => ({ position: i + 2, languageCode: 'deu', displayTitle: `Deutsch ${i}`, isDefault: false })),
      { position: 16, languageCode: 'eng', displayTitle: 'English (AAC Stereo)', isDefault: false },
    ];
    expect(trackAdvice(many, 'eng')).toMatchObject({ position: 16, total: 16, playsFirst: 'български (AAC Stereo)' });
    expect(trackAdvice(many, 'ger')?.pick).toBe('Deutsch 0');
    // Already first: nothing else plays first.
    expect(trackAdvice([{ position: 1, languageCode: 'eng', displayTitle: 'English', isDefault: false }], 'eng')?.playsFirst).toBeNull();
    expect(trackAdvice(tracks, 'jpn')).toBeNull();
    expect([1, 2, 3, 4, 11, 12, 13, 16, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '16th', '21st', '22nd']);
  });

  const languagePlan = (verdict: 'ok' | 'no_language_release', grab = true): GuidePlan => ({
    kind: 'language',
    scope: 'episode',
    targetLabel: 'S01E05 · Gumball Machine',
    wanted: { code: 'eng', name: 'English' },
    file: { fileId: 75705, name: 'S01E05.mkv', releaseGroup: 'PTGroup', qualityName: 'WEBDL-1080p', size: 420_000_000 },
    grab: grab ? { grabId: 501, sourceTitle: 'Regular.Show.The.Lost.Tapes.S01E05.DUBLADO-PTGroup', releaseSource: 'Rss' } : null,
    packKept: [],
    redownloadKept: false,
    candidate:
      verdict === 'ok'
        ? {
            title: 'Regular.Show.The.Lost.Tapes.S01E05.1080p.AMZN.WEB-DL-Kitsune',
            releaseGroup: 'Kitsune',
            qualityName: 'WEBDL-1080p',
            size: 400_000_000,
            protocol: 'usenet',
            indexer: 'NZBgeek',
            customFormatScore: 1780,
            fullSeason: false,
            languages: ['English'],
          }
        : null,
    candidateKey: verdict === 'ok' ? '0123456789abcdef' : null,
    verdict,
    languageReleases: verdict === 'ok' ? 3 : 0,
    digest: 'aaa111bbb222',
  });

  it('the Language Replace: block and delete lines to tick, its own confirm, and the refusal with nothing to take', () => {
    const ok = languagePlan('ok');
    expect(goneLinesFor(ok).map((l) => l.key)).toEqual(['block:501', 'delete:75705']);
    expect(goneLinesFor(languagePlan('ok', false)).map((l) => l.key)).toEqual(['delete:75705']);
    expect(refusalFor(ok, P6)).toBeNull();
    expect(confirmLabelFor(ok)).toBe('Replace it with the English release');
    expect(confirmFieldsFor(ok, undefined)).toEqual({ planDigest: 'aaa111bbb222' });
    const none = languagePlan('no_language_release');
    expect(refusalFor(none, P6)).toBe('no_language_release');
    expect(goneLinesFor(none)).toEqual([]);
  });
});
