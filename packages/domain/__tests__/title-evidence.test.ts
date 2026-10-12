import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TITLE_AGREE_MIN,
  TITLE_DISAGREE_MARGIN,
  TITLE_EVIDENCE_VERSION,
  episodeTitleEvidence,
  movieTitleEvidence,
  normalizeTokens,
  parseReleaseName,
  seriesYearConflict,
  titleSimilarity,
  type TitleEvidenceEpisode,
} from '../src/title-evidence';

// ADR-110 / DESIGN-055 D-05 (PLAN-077 P2): Title Evidence, pure. The names are DESIGN-055's motivating cases (A, B and
// issue #597), the live Sonarr queue and grab history, and Sonarr's interactive search for Regular Show: The Lost Tapes.

// Sonarr `GET /api/v3/episode?seriesId=` season lists, read live 2026-10-12 (titles verbatim).
const SEASONS = JSON.parse(
  readFileSync(new URL('./fixtures/title-evidence-seasons.json', import.meta.url), 'utf8'),
) as Record<string, { seriesId: number; season: number; episodes: TitleEvidenceEpisode[] }>;

function season(key: string): TitleEvidenceEpisode[] {
  const s = SEASONS[key];
  if (!s) throw new Error(`fixture has no ${key}`);
  return s.episodes;
}

const PAPER_S2 = season('The Paper (2025) S2');
const LOST_TAPES_S1 = season('Regular Show: The Lost Tapes S1');
const PENGUINS_S1 = season('The Penguins of Madagascar S1');
const TOTS_S1 = season('Tiny Ones Transport Service S1');
const BUTTERBEANS_S1 = season("Butterbean's Cafe S1");
const RUGRATS_S1 = season('Rugrats S1');
const AQUA_TEEN_S5 = season('Aqua Teen Hunger Force S5');
const PEPPA_S9 = season('Peppa Pig S9');
const FRANKLIN_S1 = season('Franklin S1');

const CASE_A =
  'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX.mkv';
const CASE_B =
  'The_Paper_2025_S02E06_125_Years_Young_2160p_PCOK_WEB-DL_DDP5_1_Atmos_DV_HDR_H_265-FLUX.mkv';
const PENGUINS_ES =
  'Los.Pinguinos.de.Madagascar.S01E24.Cuajito.Estrellas.de.Television.MULTI.1080p.WEB-DL.AAC2.0.x264-AndreMor.mkv';
const RUGRATS_2021 =
  'Rugrats.2021.S01E07.No.License.to.Drive.and.I.Dream.of.Duffy.1080p.SKST.WEB-DL.DD+2.0.H.264-playWEB';
const FRANKLIN_2025 = 'Franklin.2025.S01E05.2160p.NF.WEB-DL.MULTi.DDP5.1.H.265-FUZEER';

describe('constants', () => {
  it('pins the rule version and the Q-06 starting thresholds', () => {
    expect(TITLE_EVIDENCE_VERSION).toBe(1);
    expect(TITLE_AGREE_MIN).toBe(0.8);
    expect(TITLE_DISAGREE_MARGIN).toBe(0.3);
  });
});

describe('normalizeTokens', () => {
  it('folds accents', () => {
    expect(normalizeTokens('Los Pingüinos de Madagascar')).toEqual([
      'los',
      'pinguinos',
      'de',
      'madagascar',
    ]);
    expect(normalizeTokens('Gün')).toEqual(['gun']);
    expect(normalizeTokens('No Way, Soufflé!')).toEqual(['no', 'way', 'souffle']);
  });

  it('drops apostrophes and right single quotes inside and at the end of a word', () => {
    expect(normalizeTokens("Poppy's Cooking Class!")).toEqual(['poppys', 'cooking', 'class']);
    expect(normalizeTokens('Poppy’s Cooking Class!')).toEqual(['poppys', 'cooking', 'class']);
    expect(normalizeTokens("Skips' Luau")).toEqual(['skips', 'luau']);
    expect(normalizeTokens('Granny Sheep’s Art Van')).toEqual(['granny', 'sheeps', 'art', 'van']);
  });

  it('reads & as and, also double-escaped by an indexer', () => {
    expect(normalizeTokens('Life & Death of Robot Dog')).toEqual([
      'life',
      'and',
      'death',
      'of',
      'robot',
      'dog',
    ]);
    expect(normalizeTokens('Fix.That.Tape.&amp;amp;.Skips.Luau')).toEqual([
      'fix',
      'that',
      'tape',
      'and',
      'skips',
      'luau',
    ]);
  });

  it('splits on every other separator and keeps numbers as tokens', () => {
    expect(normalizeTokens('The_Paper [2025] (S02E06): 125-Years/Young!?+')).toEqual([
      'the',
      'paper',
      '2025',
      's02e06',
      '125',
      'years',
      'young',
    ]);
  });

  it('reads 2½ as 2 1 2 and a thousands comma as one number, the way release names write them', () => {
    expect(normalizeTokens('The Naked Gun 2½: The Smell of Fear')).toEqual(
      normalizeTokens('The.Naked.Gun.2.1.2.The.Smell.of.Fear'),
    );
    expect(normalizeTokens('12,000 Seconds')).toEqual(['12000', 'seconds']);
    expect(normalizeTokens('one, 2, 3')).toEqual(['one', '2', '3']);
  });
});

