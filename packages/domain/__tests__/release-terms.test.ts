// ADR-093 C-19 / DESIGN-052 D-12 (PLAN-072 S2) — the Release Block's "must not contain" terms, pure: derivation
// fixtures (the D-12 examples and the test-strategy list), the self-check fallback, and the whitelist grammar that
// the writer re-checks before every POST / PUT.
import { describe, expect, it } from 'vitest';
import {
  RELEASE_BLOCK_SENTINEL,
  compileTerm,
  deriveTerm,
  deriveTermsPerName,
  foldReleaseName,
  isGrammarTerm,
  mergeTermWords,
  parseReleaseGroup,
  parseReleaseName,
  releaseTokens,
  renderTerm,
  resolutionFromQualityName,
  termMatches,
  termMatchesRaw,
  termWords,
  type TermDerivationInput,
} from '../src/index';

const movie = (over: Partial<TermDerivationInput>): TermDerivationInput => ({
  kind: 'movie',
  arrTitle: 'Babygirl',
  arrYears: [2024],
  releaseNames: [],
  renamedFileName: null,
  releaseGroup: null,
  resolution: null,
  remux: false,
  ...over,
});

describe('tokens and names (D-12)', () => {
  it('folds accents, drops apostrophes, reads & as and', () => {
    expect(releaseTokens("Amélie's Café & Bar")).toEqual(['amelies', 'cafe', 'and', 'bar']);
  });

  it('parses the year, preferring the *arr years, and the later of two adjacent year tokens', () => {
    expect(parseReleaseName('Blade.Runner.2049.2017.2160p.UHD.BluRay-GROUP').year).toBe(2017);
    expect(parseReleaseName('Blade.Runner.2049.2017.2160p.UHD.BluRay-GROUP').titleTokens).toEqual([
      'blade',
      'runner',
      '2049',
    ]);
    expect(parseReleaseName('1917.2019.1080p.BluRay.x264-SPARKS', [2019]).titleTokens).toEqual([
      '1917',
    ]);
  });

  it('reads a scene group after the last dash, and not a WEB-DL / H.265 tail', () => {
    expect(
      parseReleaseGroup('Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR'),
    ).toBe('FraMeSToR');
    expect(
      parseReleaseGroup(
        '101 Dalmatians (1996) {imdb-tt0115433} [WEBRip-1080p][EAC3 2.0][x264]-NTb.mkv',
      ),
    ).toBe('NTb');
    expect(
      parseReleaseGroup('Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265'),
    ).toBeNull();
    expect(parseReleaseGroup('Some.Movie.2020.1080p.WEB-DL')).toBeNull();
  });
});

