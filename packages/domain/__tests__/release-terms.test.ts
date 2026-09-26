// ADR-093 C-19 / DESIGN-052 D-12 (PLAN-072 S2) — the Release Block's "must not contain" terms, pure: derivation
// fixtures (the D-12 examples and the test-strategy list), the self-check fallback, and the whitelist grammar that
// the writer re-checks before every POST / PUT.
import { describe, expect, it } from 'vitest';
import {
  RELEASE_BLOCK_SENTINEL,
  compileTerm,
  deriveTerm,
  isGrammarTerm,
  parseReleaseGroup,
  parseReleaseName,
  releaseTokens,
  renderTerm,
  termMatches,
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

  it('apostrophes and & fold the same way in the term and in a scene name', () => {
    const d = deriveTerm(
      movie({
        arrTitle: "Don't Look Up",
        arrYears: [2021],
        releaseNames: ["Don't.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX"],
        releaseGroup: 'FLUX',
        resolution: 2160,
      }),
    )!;
    expect(d.term.startsWith('/^dont[^a-z0-9]+look[^a-z0-9]+up')).toBe(true);
    expect(
      termMatches(d.term, 'Dont.Look.Up.2021.2160p.NF.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX'),
    ).toBe(true);
    const amp = deriveTerm(
      movie({
        arrTitle: 'Fast & Furious',
        arrYears: [2009],
        releaseNames: ['Fast.and.Furious.2009.1080p.BluRay.x264-SPARKS'],
        releaseGroup: 'SPARKS',
        resolution: 1080,
      }),
    )!;
    expect(termMatches(amp.term, 'Fast & Furious 2009 1080p BluRay x264-SPARKS')).toBe(true);
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
    ] as unknown as Array<Parameters<typeof renderTerm>[0]>) {
      expect(isGrammarTerm(renderTerm(parts))).toBe(true);
    }
  });

  it('refuses anything outside the templates before any write', () => {
    for (const bad of [
      '/^foo.*/i', // an unknown construct
      '/^foo[^a-z0-9]*bar(?:[^a-z0-9]|$)/im', // another flag
      '/^foo[^a-z0-9]*bar(?:[^a-z0-9]|$)/', // no flag
      '/^fo(o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // does not compile
      '/^foo[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1440p(?![a-z0-9])).*[^a-z0-9]grp(?:[^a-z0-9]|$)/i', // bad R
      '/^fo-o[^a-z0-9]*bar(?:[^a-z0-9]|$)/i', // a non-alphanumeric token
      'plain term', // a plain term other than the sentinel
      '',
    ]) {
      expect(isGrammarTerm(bad)).toBe(false);
    }
  });

  it('renderTerm refuses parts outside the grammar', () => {
    expect(() => renderTerm({ shape: 'exact', tokens: ['a-b'] })).toThrow();
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
