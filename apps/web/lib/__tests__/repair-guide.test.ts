// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide's pure rules (lib/repair-guide.ts): the
// step order each remedy switches, the "gone afterwards" lines (never pre-ticked: the component starts with none
// acknowledged), the refusals that end the guide without a confirm, and the confirm wording and fields.
import { describe, expect, it } from 'vitest';
import {
  GUIDE_REASON_LABELS,
  confirmFieldsFor,
  confirmLabelFor,
  firstGuideStep,
  goneLinesFor,
  joinServerNames,
  orderPlayTargets,
  refusalFor,
  stepAfterReason,
  stepAfterTriage,
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