describe('deriveTerm — movies (D-12)', () => {
  const babygirl = movie({
    releaseNames: ['Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR'],
    releaseGroup: 'FraMeSToR',
    resolution: 2160,
    remux: true,
  });

  it('renders the D-12 Babygirl example exactly', () => {
    expect(deriveTerm(babygirl)).toEqual({
      term: '/^babygirl[^a-z0-9]+2024[^a-z0-9](?=.*(?<![a-z0-9])2160p(?![a-z0-9]))(?=.*(?<![a-z0-9])remux(?![a-z0-9])).*[^a-z0-9]framestor(?:[^a-z0-9]|$)/i',
      shape: 'group',
      confidence: 'verified',
      years: [2024],
      foldOnly: false,
      namesakeYears: [],
    });
  });

  it('blocks the release and its space-separated repost, not another group or resolution', () => {
    const { term } = deriveTerm(babygirl)!;
    expect(
      termMatches(term, 'Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR'),
    ).toBe(true);
    expect(
      termMatches(term, 'Babygirl 2024 UHD BluRay 2160p TrueHD Atmos 7 1 DV HEVC REMUX-FraMeSToR'),
    ).toBe(true);
    expect(termMatches(term, 'Babygirl-2024-2160p iT WEB-DL DDP5 1 Atmos DV HDR H 265-HONE')).toBe(
      false,
    );
    expect(termMatches(term, 'Babygirl.2024.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-APEX')).toBe(
      false,
    );
  });

  it('a remux term does not block the same group’s WEB-DL of that resolution', () => {
    const { term } = deriveTerm(babygirl)!;
    expect(termMatches(term, 'Babygirl.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265-FraMeSToR')).toBe(
      false,
    );
  });

  it('Annabelle FLUX: dotted and spaced names both match; another title of the group does not', () => {
    const d = deriveTerm(
      movie({
        arrTitle: 'Annabelle',
        arrYears: [2014],
        releaseNames: ['Annabelle.2014.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX'],
        releaseGroup: 'FLUX',
        resolution: 1080,
      }),
    )!;
    expect(termMatches(d.term, 'Annabelle 2014 1080p AMZN WEB-DL DDP5 1 H 264-FLUX')).toBe(true);
    expect(termMatches(d.term, 'Annabelle.Creation.2017.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX')).toBe(
      false,
    );
  });

  it('Terrifier: the release says 2016, Radarr 2018 — the year is an alternation of both', () => {
    const d = deriveTerm(
      movie({
        arrTitle: 'Terrifier',
        arrYears: [2018],
        releaseNames: ['Terrifier.2016.Uncut.UHD.BluRay.2160p.DTS-HD.MA.5.1.HEVC.REMUX-FraMeSToR'],
        resolution: 2160,
        remux: true,
      }),
    )!;
    expect(d.years).toEqual([2016, 2018]);
    expect(d.term).toContain('(?:2016|2018)');
    expect(
      termMatches(d.term, 'Terrifier.2018.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-FraMeSToR'),
    ).toBe(true);
  });

  it('D-25dd: an apostrophe is an optional separator and an `and` may be a raw `&`, so the raw names match too', () => {
    const d = deriveTerm(
      movie({
        arrTitle: "Don't Look Up",
        arrYears: [2021],
        releaseNames: ["Don't.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX"],
        releaseGroup: 'FLUX',
        resolution: 2160,
      }),
    )!;
    expect(d.term.startsWith('/^don[^a-z0-9]?t[^a-z0-9]+look[^a-z0-9]+up')).toBe(true);
    for (const name of [
      "Don't.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX",
      'Dont.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX',
      'Don’t Look Up 2021 2160p NF WEB-DL DDP5 1 Atmos DV H 265-FLUX',
    ]) {
      expect(termMatchesRaw(d.term, name)).toBe(true);
    }
    expect(d).toMatchObject({ confidence: 'verified', foldOnly: false });
    const amp = deriveTerm(
      movie({
        arrTitle: 'Fast & Furious',
        arrYears: [2009],
        releaseNames: ['Fast.and.Furious.2009.1080p.BluRay.x264-SPARKS'],
        releaseGroup: 'SPARKS',
        resolution: 1080,
      }),
    )!;
    expect(amp.term.startsWith('/^fast[^a-z0-9]+(?:and[^a-z0-9]+)?furious[^a-z0-9]+2009')).toBe(true);
    for (const name of [
      'Fast.and.Furious.2009.1080p.BluRay.x264-SPARKS',
      'Fast & Furious 2009 1080p BluRay x264-SPARKS',
      'Fast&Furious.2009.1080p.BluRay.x264-SPARKS',
    ]) {
      expect(termMatchesRaw(amp.term, name)).toBe(true);
    }
    // Still that title only: another film of the group and year is not blocked.
    expect(termMatchesRaw(amp.term, 'Fast.Five.2009.1080p.BluRay.x264-SPARKS')).toBe(false);
  });

  it('a renamed file as the only name: low confidence, year window widened by one each side', () => {
    const d = deriveTerm(
      movie({
        arrTitle: '101 Dalmatians',
        arrYears: [1996],
        renamedFileName:
          '101 Dalmatians (1996) {imdb-tt0115433} [WEBRip-1080p][EAC3 2.0][x264]-NTb.mkv',
        releaseGroup: 'NTb',
        resolution: 1080,
      }),
    )!;
    expect(d.confidence).toBe('low_confidence');
    expect(d.years).toEqual([1995, 1996, 1997]);
    expect(termMatches(d.term, '101.Dalmatians.1996.1080p.WEBRip.x264-NTb')).toBe(true);
  });

  it('D-25cr: a renamed-only window never widens onto a namesake`s year (The Killer 2024 next to The Killer 2023)', () => {
    const killer = (namesakes?: Array<{ title: string; year: number | null }>) =>
      deriveTerm(
        movie({
          arrTitle: 'The Killer',
          arrYears: [2024, null],
          renamedFileName:
            'The Killer (2024) {imdb-tt1121948} [PCOK][WEBDL-2160p][DV HDR10][EAC3 Atmos 5.1][x265]-FLUX.mkv',
          releaseGroup: 'FLUX',
          resolution: 2160,
          ...(namesakes ? { namesakes } : {}),
        }),
      )!;
    const fincher = 'The.Killer.2023.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
    // Without the ledger's titles the window covers 2023, and the other film's FLUX 2160p release is blocked.
    expect(termMatches(killer().term, fincher)).toBe(true);
    const d = killer([
      { title: 'The Killer', year: 2023 },
      { title: 'Killer Joe', year: 2025 }, // another title: its year still widens
      { title: 'The Killer', year: null },
    ]);
    expect(d).toMatchObject({ years: [2024, 2025], namesakeYears: [2023], confidence: 'low_confidence' });
    expect(termMatches(d.term, fincher)).toBe(false);
    expect(termMatches(d.term, `${fincher.replace('H.265-FLUX', 'H.265.REPACK-FLUX')}`)).toBe(false);
    expect(termMatches(d.term, 'The.Killer.2024.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX')).toBe(true);
    expect(termMatches(d.term, 'The.Killer.2025.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX')).toBe(true);
    // The *arr's own years are never dropped, even when a namesake shares one; a real release name never widens.
    const own = deriveTerm(
      movie({
        arrTitle: 'Stolen',
        arrYears: [2024, 2023],
        renamedFileName: 'Stolen (2024) [WEBDL-1080p]-FLUX.mkv',
        releaseGroup: 'FLUX',
        resolution: 1080,
        namesakes: [{ title: 'Stolen', year: 2023 }],
      }),
    )!;
    expect(own).toMatchObject({ years: [2022, 2023, 2024, 2025], namesakeYears: [] });
  });

  it('no group: the exact name, separator-insensitive; the renamed file alone never yields an exact term', () => {
    const d = deriveTerm(
      movie({
        arrTitle: 'Another Simple Favor',
        arrYears: [2025],
        releaseNames: ['Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265'],
      }),
    )!;
    expect(d.shape).toBe('exact');
    expect(
      termMatches(d.term, 'Another Simple Favor 2025 2160p AMZN WEB-DL DDP5 1 Atmos DV HDR H 265'),
    ).toBe(true);
    expect(
      deriveTerm(
        movie({ arrTitle: 'X', renamedFileName: 'X (2020) [Bluray-1080p].mkv', resolution: 1080 }),
      ),
    ).toBeNull();
  });

  it('a bare "Title (Year)" name is no release: no exact term that would block every release of the title', () => {
    expect(deriveTerm(movie({ releaseNames: ['Babygirl (2024)'] }))).toBeNull();
    expect(
      deriveTerm(movie({ releaseNames: ['Babygirl.2024.2160p.UHD.BluRay.x265'] }))?.shape,
    ).toBe('exact');
  });

  it('D-25be: a short name (title, year, resolution, nothing else) yields no exact term: it would block every 1080p release', () => {
    const trap = (name: string) => deriveTerm(movie({ arrTitle: 'Trap', releaseNames: [name] }));
    expect(trap('Trap.2024.1080p')).toBeNull();
    expect(trap('Trap (2024) 1080p')).toBeNull();
    // A group makes it a group term (that group's release only); any token past the resolution makes the exact prefix
    // specific enough.
    const withGroup = trap('Trap.2024.1080p-FLUX')!;
    expect(withGroup.shape).toBe('group');
    expect(termMatches(withGroup.term, 'Trap 2024 1080p BluRay x264-SPARKS')).toBe(false);
    const withSource = trap('Trap.2024.1080p.BluRay')!;
    expect(withSource.shape).toBe('exact');
    expect(termMatches(withSource.term, 'Trap 2024 1080p WEBRip x265-RARBG')).toBe(false);
    // A show: the season marker counts like the year.
    expect(
      deriveTerm({
        kind: 'show',
        arrTitle: 'Some Show',
        arrYears: [2010],
        releaseNames: ['Some.Show.S01.720p'],
        renamedFileName: null,
        releaseGroup: null,
        resolution: null,
        remux: false,
        season: 1,
      }),
    ).toBeNull();
  });

  it('nothing known (no group, no name): no term', () => {
    expect(deriveTerm(movie({}))).toBeNull();
  });

  it('a group term that fails the self-check falls back to the exact form of the first name', () => {
    // The second name is another group: the group term cannot match both, so the first name is blocked exactly.
    const d = deriveTerm(
      movie({
        arrTitle: 'Babygirl',
        releaseNames: [
          'Babygirl.2024.2160p.UHD.BluRay.REMUX-FraMeSToR',
          'Babygirl.2024.2160p.UHD.BluRay.REMUX-OTHER',
        ],
        releaseGroup: 'FraMeSToR',
        resolution: 2160,
        remux: true,
      }),
    )!;
    expect(d.shape).toBe('exact');
    expect(termMatches(d.term, 'Babygirl.2024.2160p.UHD.BluRay.REMUX-FraMeSToR')).toBe(true);
  });
});