describe('parseReleaseName', () => {
  it('Case B: an underscored name; the 125 is a title word, never an episode', () => {
    expect(parseReleaseName(CASE_B)).toEqual({
      seriesTokens: ['the', 'paper', '2025'],
      year: 2025,
      season: 2,
      episodes: [6],
      titleTokens: ['125', 'years', 'young'],
    });
  });

  it('reads the title up to the first stop token', () => {
    const p = parseReleaseName(CASE_A);
    expect(p).toMatchObject({
      season: 1,
      episodes: [10],
      year: null,
      titleTokens: ['spice', 'it', 'up'],
    });
    expect(p.seriesTokens).toEqual(['regular', 'show', 'the', 'lost', 'tapes']);
  });

  it('a dotted series name does not hide the episode token (T.O.T.S.)', () => {
    expect(
      parseReleaseName('T.O.T.S.S01E03.Panda.Excess.1080p.DSNP.WEB-DL.DDP5.1.H.264-LAZY.mkv'),
    ).toEqual({
      seriesTokens: ['t', 'o', 't', 's'],
      year: null,
      season: 1,
      episodes: [3],
      titleTokens: ['panda', 'excess'],
    });
  });

  it('reads every episode of a multi-episode name, as Sonarr does', () => {
    expect(
      parseReleaseName(
        'Butterbeans.Caf.S01E55E56.Poppys.Cooking.Class.A.Fairy.Peachy.Day.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor',
      ).episodes,
    ).toEqual([55, 56]);
    expect(
      parseReleaseName('Butterbeans.Caf.S01E55-E56.Poppys.Cooking.Class.1080p').episodes,
    ).toEqual([55, 56]);
    expect(parseReleaseName('Show.S01E01-E03.1080p.WEB-DL').episodes).toEqual([1, 2, 3]);
    // Live, Sonarr interactive search 2026-10-12: a season range written with the season twice.
    const range = parseReleaseName(
      'Regular.Show.The.Lost.Tapes.S01E01-S01E09.1080p.MAX.WEB-DL.DDP2.0.H.265-OldT',
    );
    expect(range).toMatchObject({
      season: 1,
      episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      titleTokens: [],
    });
  });

  it('reads the NxNN form', () => {
    expect(parseReleaseName('Show.1x02.Some.Title.720p')).toMatchObject({
      seriesTokens: ['show'],
      season: 1,
      episodes: [2],
      titleTokens: ['some', 'title'],
    });
  });

  it('takes the base name of a path and strips a video extension', () => {
    const expected = { season: 1, episodes: [2], titleTokens: ['some', 'title'] };
    expect(
      parseReleaseName(
        '/downloads/complete/Show.S01E02.Some.Title.720p.WEB/Show.S01E02.Some.Title.720p.WEB.mkv',
      ),
    ).toMatchObject(expected);
    expect(parseReleaseName('C:\\tv\\Show\\Show - S01E02 - Some Title.mp4')).toMatchObject(
      expected,
    );
    expect(parseReleaseName('Show.S01E02.Some.Title.M2TS')).toMatchObject({
      titleTokens: ['some', 'title'],
    });
  });

  it('keeps ordinary words that look like release tags inside a title', () => {
    // Real titles: Franklin S01E10, Penguins S01E10, a live Anthony Bourdain grab.
    expect(
      parseReleaseName('Franklin.S01E10.Franklin.and.the.Red.Scooter.720p.WEB').titleTokens,
    ).toEqual(['franklin', 'and', 'the', 'red', 'scooter']);
    expect(
      parseReleaseName('The.Penguins.of.Madagascar.S01E10.Tangled.in.the.Web.1080p.WEB-DL')
        .titleTokens,
    ).toEqual(['tangled', 'in', 'the', 'web']);
    expect(
      parseReleaseName(
        'Anthony.Bourdain.Parts.Unknown.2013.S10E02.French.Alps.1080p.HMAX.WEB-DL.DDP2.0.H.264-FUZEER',
      ).titleTokens,
    ).toEqual(['french', 'alps']);
    expect(
      parseReleaseName('Show.S01E01.Max.Stan.It.Now.Complete.Extended.Uncut.Spa.1080p.WEB-DL')
        .titleTokens,
    ).toEqual(['max', 'stan', 'it', 'now', 'complete', 'extended', 'uncut', 'spa']);
    expect(parseReleaseName('Show.S01E01.Plan.H.1080p.x264').titleTokens).toEqual(['plan', 'h']);
  });

  it('stops at a tag word where it reads as a tag', () => {
    expect(parseReleaseName('Show.S01E01.Some.Title.WEB.H264-GRP').titleTokens).toEqual([
      'some',
      'title',
    ]);
    expect(parseReleaseName('Show.S01E01.Some.Title.PROPER.1080p.WEB').titleTokens).toEqual([
      'some',
      'title',
    ]);
    expect(parseReleaseName('Show.S01E01.Some.Title.iNTERNAL.WEB.H264-GRP').titleTokens).toEqual([
      'some',
      'title',
    ]);
    expect(parseReleaseName('Show.S01E01.Some.Title.FRENCH.720p.HDTV').titleTokens).toEqual([
      'some',
      'title',
    ]);
    expect(parseReleaseName('Show.S01E01.Some.Title.H.265-GRP').titleTokens).toEqual([
      'some',
      'title',
    ]);
    // Live grabs: German DL (dual language) before the resolution, and an uploader that writes WEB.DL twice.
    expect(
      parseReleaseName('Kill.Jackie.S01E04.German.DL.HDR.2160p.WEB.h265-W4K').titleTokens,
    ).toEqual([]);
    expect(
      parseReleaseName(
        'Aqua.Teen.Hunger.Force.S05E05.Hoppy.Bunny.NorTV.WEB.DL.WEB.DL.1080p.WEB-DL.AAC.x264',
      ).titleTokens,
    ).toEqual(['hoppy', 'bunny']);
    expect(
      parseReleaseName('A.Woman.of.Substance.S01E03.Episode.3.1080p.Blu-ray.Remux.AVC-HD')
        .titleTokens,
    ).toEqual(['episode', '3']);
  });

  it('a name without an episode token is a movie', () => {
    expect(parseReleaseName('Blade.Runner.2049.2017.1080p.BluRay')).toEqual({
      seriesTokens: [],
      year: 2017,
      season: null,
      episodes: [],
      titleTokens: ['blade', 'runner', '2049'],
    });
    expect(parseReleaseName('2001.A.Space.Odyssey.1968.1080p.BluRay.x264')).toMatchObject({
      year: 1968,
      titleTokens: ['2001', 'a', 'space', 'odyssey'],
    });
    expect(parseReleaseName('2012.1080p.BluRay')).toMatchObject({
      year: null,
      titleTokens: ['2012'],
    });
    expect(parseReleaseName('The.French.Connection.1080p.BluRay')).toMatchObject({
      year: null,
      titleTokens: ['the', 'french', 'connection'],
    });
  });
});

