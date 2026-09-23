// DESIGN-049 D-08 — title identity: the title_key preference order and every matchable key.
import { describe, expect, it } from 'vitest';
import { identityKeys, keysOf, nameKey, titleKeyFor, titleKeyRank } from '../src/identity';
import { normalizeTitle, stripTrailingTag } from '../src/normalize';

const SHOW_GUID = 'plex://show/5d9c086c46115600200aa2fe';
const MOVIE_GUID = 'plex://movie/5d776825880197001ec967c9';

describe('titleKeyFor (D-08 preference order)', () => {
  it('prefers the plex guid, then tvdb for a show, then imdb, then tmdb:show, then the name', () => {
    const show = {
      kind: 'show' as const,
      title: 'The Expanse',
      year: 2015,
      plexGuid: SHOW_GUID,
      tvdbId: 280619,
      tmdbId: 63639,
      imdbId: 'tt3230854',
    };
    expect(titleKeyFor(show)).toBe(`plex:${SHOW_GUID}`);
    expect(titleKeyFor({ ...show, plexGuid: null })).toBe('tvdb:280619');
    expect(titleKeyFor({ ...show, plexGuid: null, tvdbId: null })).toBe('imdb:tt3230854');
    expect(titleKeyFor({ ...show, plexGuid: null, tvdbId: null, imdbId: null })).toBe(
      'tmdb:show:63639',
    );
    expect(titleKeyFor({ kind: 'show', title: 'The Expanse', year: 2015 })).toBe(
      'name:expanse|2015',
    );
  });

  it('prefers the plex guid, then tmdb:movie, then imdb, then the name for a movie', () => {
    const movie = {
      kind: 'movie' as const,
      title: 'The Matrix',
      year: 1999,
      plexGuid: MOVIE_GUID,
      tmdbId: 603,
      imdbId: 'tt0133093',
    };
    expect(titleKeyFor(movie)).toBe(`plex:${MOVIE_GUID}`);
    expect(titleKeyFor({ ...movie, plexGuid: null })).toBe('tmdb:movie:603');
    expect(titleKeyFor({ ...movie, plexGuid: null, tmdbId: null })).toBe('imdb:tt0133093');
    expect(titleKeyFor({ kind: 'movie', title: 'The Matrix', year: 1999 })).toBe(
      'name:matrix|1999',
    );
  });

  it('never yields a plex key for a local:// item, a legacy agent guid or a guid of the other kind', () => {
    const base = { kind: 'show' as const, title: 'Hazbin Hotel', year: 2024, tvdbId: 400599 };
    expect(titleKeyFor({ ...base, plexGuid: 'local://12345' })).toBe('tvdb:400599');
    expect(titleKeyFor({ ...base, plexGuid: 'com.plexapp.agents.thetvdb://400599?lang=en' })).toBe(
      'tvdb:400599',
    );
    expect(titleKeyFor({ ...base, plexGuid: 'plex://movie/abc' })).toBe('tvdb:400599');
    expect(titleKeyFor({ ...base, plexGuid: 'plex://episode/abc' })).toBe('tvdb:400599');
    expect(
      titleKeyFor({ kind: 'show', title: 'Hazbin Hotel', year: 2024, plexGuid: 'local://9' }),
    ).toBe('name:hazbin hotel|2024');
  });

  it('builds the name key from the normalized title and the year (or the title year hint)', () => {
    expect(nameKey('The Office (US)', 2005)).toBe('name:office us|2005');
    expect(nameKey('Dune (2021)')).toBe('name:dune|2021');
    expect(nameKey('Dune')).toBe('name:dune|');
    expect(nameKey('Blade Runner 2049', 2017)).toBe('name:blade runner 2049|2017');
    expect(nameKey('Pokémon: Detective Pikachu', 2019)).toBe('name:pokemon detective pikachu|2019');
  });
});

describe('identityKeys', () => {
  it('lists every key strongest first and always contains the title key', () => {
    const ids = {
      kind: 'show' as const,
      title: 'Severance',
      year: 2022,
      plexGuid: SHOW_GUID,
      tvdbId: 371980,
      tmdbId: 95396,
      imdbId: 'TT11280740',
    };
    const keys = identityKeys(ids);
    expect(keys).toEqual([
      `plex:${SHOW_GUID}`,
      'tvdb:371980',
      'tmdb:show:95396',
      'imdb:tt11280740',
      'name:severance|2022',
    ]);
    expect(keys).toContain(titleKeyFor(ids));
    expect(identityKeys({ kind: 'movie', title: 'Dune', year: 2021 })).toEqual(['name:dune|2021']);
  });

  it('ignores a tvdb id on a movie and malformed ids', () => {
    expect(
      identityKeys({
        kind: 'movie',
        title: 'X',
        year: 2020,
        tvdbId: 5,
        tmdbId: 0,
        imdbId: 'nm123',
      }),
    ).toEqual(['name:x|2020']);
    expect(identityKeys({ kind: 'show', title: 'X', year: 2020, tvdbId: 1.5, tmdbId: -3 })).toEqual(
      ['name:x|2020'],
    );
  });

  it('keysOf adds a stored title key its ids no longer produce', () => {
    expect(
      keysOf({ kind: 'movie', title: 'Dune', year: 2021, titleKey: 'tmdb:movie:438631' }),
    ).toEqual(['name:dune|2021', 'tmdb:movie:438631']);
  });

  it('ranks keys so a writer can tell a stronger key (re-keying, D-08)', () => {
    const ordered = ['plex:plex://show/a', 'tvdb:1', 'imdb:tt1', 'tmdb:show:1', 'name:x|', 'odd'];
    expect(ordered.map(titleKeyRank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(titleKeyRank('tmdb:movie:1')).toBe(1);
  });
});

describe('normalizeTitle (D-13)', () => {
  it.each([
    ['The Office (US)', 'office us', null],
    ['Dune (2021)', 'dune', 2021],
    ['dune 2021', 'dune 2021', 2021],
    ['Blade Runner 2049', 'blade runner 2049', 2049],
    ['1917', '1917', null],
    ['Pokémon: Detective Pikachu', 'pokemon detective pikachu', null],
    ['Law & Order: Special Victims Unit', 'law and order special victims unit', null],
    ["Marvel's Agents of S.H.I.E.L.D.", 'marvels agents of shield', null],
    ['A Quiet Place', 'quiet place', null],
    ['An Education', 'education', null],
    ['  The   Expanse  ', 'expanse', null],
    ['The', 'the', null],
    ['Spider-Man: No Way Home', 'spider man no way home', null],
  ])('%s → %s (%s)', (input, norm, year) => {
    expect(normalizeTitle(input)).toEqual({ norm, year });
  });

  it('strips one trailing country tag or year, never the whole title', () => {
    expect(stripTrailingTag('office us')).toBe('office');
    expect(stripTrailingTag('office uk')).toBe('office');
    expect(stripTrailingTag('dune 2021')).toBe('dune');
    expect(stripTrailingTag('say it')).toBe('say it');
    expect(stripTrailingTag('us')).toBe('us');
    expect(stripTrailingTag('1917')).toBe('1917');
  });
});