describe('deriveTermsPerName — a record with several real names (D-25bp)', () => {
  it('an exact fallback from the first name gives every other name its own term, so the scene name is blocked too', () => {
    // The grab title carries no resolution token, so the 2160p group term fails its self-check and deriveTerm falls
    // back to the grab title's exact form, which never matches the file's scene name.
    const names = ['Movie.Title.2020.UHD.BluRay.x265-GRP', 'Movie.Title.2020.2160p.UHD.BluRay.x265-GRP'];
    const input = movie({
      arrTitle: 'Movie Title',
      arrYears: [2020],
      releaseNames: names,
      releaseGroup: 'GRP',
      resolution: 2160,
    });
    const combined = deriveTerm(input)!;
    expect(combined.shape).toBe('exact');
    expect(termMatches(combined.term, names[1]!)).toBe(false);
    const per = deriveTermsPerName(input)!;
    expect(per.map((p) => p.name)).toEqual(names);
    for (const name of names) {
      expect(per.some((p) => termMatchesRaw(p.derived.term, name))).toBe(true);
    }
    expect(per.map((p) => p.derived.shape)).toEqual(['exact', 'group']);
  });

  it('one entry when the group term covers every name, or when there is a single name', () => {
    const names = [
      'Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR',
      'Babygirl.2024.2160p.UHD.BluRay.REMUX.HEVC-FraMeSToR',
    ];
    const both = deriveTermsPerName(
      movie({ releaseNames: names, releaseGroup: 'FraMeSToR', resolution: 2160, remux: true }),
    )!;
    expect(both).toHaveLength(1);
    expect(both[0]!.derived.shape).toBe('group');
    const single = deriveTermsPerName(movie({ releaseNames: ['Babygirl.2024.2160p.UHD.BluRay.x265'] }))!;
    expect(single).toHaveLength(1);
    expect(single[0]!.derived.shape).toBe('exact');
  });

  it('a name that yields no term keeps the whole record unrecordable (null)', () => {
    // The second name is a bare "Title (Year)": no exact term exists for it (D-25ae).
    expect(
      deriveTermsPerName(
        movie({ releaseNames: ['Babygirl.2024.2160p.UHD.BluRay.x265', 'Babygirl (2024)'], resolution: 2160 }),
      ),
    ).toBeNull();
  });
});