describe('titleSimilarity', () => {
  it('is the Dice coefficient on token sets', () => {
    expect(titleSimilarity(['spice', 'it', 'up'], ['spice', 'it', 'up'])).toBe(1);
    expect(titleSimilarity(['a', 'b'], ['a', 'c'])).toBe(0.5);
    expect(titleSimilarity(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
    expect(
      titleSimilarity(['fix', 'that', 'tape', 'and', 'skips', 'luau'], ['fix', 'that', 'tape']),
    ).toBeCloseTo(2 / 3);
  });

  it('is 0 when either side is empty', () => {
    expect(titleSimilarity([], ['a'])).toBe(0);
    expect(titleSimilarity(['a'], [])).toBe(0);
    expect(titleSimilarity([], [])).toBe(0);
  });
});

describe('episodeTitleEvidence: DESIGN-055 cases', () => {
  it('Case B: The Paper S02E06 "125 Years Young" agrees with 2x06', () => {
    const ev = episodeTitleEvidence({ name: CASE_B, episodes: PAPER_S2 });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      titleTokens: ['125', 'years', 'young'],
      againstEpisodeIds: [85215],
      againstScore: 1,
      bestEpisodeId: 85215,
      bestScore: 1,
    });
    expect(seriesYearConflict({ name: CASE_B, seriesYear: 2025 })).toBeNull();
  });

  it('Case A: S01E10 "Spice It Up" disagrees with E10 "Stilt Walkers"; E11 is the match', () => {
    expect(episodeTitleEvidence({ name: CASE_A, episodes: LOST_TAPES_S1 })).toEqual({
      verdict: 'disagrees',
      titleTokens: ['spice', 'it', 'up'],
      againstEpisodeIds: [118406],
      againstScore: 0,
      bestEpisodeId: 118407,
      bestScore: 1,
    });
  });

  it('Case A, the Release Pick: the same name agrees with the episode the person chose', () => {
    const ev = episodeTitleEvidence({
      name: CASE_A,
      episodes: LOST_TAPES_S1,
      againstEpisodeIds: [118407],
    });
    expect(ev).toMatchObject({ verdict: 'agrees', againstEpisodeIds: [118407], againstScore: 1 });
  });

  it('Case A: a BiOMA name carries no title and is silent', () => {
    expect(
      episodeTitleEvidence({
        name: 'Regular.Show.The.Lost.Tapes.S01E12.1080p.AMZN.WEB-DL.DDP5.1.H.264-BiOMA.mkv',
        episodes: LOST_TAPES_S1,
      }),
    ).toEqual({
      verdict: 'silent',
      titleTokens: [],
      againstEpisodeIds: [118408],
      againstScore: null,
      bestEpisodeId: null,
      bestScore: null,
    });
  });

  it("Case A, live search: S01E13 named with E14's title disagrees; the hyphen-less BoBust still agrees with E06", () => {
    const smoke = episodeTitleEvidence({
      name: 'Regular.Show.The.Lost.Tapes.S01E13.Smoke.Alarm.on.the.Water.1080p.HMAX.WEB-DL.DDP2.0.H.265-AKARi',
      episodes: LOST_TAPES_S1,
    });
    expect(smoke).toMatchObject({
      verdict: 'disagrees',
      againstEpisodeIds: [118409],
      bestEpisodeId: 118410,
      bestScore: 1,
    });
    const boba = episodeTitleEvidence({
      name: 'Regular.Show.The.Lost.Tapes.S01E06.Boba.or.BoBust.MULTI.720p.HMAX.WEB-DL.DDP5.1.x264-AndreMor',
      episodes: LOST_TAPES_S1,
    });
    expect(boba).toMatchObject({ verdict: 'agrees', bestEpisodeId: 118402, againstScore: 1 });
  });

  it('issue #597: the Spanish Penguins title is ambiguous against 1x24, never agrees', () => {
    const ev = episodeTitleEvidence({ name: PENGUINS_ES, episodes: PENGUINS_S1 });
    expect(ev.verdict).toBe('ambiguous');
    expect(ev.againstEpisodeIds).toEqual([85297]);
    expect(ev.titleTokens).toEqual(['cuajito', 'estrellas', 'de', 'television']);
    const accented = PENGUINS_ES.replace('Pinguinos', 'Pingüinos');
    expect(parseReleaseName(accented)).toEqual(parseReleaseName(PENGUINS_ES));
    expect(episodeTitleEvidence({ name: accented, episodes: PENGUINS_S1 })).toEqual(ev);
  });

  it('issue #597: T.O.T.S. S01E03 agrees with "Panda Excess"', () => {
    const ev = episodeTitleEvidence({
      name: 'T.O.T.S.S01E03.Panda.Excess.1080p.DSNP.WEB-DL.DDP5.1.H.264-LAZY.mkv',
      episodes: TOTS_S1,
    });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [68385],
      bestEpisodeId: 68385,
      againstScore: 1,
    });
  });
});