describe('the raw title (D-25bq, D-25dd): the *arr tests the name as it is', () => {
  const cases: Array<[string, Partial<TermDerivationInput>]> = [
    [
      "Harry Potter and the Sorcerer's Stone (2001) (1080p BluRay x265 HEVC 10bit AAC 7.1 Tigole)",
      { arrTitle: "Harry Potter and the Philosopher's Stone", arrYears: [2001], releaseGroup: 'Tigole', resolution: 1080 },
    ],
    [
      'Fast & Furious 6 (2013) (1080p BluRay x265 HEVC 10bit AAC 7.1 Tigole)',
      { arrTitle: 'Fast & Furious 6', arrYears: [2013], releaseGroup: 'Tigole', resolution: 1080 },
    ],
    ['Amélie.2001.1080p.BluRay.x264-GRP', { arrTitle: 'Amélie', arrYears: [2001], releaseGroup: 'GRP', resolution: 1080 }],
  ];

  it.each(cases)('%s: the term matches the raw name, so it is verified', (name, over) => {
    const d = deriveTerm(movie({ ...over, releaseNames: [name] }))!;
    expect(termMatchesRaw(d.term, name)).toBe(true);
    expect(termMatchesRaw(d.term, foldReleaseName(name))).toBe(true); // … and the folded spelling of it
    expect(d).toMatchObject({ confidence: 'verified', foldOnly: false });
  });

  it('an accented letter matches both spellings, and the *arr title adds its own (Léon, the release says Leon)', () => {
    const d = deriveTerm(
      movie({
        arrTitle: 'Léon: The Professional',
        arrYears: [1994],
        releaseNames: ['Leon.1994.Theatrical.Cut.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.HYBRID.REMUX-FraMeSToR'],
        releaseGroup: 'FraMeSToR',
        resolution: 2160,
        remux: true,
      }),
    )!;
    expect(d.term.startsWith('/^l(?:e|é)on[^a-z0-9]+1994')).toBe(true);
    expect(termMatchesRaw(d.term, 'Léon.1994.Theatrical.Cut.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.HYBRID.REMUX-FraMeSToR')).toBe(true);
    expect(termMatchesRaw(d.term, 'LÉON.1994.UHD.BluRay.2160p.REMUX-FraMeSToR')).toBe(true);
    expect(termMatchesRaw(d.term, 'Lion.1994.UHD.BluRay.2160p.REMUX-FraMeSToR')).toBe(false);
  });

  it('a name the grammar still cannot write (a decomposed accent inside a word) is matched only folded: low_confidence, foldOnly', () => {
    // NFD: "e" followed by U+0301. The term's `(?:e|é)` matches the composed letter or the bare one, not the pair, and
    // Radarr and Sonarr test the name as it is; the self-check still accepts it folded, so it is counted, not hidden.
    const name = 'Ame\u0301lie.2001.1080p.BluRay.x264-GRP';
    const d = deriveTerm(movie({ arrTitle: 'Amélie', arrYears: [2001], releaseGroup: 'GRP', resolution: 1080, releaseNames: [name] }))!;
    expect(termMatches(d.term, name)).toBe(true);
    expect(termMatchesRaw(d.term, name)).toBe(false);
    expect(d).toMatchObject({ shape: 'group', confidence: 'low_confidence', foldOnly: true });
    const exact = deriveTerm(movie({ arrTitle: 'Amélie', arrYears: [2001], releaseNames: ['Ame\u0301lie.2001.1080p.BluRay.x264'] }))!;
    expect(exact).toMatchObject({ shape: 'exact', confidence: 'low_confidence', foldOnly: true });
  });

  it('a scene name without those characters stays verified; a renamed file alone is low_confidence but not foldOnly', () => {
    const scene = deriveTerm(
      movie({
        arrTitle: "Don't Look Up",
        arrYears: [2021],
        releaseNames: ['Dont.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX'],
        releaseGroup: 'FLUX',
        resolution: 2160,
      }),
    )!;
    expect(scene).toMatchObject({ confidence: 'verified', foldOnly: false });
    // The *arr title's apostrophe is merged in: a repost that keeps it is blocked too.
    expect(termMatchesRaw(scene.term, "Don't.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX")).toBe(true);
    const renamed = deriveTerm(
      movie({
        arrTitle: "Don't Look Up",
        arrYears: [2021],
        renamedFileName: "Don't Look Up (2021) [WEBDL-2160p][EAC3 Atmos 5.1][h265]-FLUX.mkv",
        releaseGroup: 'FLUX',
        resolution: 2160,
      }),
    )!;
    expect(renamed).toMatchObject({ confidence: 'low_confidence', foldOnly: false });
  });

  it('the exact form is judged the same way', () => {
    const d = deriveTerm(movie({ arrTitle: 'Amélie', arrYears: [2001], releaseNames: ['Amélie.2001.1080p.BluRay.x264'] }))!;
    expect(d).toMatchObject({ shape: 'exact', confidence: 'verified', foldOnly: false });
    expect(termMatchesRaw(d.term, 'Amelie 2001 1080p BluRay x264')).toBe(true);
  });

  it('D-25dd, the PLAN-072 S6 pool: a renamed-only term blocks the scene spelling and the title`s own (apostrophe, &)', () => {
    // Radarr's renamed files drop the apostrophe and write `&` as "and"; the *arr title keeps both.
    const game = deriveTerm(
      movie({
        arrTitle: "The Killer's Game",
        arrYears: [2024, null],
        renamedFileName:
          'The Killers Game (2024) {imdb-tt0327785} [Remux-2160p][DV HDR10][TrueHD Atmos 7.1][HEVC]-FraMeSToR.mkv',
        releaseGroup: 'FraMeSToR',
        resolution: 2160,
        remux: true,
      }),
    )!;
    expect(game.term.startsWith('/^the[^a-z0-9]+killer[^a-z0-9]?s[^a-z0-9]+game')).toBe(true);
    for (const name of [
      "The.Killer's.Game.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR",
      'The.Killers.Game.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR',
    ]) {
      expect(termMatchesRaw(game.term, name)).toBe(true);
    }
    const vita = deriveTerm(
      movie({
        arrTitle: 'Vita & Virginia',
        arrYears: [2019, 2018],
        renamedFileName: 'Vita and Virginia (2019) {imdb-tt5859882} [Remux-1080p][DTS-HD MA 5.1][AVC]-KRaLiMaRKo.mkv',
        releaseGroup: 'KRaLiMaRKo',
        resolution: 1080,
        remux: true,
      }),
    )!;
    for (const name of [
      'Vita.&.Virginia.2018.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-KRaLiMaRKo',
      'Vita.and.Virginia.2018.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-KRaLiMaRKo',
    ]) {
      expect(termMatchesRaw(vita.term, name)).toBe(true);
    }
    expect(vita).toMatchObject({ confidence: 'low_confidence', foldOnly: false });
  });
});

describe('real ledger names that used to match only folded (PLAN-072 S6(e), D-25dd)', () => {
  // [arr, *arr title, year, release name, release group, quality]: grabbed and imported names from the ledger whose
  // term, before D-25dd, matched only the folded name (345 of 19,434 Sonarr names and 3 of 1,159 Radarr names on
  // 2026-09-27), one or two per title, every character class. Each row is derived exactly as the S6(e) ledger pass does.
  const rows: Array<[string, string, number, string, string | null, string]> = [
    ["radarr", "Kiki's Delivery Service", 1989, "Kiki's.Delivery.Service.1989.1080p.Bluray.Remux.AVC.DTS-MA", null, "Remux-1080p"],
    ["radarr", "I'm Thinking of Ending Things", 2020, "I'm.Thinking.of.Ending.Things.2020.2160p.NF.WEB-DL.DD+5.1.Atmos.H.265-playWEB", "playWEB", "WEBDL-2160p"],
    ["radarr", "The Sorcerer's Apprentice", 2010, "The.Sorcerer's.Apprentice.2010.BluRay.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR", "FraMeSToR", "Remux-1080p"],
    ["sonarr", "American Dad!", 2005, "American Dad! - S02E12 - It's Good to be the Queen[WEBDL-1080p.AC3.h264.PiTBULL]", null, "WEBDL-1080p"],
    ["sonarr", "Marvel's Daredevil", 2015, "Marvel's.Daredevil.S03E05.The.Perfect.Game.2160p.DSNP.WEB-DL.DDP.5.1.Atmos.DoVi.HDR.HEVC-SiC", "SiC", "WEBDL-2160p"],
    ["sonarr", "9-1-1", 2018, "9-1-1 - S06E02 - Crash & Learn[WEBDL-1080p.AC3.h264.alfaHD]", null, "WEBDL-1080p"],
    ["sonarr", "Arthur", 1996, "Arthur - S17E01-02 - Show Off + Dog's Best Friend.WEBDL-1080p.AAC.x264.TVSmash", null, "WEBDL-1080p"],
    ["sonarr", "It's Always Sunny in Philadelphia", 2005, "It's Always Sunny in Philadelphia (2005) S09E02 Silah Ilgisi_ Halen Sicak 1080p DSNP WEBDL H264 [TRSub] AAC 0 @TSRG", null, "WEBDL-1080p"],
    ["sonarr", "It's Always Sunny in Philadelphia", 2005, "It's Always Sunny in Philadelphia (2005) S09E03 Cete Umutsuzca Odul Kazanmaya Calisiyor 1080p DSNP WEBDL H264 [TRSub] AAC 0 @TSRG", null, "WEBDL-1080p"],
    ["sonarr", "Be Cool, Scooby-Doo!", 2015, "Be.Cool.Scooby-Doo! - S02E26 - Pizza O'Possum's.WEBDL-1080p.AAC.h264.Beards", null, "WEBDL-1080p"],
    ["sonarr", "Skull Island", 2023, "Skull Island - S01E07 - You're Not a King You're Just a Stupid Animal - [x264-WEBDL-1080p EAC3 Atmos-5.1]", null, "WEBDL-1080p"],
    ["sonarr", "Bob's Burgers", 2011, "Bob's Burgers (2011) - S11E01 - Dream a Little Bob of Bob [DSNP][WEBDL-1080p][EAC3 5.1][h264]-FLUX", "FLUX", "WEBDL-1080p"],
    ["sonarr", "Bob's Burgers", 2011, "Bob's Burgers (2011) - S11E02 - Worms of In-Rear-ment [DSNP][WEBDL-1080p][EAC3 5.1][h264]-FLUX", "FLUX", "WEBDL-1080p"],
    ["sonarr", "#RichKids of Beverly Hills", 2014, "RichKids of Beverly Hills - S02E07 - Pride&Prada[WEBDL-1080p.AAC.h264.OnlyWEB]", null, "WEBDL-1080p"],
    ["sonarr", "American Greed", 2007, "American Greed - S14E07 - Inside El Chapo's Empire[WEBDL-1080p.AAC.x264.FFG]", null, "WEBDL-1080p"],
    ["sonarr", "Bering Sea Gold", 2012, "Bering.Sea.Gold.S02E09.Don't.Tell.Me.to.Chillax!.CAFFEiNE.WEB.DL.1080p.WEB-DL.AAC.x264", null, "WEBDL-1080p"],
    ["sonarr", "Big Mouth", 2017, "Big.Mouth.S01E09.I.Survived.Jessi's.Bat.Mitzvah.SiGMA.WEB.DL.1080p.WEB-DL.AAC.x264", null, "WEBDL-1080p"],
    ["sonarr", "Alaskan Bush People", 2014, "Alaskan Bush People - S12E08 - Faith & Fury[WEBDL-1080p.AAC.h264.BurCyg]", null, "WEBDL-1080p"],
    ["sonarr", "Lilo & Stitch: The Series", 2003, "Lilo.&.Stitch.The.Series.S01E34.2003.1080p.DSNP.WEB-DL.AVC.AAC.2.0.25Audio-LongWeb", "LongWeb", "WEBDL-1080p"],
    ["sonarr", "Lilo & Stitch: The Series", 2003, "Lilo.&amp;.Stitch.The.Series.S01E34.2003.1080p.DSNP.WEB-DL.AVC.AAC.2.0.25Audio-LongWeb", "LongWeb", "WEBDL-1080p"],
    ["sonarr", "Marvel's Jessica Jones", 2015, "Marvel's.Jessica.Jones.S02E06.AKA.Facetime.2160p.DSNP.WEB-DL.DDP.5.1.Atmos.DoVi.HDR.HEVC-SiC", "SiC", "WEBDL-2160p"],
    ["sonarr", "Batman: The Animated Series", 1992, "Batman.The.Animated.Series.1992.S01E47.Harley.&.Ivy.1080p.HMAX.WEB-DL.MULTi.DDP2.0.H.264-FUZEER", "FUZEER", "WEBDL-720p"],
    ["sonarr", "American Chopper", 2003, "American Chopper - S03E01 - Junior's Dream Bike 1[WEBDL-1080p.AAC.h264.POWER]", null, "WEBDL-1080p"],
    ["sonarr", "black-ish", 2014, "black.ish.S04E07.Please.Don't.Feed.the.Animals.WEB.DL.1080p.WEB-DL.AAC.x264", null, "WEBDL-1080p"],
    ["sonarr", "The Penguins of Madagascar", 2008, "Los.Pingüinos.de.Madagascar.S01E01.Pánico.con.palomitas.Desaparecido.2021.MULTI.1080p.PMTP.WEB-DL.DD5.1.H.264-AndreMor", "AndreMor", "WEBDL-1080p"],
    ["sonarr", "The Penguins of Madagascar", 2008, "Los.Pingüinos.de.Madagascar.S01E02.Enredados.en.la.red.Los.tontos.de.la.corona.2021.MULTI.1080p.PMTP.WEB-DL.DD5.1.H.264-AndreMor", "AndreMor", "WEBDL-1080p"],
    ["sonarr", "Ben 10 (2016)", 2016, "Ben.10.2016 - S01E20 - Don't Let the Bass Drop.WEBDL-1080p.AAC.h264.YFN", null, "WEBDL-1080p"],
    ["sonarr", "Marvel's The Punisher", 2017, "Marvel's.The.Punisher.S01E04.Resupply.2160p.NF.WEB-DL.DDP.5.1.Atmos.DoVi.HDR.HEVC-SiC", "SiC", "WEBDL-2160p"],
    ["sonarr", "The Amazing Race", 2001, "The Amazing Race - S18E05 - Don't Ruin the Basketball Game[WEBDL-1080p.AAC.h264.Rmp4L]", null, "WEBDL-1080p"],
    ["sonarr", "The Amazing Race", 2001, "The Amazing Race - S18E07 - You Don't Get Paid Unless You Win[WEBDL-1080p.AAC.h264.Rmp4L]", null, "WEBDL-1080p"],
    ["sonarr", "Billy the Kid", 2022, "Billy.the.Kid.S03E04.The.Shepherd's.Hut.WEB.DL.1080p.WEB-DL.AC3.x264", null, "WEBDL-1080p"],
    ["sonarr", "America's Got Talent", 2006, "Americas Got Talent - S17E06 - Simon's Favorite Golden Buzzers[WEBDL-1080p.AAC.x264.KOGi]", null, "WEBDL-1080p"],
    ["sonarr", "60 Days In", 2016, "60.Days.In.S05E03.It's.About.to.Get.Ugly.TrollHD.WEB.DL.1080p.WEB-DL.AAC.x264", null, "WEBDL-1080p"],
    ["sonarr", "Clarence (2014)", 2014, "Clarence.2014 - S01E05-06 - Clarence's Millions + Clarence Gets a Girlfriend.WEBDL-1080p.AAC.h264.ROWSDOWER", null, "WEBDL-1080p"],
    ["sonarr", "Batwoman", 2019, "Batwoman.S02E07.It's.Best.You.Stop.Digging[.NOCTURNALFEMALE.1080p.BluRay.AAC.x264", null, "Bluray-1080p"],
  ];

  const derive = ([arr, title, year, name, grp, quality]: (typeof rows)[number]) => {
    const parsed = parseReleaseName(name, [year]);
    return deriveTerm({
      kind: arr === 'radarr' ? 'movie' : 'show',
      arrTitle: title,
      arrYears: [year],
      releaseNames: [name],
      renamedFileName: null,
      releaseGroup: grp,
      resolution: resolutionFromQualityName(quality) ?? parsed.resolution,
      remux: /remux/i.test(quality) || parsed.remux,
      season: arr === 'sonarr' ? parsed.season : null,
    });
  };

  it.each(rows)('%s %s: %s', (...row) => {
    const d = derive(row);
    const name = row[3];
    expect(d).not.toBeNull();
    expect(isGrammarTerm(d!.term)).toBe(true);
    expect(termMatchesRaw(d!.term, name)).toBe(true); // what Radarr / Sonarr test
    expect(termMatchesRaw(d!.term, foldReleaseName(name))).toBe(true); // a repost without the apostrophe or accent
    expect(d).toMatchObject({ confidence: 'verified', foldOnly: false });
  });

  it('the ledger pass over them counts no fold-only term (it counted every one before)', () => {
    const derived = rows.map(derive);
    expect(derived.filter((d) => d === null)).toHaveLength(0);
    expect(derived.filter((d) => d!.foldOnly)).toHaveLength(0);
  });

  it('a group term still blocks only that season, resolution and group', () => {
    const bob = derive(rows.find((r) => r[1] === "Bob's Burgers")!)!;
    expect(bob.shape).toBe('group');
    expect(termMatchesRaw(bob.term, "Bob's.Burgers.S11E09.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX")).toBe(true);
    expect(termMatchesRaw(bob.term, 'Bobs.Burgers.S11E09.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX')).toBe(true);
    expect(termMatchesRaw(bob.term, "Bob's.Burgers.S12E09.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX")).toBe(false);
    expect(termMatchesRaw(bob.term, "Bob's.Burgers.S11E09.2160p.DSNP.WEB-DL.DDP5.1.H.265-FLUX")).toBe(false);
    expect(termMatchesRaw(bob.term, "Bob's.Burgers.S11E09.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb")).toBe(false);
    const penguins = derive(rows.find((r) => r[3].startsWith('Los.Pingüinos'))!)!;
    expect(termMatchesRaw(penguins.term, 'Los.Pinguinos.de.Madagascar.S01E07.2021.MULTI.1080p.PMTP.WEB-DL.DD5.1.H.264-AndreMor')).toBe(true);
    expect(termMatchesRaw(penguins.term, 'Los.Pingüinos.de.Madagascar.S02E07.2021.MULTI.1080p.PMTP.WEB-DL.DD5.1.H.264-AndreMor')).toBe(false);
  });
});