describe('episodeTitleEvidence: multi-episode files', () => {
  const E55E56 =
    'Butterbeans.Caf.S01E55E56.Poppys.Cooking.Class.A.Fairy.Peachy.Day.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor';

  it('Butterbeans S01E55E56 agrees with the concatenated titles of E55 and E56', () => {
    const ev = episodeTitleEvidence({ name: E55E56, episodes: BUTTERBEANS_S1 });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [12829, 12830],
      againstScore: 1,
    });
    expect(parseReleaseName(E55E56).episodes).toEqual([55, 56]);
  });

  it('judged through one of its episodes (one Sonarr history row per episode), it is judged against both', () => {
    const ev = episodeTitleEvidence({
      name: E55E56,
      episodes: BUTTERBEANS_S1,
      againstEpisodeIds: [12830],
    });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [12829, 12830],
      againstScore: 1,
    });
    // Live grab: E16E17 judged through E17 used to read as "E16 disagrees".
    const e17 = episodeTitleEvidence({
      name: 'Butterbeans.Caf.S01E16E17.The.Starlight.Cupcake.Surprise.Summer.Slushies.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor',
      episodes: BUTTERBEANS_S1,
      againstEpisodeIds: [12791],
    });
    expect(e17).toMatchObject({ verdict: 'agrees', againstEpisodeIds: [12790, 12791] });
  });

  it('the hyphen form S01E55-E56 is the same file', () => {
    const ev = episodeTitleEvidence({
      name: 'Butterbeans.Cafe.S01E55-E56.Poppys.Cooking.Class.A.Fairy.Peachy.Day.1080p.SKST.WEB-DL.MULTI.AAC.2.0.H.264-OldT',
      episodes: BUTTERBEANS_S1,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', againstEpisodeIds: [12829, 12830] });
  });

  it('Butterbeans S01E62 agrees with "The Fairy Bean Adventure!" (live title)', () => {
    const ev = episodeTitleEvidence({
      name: 'Butterbeans.Caf.S01E62.The.Fairy.Bean.Adventure.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor',
      episodes: BUTTERBEANS_S1,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', againstEpisodeIds: [12836], againstScore: 1 });
  });

  it('an uploader that drops accented letters still agrees (No.Way.Souffl, Caf.Ballet)', () => {
    const souffle = episodeTitleEvidence({
      name: 'Butterbeans.Caf.S01E60E61.No.Way.Souffl.Cinnamon.the.Elephant.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor',
      episodes: BUTTERBEANS_S1,
    });
    expect(souffle).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [12834, 12835],
      againstScore: 1,
    });
    const ballet = episodeTitleEvidence({
      name: 'Butterbeans.Caf.S01E31E32.Caf.Ballet.Cricket.Goes.Camping.MULTI.1080p.SKST.WEB-DL.AAC2.0.x264-AndreMor',
      episodes: BUTTERBEANS_S1,
    });
    expect(ballet).toMatchObject({ verdict: 'agrees', againstScore: 1 });
  });

  it('a shortened two-episode title scores below the agree line and stays ambiguous (Q-06 census material)', () => {
    const ev = episodeTitleEvidence({
      name: 'Regular.Show.The.Lost.Tapes.S01E13E14.Terror.Tales.of.the.Park.VII.1080p.HDTV.DD5.1.x264-Slurpuff',
      episodes: LOST_TAPES_S1,
    });
    expect(ev.verdict).toBe('ambiguous');
    expect(ev.againstEpisodeIds).toEqual([118409, 118410]);
    expect(ev.bestEpisodeId).toBe(118409);
  });
});