describe('termWords and mergeTermWords (D-25dd)', () => {
  it('reads a name word for word like releaseTokens, with its apostrophes and accented letters', () => {
    expect(termWords("Bob's Burgers")).toEqual([{ text: 'bobs', joins: [3] }, { text: 'burgers' }]);
    expect(termWords('Los.Pingüinos.de')).toEqual([{ text: 'los' }, { text: 'pinguinos', accents: { 4: ['ü'] } }, { text: 'de' }]);
    expect(termWords('LÉON')).toEqual([{ text: 'leon', accents: { 1: ['é'] } }]);
    expect(termWords('Lilo & Stitch')).toEqual([{ text: 'lilo' }, { text: 'and' }, { text: 'stitch' }]);
    expect(termWords("Rock 'n' Roll")).toEqual([{ text: 'rock' }, { text: 'n' }, { text: 'roll' }]);
    expect(termWords("Rock'n'Roll")).toEqual([{ text: 'rocknroll', joins: [4, 5] }]);
    expect(termWords('Ame\u0301lie')).toEqual([{ text: 'amelie', accents: { 2: ['é'] } }]); // composed first
    for (const value of ["Amélie's Café & Bar", "Y'All.Thought", 'Straße ½ ﬁn', "O'Possum's.WEBDL-1080p"]) {
      expect(termWords(value).map((w) => w.text)).toEqual(releaseTokens(value));
    }
  });

  it('merges only a form that starts with the same words', () => {
    const release = termWords('Greys.Anatomy.S01');
    const title = termWords("Grey's Anatomy");
    expect(mergeTermWords(release.slice(0, 2), title)).toEqual([{ text: 'greys', joins: [4] }, { text: 'anatomy' }]);
    expect(mergeTermWords(release.slice(0, 2), termWords("Grey's"))).toEqual(release.slice(0, 2));
    expect(mergeTermWords(termWords('Pokemon'), termWords('Pokémon Ranger'))).toEqual([
      { text: 'pokemon', accents: { 3: ['é'] } },
    ]);
  });
});

describe('deriveTerm — shows, per season, group and resolution (D-12)', () => {
  const office = deriveTerm({
    kind: 'show',
    arrTitle: 'The Office (US)',
    arrYears: [2005],
    releaseNames: ['The.Office.US.S02.1080p.BluRay.x264-SHORTBREHD'],
    renamedFileName: null,
    releaseGroup: 'SHORTBREHD',
    resolution: 1080,
    remux: false,
    season: 2,
  })!;

  it('blocks the season pack and every episode of that season from that group at that resolution', () => {
    expect(termMatches(office.term, 'The.Office.US.S02.1080p.BluRay.x264-SHORTBREHD')).toBe(true);
    expect(termMatches(office.term, 'The.Office.US.S02E03.1080p.BluRay.x264-SHORTBREHD')).toBe(
      true,
    );
    expect(termMatches(office.term, 'The.Office.US.2005.S02E03.1080p.BluRay.x264-SHORTBREHD')).toBe(
      true,
    );
  });

  it('does not block another season, resolution or group', () => {
    expect(termMatches(office.term, 'The.Office.US.S20E03.1080p.BluRay.x264-SHORTBREHD')).toBe(
      false,
    );
    expect(termMatches(office.term, 'The.Office.US.S03E03.1080p.BluRay.x264-SHORTBREHD')).toBe(
      false,
    );
    expect(termMatches(office.term, 'The.Office.US.S02E03.720p.BluRay.x264-SHORTBREHD')).toBe(
      false,
    );
    expect(termMatches(office.term, 'The.Office.US.S02E03.1080p.BluRay.x264-OTHER')).toBe(false);
  });
});