describe('episodeTitleEvidence: other live series', () => {
  it('A Woman of Substance: "Episode 3" agrees with a title "Episode 3"', () => {
    const episodes: TitleEvidenceEpisode[] = [1, 2, 3, 4].map((n) => ({
      id: 9000 + n,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Episode ${n}`,
    }));
    const ev = episodeTitleEvidence({
      name: 'A.Woman.of.Substance.S01E03.Episode.3.1080p.Blu-ray.Remux.AVC-HD',
      episodes,
    });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [9003],
      bestEpisodeId: 9003,
      againstScore: 1,
    });
  });

  it('Rugrats: a 2021 release grabbed for the 1991 series is ambiguous and its year conflicts', () => {
    const ev = episodeTitleEvidence({ name: RUGRATS_2021, episodes: RUGRATS_S1 });
    expect(ev.verdict).toBe('ambiguous');
    expect(ev.againstEpisodeIds).toEqual([53626]);
    expect(ev.againstScore).toBe(0);
    expect(seriesYearConflict({ name: RUGRATS_2021, seriesYear: 1991 })).toBe(2021);
  });

  it('Franklin: a 2025 release grabbed for the 1997 series is silent and its year conflicts', () => {
    expect(episodeTitleEvidence({ name: FRANKLIN_2025, episodes: FRANKLIN_S1 })).toMatchObject({
      verdict: 'silent',
      againstEpisodeIds: [23623],
      bestEpisodeId: null,
    });
    expect(seriesYearConflict({ name: FRANKLIN_2025, seriesYear: 1997 })).toBe(2025);
  });

  it('Franklin: one half of a two-part TVDB title agrees', () => {
    const ev = episodeTitleEvidence({
      name: 'Franklin.S01E05.Franklin.Rides.a.Bike.720p.WEB',
      episodes: FRANKLIN_S1,
    });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      againstEpisodeIds: [23623],
      againstScore: 1,
      bestEpisodeId: 23623,
    });
  });

  it('Aqua Teen Hunger Force: the in-title NorTV tag does not cost the match', () => {
    const ev = episodeTitleEvidence({
      name: 'Aqua.Teen.Hunger.Force.S05E05.Hoppy.Bunny.NorTV.WEB.DL.WEB.DL.1080p.WEB-DL.AAC.x264',
      episodes: AQUA_TEEN_S5,
    });
    expect(ev).toMatchObject({
      verdict: 'agrees',
      titleTokens: ['hoppy', 'bunny'],
      againstEpisodeIds: [4867],
    });
  });

  it('Peppa Pig: a TVDB right single quote matches a release that drops it', () => {
    const ev = episodeTitleEvidence({
      name: 'Peppa.Pig.S09E08.Granny.Sheeps.Art.Van.1080p.WEB-DL',
      episodes: PEPPA_S9,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', againstEpisodeIds: [48138], againstScore: 1 });
  });
});

describe('episodeTitleEvidence: rules', () => {
  it('a TBA (or empty) title on the mapped episode is silent: nothing to compare', () => {
    const episodes: TitleEvidenceEpisode[] = [
      { id: 1, seasonNumber: 1, episodeNumber: 1, title: 'Spice It Up' },
      { id: 2, seasonNumber: 1, episodeNumber: 2, title: 'TBA' },
      { id: 3, seasonNumber: 1, episodeNumber: 3, title: null },
    ];
    for (const [name, id] of [
      ['Show.S01E02.Spice.It.Up.1080p.WEB-DL', 2],
      ['Show.S01E03.Spice.It.Up.1080p.WEB-DL', 3],
    ] as const) {
      expect(episodeTitleEvidence({ name, episodes })).toEqual({
        verdict: 'silent',
        titleTokens: ['spice', 'it', 'up'],
        againstEpisodeIds: [id],
        againstScore: null,
        bestEpisodeId: null,
        bestScore: null,
      });
    }
    const tbd = episodeTitleEvidence({
      name: 'Show.S01E02.Spice.It.Up.1080p',
      episodes,
      againstEpisodeIds: [2],
    });
    expect(tbd.verdict).toBe('silent');
  });

  it("a mapping that resolves to no episode is judged against the name's season: disagrees or ambiguous only", () => {
    const ev = episodeTitleEvidence({
      name: CASE_A,
      episodes: LOST_TAPES_S1,
      againstEpisodeIds: [999999],
    });
    expect(ev).toMatchObject({
      verdict: 'disagrees',
      againstEpisodeIds: [],
      againstScore: null,
      bestEpisodeId: 118407,
    });
    const gone = episodeTitleEvidence({
      name: 'Regular.Show.The.Lost.Tapes.S01E99.Spice.It.Up.1080p',
      episodes: LOST_TAPES_S1,
    });
    expect(gone).toMatchObject({
      verdict: 'disagrees',
      againstEpisodeIds: [],
      bestEpisodeId: 118407,
    });
    const nothing = episodeTitleEvidence({
      name: PENGUINS_ES,
      episodes: PENGUINS_S1,
      againstEpisodeIds: [],
    });
    expect(nothing).toMatchObject({
      verdict: 'ambiguous',
      againstEpisodeIds: [],
      bestEpisodeId: null,
      bestScore: null,
    });
  });

  it('agrees only when the mapped episode is the best match (D-05 rule 4)', () => {
    const episodes: TitleEvidenceEpisode[] = [
      { id: 1, seasonNumber: 1, episodeNumber: 1, title: 'Spice It Up' },
      { id: 2, seasonNumber: 1, episodeNumber: 2, title: 'Spice It Up Again' },
    ];
    const ev = episodeTitleEvidence({ name: 'Show.S01E01.Spice.It.Up.Again.1080p', episodes });
    expect(ev.againstScore).toBeGreaterThanOrEqual(TITLE_AGREE_MIN);
    expect(ev).toMatchObject({ verdict: 'ambiguous', bestEpisodeId: 2, bestScore: 1 });
    // A tie keeps the mapped episode.
    const tie = episodeTitleEvidence({
      name: 'Show.S01E02.Pilot.1080p',
      episodes: [
        { id: 1, seasonNumber: 1, episodeNumber: 1, title: 'Pilot' },
        { id: 2, seasonNumber: 1, episodeNumber: 2, title: 'Pilot' },
      ],
    });
    expect(tie).toMatchObject({ verdict: 'agrees', bestEpisodeId: 1, againstScore: 1 });
  });

  it('only the judged season is scored', () => {
    const episodes: TitleEvidenceEpisode[] = [
      { id: 1, seasonNumber: 1, episodeNumber: 1, title: 'Stilt Walkers' },
      { id: 2, seasonNumber: 2, episodeNumber: 1, title: 'Spice It Up' },
      { id: 3, seasonNumber: 1, episodeNumber: 2, title: 'Nap Spot' },
    ];
    expect(episodeTitleEvidence({ name: 'Show.S01E01.Spice.It.Up.1080p', episodes })).toMatchObject(
      {
        verdict: 'ambiguous',
        againstEpisodeIds: [1],
        bestEpisodeId: null,
      },
    );
  });

  it('a name without an episode token has no episode title: silent', () => {
    expect(
      episodeTitleEvidence({
        name: 'Regular.Show.The.Lost.Tapes.S01.1080p.AMZN.WEB-DL',
        episodes: LOST_TAPES_S1,
        againstEpisodeIds: [118407],
      }),
    ).toMatchObject({ verdict: 'silent', titleTokens: [], againstEpisodeIds: [118407] });
  });
});

describe('movieTitleEvidence', () => {
  it('a second title in brackets still matches (TurkSeeD, Spider-Man: Brand New Day)', () => {
    const ev = movieTitleEvidence({
      name: 'Orumcek Adam Yepyeni Bir Gun [Spider Man Brand New Day] 2026 WEBDL 2160p X265 10Bit DDP 5.1 [TR-EN] TurkSeeD',
      titles: ['Spider-Man: Brand New Day'],
      year: 2026,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', score: 1, nameYear: 2026 });
    expect(
      movieTitleEvidence({
        name: 'Spiderman.Brand.New.Day.2026.1080p',
        titles: ['Spider-Man: Brand New Day'],
        year: 2026,
      }).verdict,
    ).toBe('agrees');
  });

  it('a different movie is ambiguous', () => {
    const ev = movieTitleEvidence({
      name: 'Alatriste.2006.1080p.BluRay.x264',
      titles: ['A Movie of Eggs'],
    });
    expect(ev).toMatchObject({
      verdict: 'ambiguous',
      titleTokens: ['alatriste'],
      score: 0,
      nameYear: 2006,
    });
  });

  it('a year more than one off is ambiguous', () => {
    const name = 'Good.Boy.2025.1080p.WEB-DL';
    expect(movieTitleEvidence({ name, titles: ['Good Boy'], year: 2026 }).verdict).toBe('agrees');
    expect(movieTitleEvidence({ name, titles: ['Good Boy'], year: 2025 }).verdict).toBe('agrees');
    expect(movieTitleEvidence({ name, titles: ['Good Boy'], year: 2023 })).toMatchObject({
      verdict: 'ambiguous',
      score: 1,
    });
    expect(movieTitleEvidence({ name, titles: ['Good Boy'] }).verdict).toBe('agrees');
    expect(
      movieTitleEvidence({ name: 'Good.Boy.1080p.WEB-DL', titles: ['Good Boy'], year: 2023 })
        .verdict,
    ).toBe('agrees');
  });

  it('The Naked Gun 2½ matches 2.1.2', () => {
    const ev = movieTitleEvidence({
      name: 'The.Naked.Gun.2.1.2.The.Smell.of.Fear.1991.2160p.iT.WEB-DL.DDP5.1.DV.HDR10Plus.H.265-iCX',
      titles: ['The Naked Gun 2½: The Smell of Fear'],
      year: 1991,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', score: 1, nameYear: 1991 });
  });

  it('Blade Runner 2049 (2017): the title number is not the year', () => {
    expect(
      movieTitleEvidence({
        name: 'Blade.Runner.2049.2017.1080p.BluRay',
        titles: ['Blade Runner 2049'],
        year: 2017,
      }),
    ).toMatchObject({ verdict: 'agrees', score: 1, nameYear: 2017 });
  });

  it('a TV release grabbed for a movie is ambiguous, an episode or a season pack', () => {
    const titles = ['Star Wars Rebels: Spark of Rebellion'];
    expect(
      movieTitleEvidence({ name: 'Star.Wars.Rebels.S01E01.Spark.of.Rebellion.1080p', titles }),
    ).toMatchObject({
      verdict: 'ambiguous',
      score: null,
    });
    expect(
      movieTitleEvidence({
        name: 'Star.Wars.Rebels.S01.1080p.BluRay',
        titles: ['Star Wars Rebels'],
      }),
    ).toMatchObject({
      verdict: 'ambiguous',
      score: null,
    });
    expect(
      movieTitleEvidence({ name: 'Ludwig.2024.S01.2160p.BB.WEB-DL', titles: ['Ludwig'] }).verdict,
    ).toBe('ambiguous');
  });

  it('the best of several titles counts (an alternative title)', () => {
    const ev = movieTitleEvidence({
      name: 'Orumcek.Adam.Yepyeni.Bir.Gun.2026.1080p.WEB-DL',
      titles: ['Spider-Man: Brand New Day', 'Örümcek Adam: Yepyeni Bir Gün'],
      year: 2026,
    });
    expect(ev).toMatchObject({ verdict: 'agrees', score: 1 });
  });

  it('a name with no title, or an obfuscated one, is silent', () => {
    expect(movieTitleEvidence({ name: '1080p.WEB-DL.mkv', titles: ['Good Boy'] })).toMatchObject({
      verdict: 'silent',
      titleTokens: [],
      score: null,
    });
    expect(
      movieTitleEvidence({ name: 'a8f7d6e5c4b3a2918273645.mkv', titles: ['Good Boy'] }).verdict,
    ).toBe('silent');
    expect(movieTitleEvidence({ name: 'Alatriste.mkv', titles: ['A Movie of Eggs'] }).verdict).toBe(
      'ambiguous',
    );
  });

  it('no usable title scores null and is ambiguous', () => {
    expect(movieTitleEvidence({ name: 'Good.Boy.2025.1080p', titles: ['', '!!'] })).toMatchObject({
      verdict: 'ambiguous',
      score: null,
    });
  });
});

describe('seriesYearConflict', () => {
  it('returns the release year only when both years are known and more than one apart', () => {
    expect(seriesYearConflict({ name: RUGRATS_2021, seriesYear: 1991 })).toBe(2021);
    expect(seriesYearConflict({ name: RUGRATS_2021, seriesYear: 2021 })).toBeNull();
    expect(
      seriesYearConflict({ name: 'Show.2025.S01E01.Title.1080p', seriesYear: 2024 }),
    ).toBeNull();
    expect(seriesYearConflict({ name: RUGRATS_2021, seriesYear: null })).toBeNull();
    expect(seriesYearConflict({ name: CASE_A, seriesYear: 2026 })).toBeNull();
  });

  it('is TV only', () => {
    expect(seriesYearConflict({ name: 'Good.Boy.2025.1080p.WEB-DL', seriesYear: 1990 })).toBeNull();
  });
});