describe('the grammar (D-12 / D-13 step 2)', () => {
  it('accepts every rendered form and the sentinel', () => {
    expect(isGrammarTerm(RELEASE_BLOCK_SENTINEL)).toBe(true);
    for (const parts of [
      {
        shape: 'movie_group',
        title: ['a'],
        years: [2020],
        resolution: 1080,
        remux: false,
        group: ['g'],
      },
      {
        shape: 'movie_group',
        title: ['a', 'b'],
        years: [2019, 2020],
        resolution: 2160,
        remux: true,
        group: ['e', 'dawn'],
      },
      {
        shape: 'show_group',
        title: ['a'],
        years: [2005],
        season: 12,
        resolution: 720,
        group: ['g'],
      },
      { shape: 'exact', tokens: ['a', 'b', '2020'] },
      // D-25dd: apostrophe joins, accented alternations and an optional `and`, in every form.
      {
        shape: 'movie_group',
        title: [{ text: 'bobs', joins: [3] }, 'and', { text: 'pokemon', accents: { 3: ['é', 'è'] } }],
        years: [2020],
        resolution: 1080,
        remux: false,
        group: ['g'],
      },
      {
        shape: 'show_group',
        title: ['lilo', 'and', 'stitch', { text: 'shogun', accents: { 2: ['ō'] }, joins: [4] }],
        years: [2003],
        season: 1,
        resolution: 1080,
        group: ['longweb'],
      },
      { shape: 'exact', tokens: [{ text: 'dont', joins: [3] }, 'and', { text: 'cafe', accents: { 3: ['é'] } }, 'x264'] },
    ] as unknown as Array<Parameters<typeof renderTerm>[0]>) {
      expect(isGrammarTerm(renderTerm(parts))).toBe(true);
    }
  });

  it('D-25dd: renders an apostrophe as SEP? (SEP* in the exact form), an accent as an alternation, an inner `and` as optional', () => {
    expect(
      renderTerm({
        shape: 'movie_group',
        title: [{ text: 'bobs', joins: [3] }, 'and', { text: 'cafe', accents: { 3: ['é'] } }, 'and'],
        years: [2020],
        resolution: 1080,
        remux: false,
        group: ['g'],
      }),
    ).toBe(
      '/^bob[^a-z0-9]?s[^a-z0-9]+(?:and[^a-z0-9]+)?caf(?:e|é)[^a-z0-9]+and[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]g(?:[^a-z0-9]|$)/i',
    );
    expect(renderTerm({ shape: 'exact', tokens: ['and', { text: 'dont', joins: [3] }, 'and', 'x'] })).toBe(
      '/^and[^a-z0-9]*don[^a-z0-9]*t[^a-z0-9]*(?:and[^a-z0-9]*)?x(?:[^a-z0-9]|$)/i',
    );
  });

  it('refuses anything outside the templates before any write', () => {
    for (const bad of [
      '/^foo.*/i', // an unknown construct
      '/^foo[^a-z0-9]*bar(?:[^a-z0-9]|$)/im', // another flag
      '/^foo[^a-z0-9]*bar(?:[^a-z0-9]|$)/', // no flag
      '/^fo(o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // does not compile
      '/^foo[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1440p(?![a-z0-9])).*[^a-z0-9]grp(?:[^a-z0-9]|$)/i', // bad R
      '/^fo-o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // a non-alphanumeric token
      '/^f(?:o|.)o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // an alternation that is not an accented letter
      '/^f(?:o|ö|[)o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // … nor a single character
      '/^f(?:o|×)o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // … nor a letter (× is in Latin-1 but no letter)
      '/^foo[^a-z0-9]?bar(?:[^a-z0-9]|$)/i', // an apostrophe join is a title join, never the exact form's
      '/^foo[^a-z0-9]+(?:and[^a-z0-9]+)?2020[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]g[^a-z0-9]?x(?:[^a-z0-9]|$)/i', // SEP? in the group
      '/^foo[^a-z0-9]+(?:and[^a-z0-9]+)?[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]g(?:[^a-z0-9]|$)/i', // `and` with no word after it
      'plain term', // a plain term other than the sentinel
      '',
    ]) {
      expect(isGrammarTerm(bad)).toBe(false);
    }
  });

  it('renderTerm refuses parts outside the grammar', () => {
    expect(() => renderTerm({ shape: 'exact', tokens: ['a-b'] })).toThrow();
    // D-25dd: a join at a word's edge, an accent that does not fold to its letter, a non-letter, two characters.
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', joins: [0] }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', joins: [2] }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', accents: { 0: ['é'] } }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', accents: { 0: ['.'] } }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', accents: { 0: ['ää'] } }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: '1b', accents: { 0: ['¹'] } }] })).toThrow();
    expect(() => renderTerm({ shape: 'exact', tokens: [{ text: 'ab', accents: { 5: ['á'] } }] })).toThrow();
    expect(() =>
      renderTerm({
        shape: 'movie_group',
        title: ['a'],
        years: [],
        resolution: 1080,
        remux: false,
        group: ['g'],
      }),
    ).toThrow();
    expect(() =>
      renderTerm({
        shape: 'show_group',
        title: ['a'],
        years: [2020],
        season: 0,
        resolution: 1080,
        group: ['g'],
      }),
    ).toThrow();
  });

  it('compiles only a /pattern/i term, the way the *arr does', () => {
    expect(compileTerm('/^a/i')).not.toBeNull();
    expect(compileTerm('/^a/')).toBeNull();
    expect(compileTerm(RELEASE_BLOCK_SENTINEL)).toBeNull();
  });
});
