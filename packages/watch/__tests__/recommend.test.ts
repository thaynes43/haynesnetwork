// ADR-089 / DESIGN-049 D-16..D-19 — genres, the Taste Profile, the exclusion sets, the hard
// exclusions, candidate merging, the score, the reason and deterministic ordering.
import { describe, expect, it } from 'vitest';
import { canonicalGenre, canonicalGenres } from '../src/genres';
import {
  buildExclusions,
  buildTasteProfile,
  candidateQuality,
  excludeCandidates,
  genreExemplars,
  isEverWatched,
  isStarted,
  mergeCandidates,
  pickRecommendations,
  scoreCandidates,
  titleWeight,
  type HistoryFacts,
  type LiveMark,
  type ProfileTitle,
  type RecoCandidate,
} from '../src/recommend';
import { YEAR_SECONDS } from '../src/types';

const DAY = 86_400;
const NOW = Date.parse('2026-09-23T16:00:00Z') / 1000;

describe('canonicalGenre (the recommend genre parameter)', () => {
  it.each([
    ['sci-fi', 'sci-fi'],
    ['Sci Fi', 'sci-fi'],
    ['scifi', 'sci-fi'],
    ['Science Fiction', 'sci-fi'],
    ['science-fiction movies', 'sci-fi'],
    ['comedy', 'comedy'],
    ['funny', 'comedy'],
    ['comedies', 'comedy'],
    ['horror', 'horror'],
    ['scary', 'horror'],
    ['some scary movies', 'horror'],
    ['documentary', 'documentary'],
    ['docs', 'documentary'],
    ['animated', 'animation'],
    ['Animation', 'animation'],
    ['romantic', 'romance'],
    ['romance', 'romance'],
    ['thriller', 'thriller'],
    ['crime', 'crime'],
    ['a drama', 'drama'],
    ['action', 'action'],
    ['fantasy', 'fantasy'],
    ['mystery', 'mystery'],
    ['war', 'war'],
    ['westerns', 'western'],
    ['family', 'family'],
    ['kids', 'kids'],
    ["Children's", 'kids'],
    ['Talk Show', 'talk show'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalGenre(input)).toBe(expected);
  });

  it('is null for blank input', () => {
    expect(canonicalGenre('   ')).toBeNull();
  });

  it('splits compound source genres and de-duplicates', () => {
    expect(canonicalGenres(['Sci-Fi & Fantasy', 'Science Fiction', 'Drama'])).toEqual([
      'sci-fi',
      'fantasy',
      'drama',
    ]);
    expect(canonicalGenres(['Action/Adventure'])).toEqual(['action', 'adventure']);
    expect(canonicalGenres(['Home and Garden', 'Children'])).toEqual(['home and garden', 'kids']);
    expect(canonicalGenres(null)).toEqual([]);
  });
});

function profileTitle(extra: Partial<ProfileTitle>): ProfileTitle {
  return {
    kind: 'movie',
    title: 'Untitled',
    genres: ['Drama'],
    isKids: false,
    everWatched: true,
    dismissed: null,
    lastWatchedAt: NOW,
    ...extra,
  };
}

describe('titleWeight (D-16)', () => {
  it('halves every twelve months', () => {
    expect(titleWeight(profileTitle({}), NOW)).toBe(1);
    expect(titleWeight(profileTitle({ lastWatchedAt: NOW - YEAR_SECONDS }), NOW)).toBeCloseTo(
      0.5,
      12,
    );
    expect(titleWeight(profileTitle({ lastWatchedAt: NOW - 2 * YEAR_SECONDS }), NOW)).toBeCloseTo(
      0.25,
      12,
    );
    expect(titleWeight(profileTitle({ lastWatchedAt: null }), NOW)).toBe(0);
  });

  it('weighs a show by completion, at least 0.25 once three episodes are watched', () => {
    const show = (w: number, t: number, ev = 0) =>
      titleWeight(
        profileTitle({
          kind: 'show',
          episodesWatched: w,
          episodesTotal: t,
          eventWatchedEpisodes: ev,
        }),
        NOW,
      );
    expect(show(5, 10)).toBe(0.5);
    expect(show(3, 100)).toBe(0.25);
    expect(show(2, 100)).toBe(0.02);
    expect(show(2, 100, 3)).toBe(0.25);
    // Gone from Plex (Maintainerr) but in the event log.
    expect(show(0, 0, 10)).toBe(0.25);
    expect(show(0, 0, 2)).toBe(0);
  });
});

describe('buildTasteProfile (D-16)', () => {
  it('weights by recency, splits a title over its genres and normalizes to 1', () => {
    const p = buildTasteProfile(
      [
        profileTitle({ title: 'A', genres: ['Drama'] }),
        profileTitle({ title: 'B', genres: ['Comedy'], lastWatchedAt: NOW - YEAR_SECONDS }),
        profileTitle({
          title: 'C',
          kind: 'show',
          genres: ['Drama', 'Crime'],
          episodesWatched: 5,
          episodesTotal: 10,
        }),
      ],
      NOW,
    );
    // drama 1 + 0.25, comedy 0.5, crime 0.25 → total 2
    expect(p.adult.drama).toBeCloseTo(0.625, 12);
    expect(p.adult.comedy).toBeCloseTo(0.25, 12);
    expect(p.adult.crime).toBeCloseTo(0.125, 12);
    expect(Object.values(p.adult).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
    expect(p.kids).toEqual({});
  });

  it('leaves out not_mine and never-watched titles', () => {
    const base = [profileTitle({ genres: ['Drama'] })];
    const withNoise = [
      ...base,
      profileTitle({ genres: ['Horror'], dismissed: 'not_mine' }),
      profileTitle({ genres: ['Western'], everWatched: false }),
    ];
    expect(buildTasteProfile(withNoise, NOW)).toEqual(buildTasteProfile(base, NOW));
  });

  it('subtracts half of a not_interested title, floored at zero', () => {
    const p = buildTasteProfile(
      [
        profileTitle({ genres: ['Drama'] }),
        profileTitle({ genres: ['Comedy'], lastWatchedAt: NOW - YEAR_SECONDS }),
        profileTitle({ genres: ['Drama'], dismissed: 'not_interested' }),
        profileTitle({ genres: ['Horror'], dismissed: 'not_interested' }),
      ],
      NOW,
    );
    expect(p.adult).toEqual({ comedy: 0.5, drama: 0.5 });

    const floored = buildTasteProfile(
      [
        profileTitle({ genres: ['Drama'] }),
        profileTitle({ genres: ['Drama', 'War'] }),
        profileTitle({ genres: ['Drama'], dismissed: 'not_interested' }),
        profileTitle({ genres: ['Drama'], dismissed: 'not_interested' }),
        profileTitle({ genres: ['Drama'], dismissed: 'not_interested' }),
      ],
      NOW,
    );
    expect(floored.adult).toEqual({ war: 1 });
  });

  it('builds a separate children’s profile', () => {
    const p = buildTasteProfile(
      [
        profileTitle({ genres: ['Drama'] }),
        profileTitle({
          kind: 'show',
          genres: ['Animation', 'Kids'],
          isKids: true,
          episodesWatched: 40,
          episodesTotal: 40,
        }),
      ],
      NOW,
    );
    expect(p.adult).toEqual({ drama: 1 });
    expect(p.kids).toEqual({ animation: 0.5, kids: 0.5 });
  });
});

describe('genreExemplars (the "<genre> like <title>" input)', () => {
  it('names the most-watched title per genre, newest on a tie, children separately', () => {
    const ex = genreExemplars([
      profileTitle({
        kind: 'show',
        title: 'The Expanse',
        genres: ['Science Fiction'],
        episodesWatched: 62,
      }),
      profileTitle({
        kind: 'show',
        title: 'Foundation',
        genres: ['Sci-Fi', 'Drama'],
        episodesWatched: 10,
      }),
      profileTitle({ title: 'Dune', genres: ['Science Fiction'] }),
      profileTitle({
        kind: 'show',
        title: 'Old Drama',
        genres: ['Drama'],
        episodesWatched: 10,
        lastWatchedAt: NOW - 50 * DAY,
      }),
      profileTitle({
        kind: 'show',
        title: 'Dismissed',
        genres: ['Drama'],
        episodesWatched: 99,
        dismissed: 'not_interested',
      }),
      profileTitle({
        kind: 'show',
        title: 'Bluey',
        genres: ['Kids'],
        isKids: true,
        episodesWatched: 150,
      }),
    ]);
    expect(ex.adult).toEqual({ drama: 'Foundation', 'sci-fi': 'The Expanse' });
    expect(ex.kids).toEqual({ kids: 'Bluey' });
  });
});

function facts(extra: Partial<HistoryFacts> & Pick<HistoryFacts, 'kind' | 'title'>): HistoryFacts {
  return { titleKey: `name:${extra.title}|`, year: 2020, ...extra };
}

describe('buildExclusions (D-10 Ever Watched, D-18 started and dismissed)', () => {
  const titles: HistoryFacts[] = [
    facts({ kind: 'show', title: 'T1', tvdbId: 1, episodesWatched: 3 }),
    facts({ kind: 'movie', title: 'T2', tmdbId: 2, plexWatched: true }),
    facts({ kind: 'show', title: 'T3', tvdbId: 3, eventWatched: true }),
    facts({ kind: 'movie', title: 'T4', tmdbId: 4, resumePercent: 40 }),
    facts({ kind: 'show', title: 'T5', tvdbId: 5, nextResume: true }),
    facts({ kind: 'show', title: 'T6', tvdbId: 6, episodesWatched: 2 }),
    facts({ kind: 'movie', title: 'T7', tmdbId: 7, imdbId: 'tt7' }),
    facts({ kind: 'show', title: 'T8', tvdbId: 8, tmdbId: 88 }),
  ];
  const marks: LiveMark[] = [
    { kind: 'show', title: 'T6', year: 2020, tvdbId: 6, titleKey: 'tvdb:6', action: 'not_mine' },
    {
      kind: 'movie',
      title: 'T7 (other spelling)',
      imdbId: 'tt7',
      titleKey: 'imdb:tt7',
      action: 'watched',
    },
    { kind: 'show', title: 'T8', tmdbId: 88, titleKey: 'tmdb:show:88', action: 'not_interested' },
    {
      kind: 'movie',
      title: 'Dark Matter',
      year: 2024,
      tmdbId: 9,
      titleKey: 'tmdb:movie:9',
      action: 'watched',
    },
  ];
  const ex = buildExclusions(titles, marks);

  it('puts Ever Watched titles and watched marks in everWatched, minus not_mine', () => {
    for (const key of ['tvdb:1', 'tmdb:movie:2', 'tvdb:3', 'tmdb:movie:9', 'imdb:tt7']) {
      expect(ex.everWatched.has(key)).toBe(true);
    }
    // The watched mark knew only the IMDb id; the Title State's TMDB key joins through it.
    expect(ex.everWatched.has('tmdb:movie:7')).toBe(true);
    expect(ex.everWatched.has('tvdb:6')).toBe(false);
    expect(ex.everWatched.has('tmdb:movie:4')).toBe(false);
  });

  it('puts started shows and movies in started', () => {
    for (const key of ['tvdb:1', 'tmdb:movie:4', 'tvdb:5', 'tvdb:6'])
      expect(ex.started.has(key)).toBe(true);
    expect(ex.started.has('tvdb:3')).toBe(false);
  });

  it('expands dismissals to every key of the titles they cover', () => {
    expect(ex.notMine.has('tvdb:6')).toBe(true);
    expect(ex.notInterested.has('tmdb:show:88')).toBe(true);
    expect(ex.notInterested.has('tvdb:8')).toBe(true);
  });

  it('exposes the Ever Watched and started rules', () => {
    expect(isEverWatched({ episodesWatched: 0, plexWatched: false, eventWatched: false })).toBe(
      false,
    );
    expect(isEverWatched({ eventWatched: true }, { notMine: true })).toBe(false);
    expect(isEverWatched({}, { watched: true })).toBe(true);
    expect(isStarted({ kind: 'movie', resumePercent: 0 })).toBe(false);
    expect(isStarted({ kind: 'show', episodesWatched: 0, nextResume: true })).toBe(true);
  });
});

function candidate(extra: Partial<RecoCandidate> & Pick<RecoCandidate, 'title'>): RecoCandidate {
  return {
    kind: 'show',
    titleKey: `name:${extra.title}|`,
    year: 2021,
    genres: ['Drama'],
    onPlex: true,
    ...extra,
  };
}

describe('excludeCandidates (D-18)', () => {
  const ex = {
    everWatched: new Set(['tvdb:1']),
    started: new Set(['tmdb:movie:2']),
    notInterested: new Set(['imdb:tt3']),
    notMine: new Set(['tvdb:4']),
  };

  it('drops any candidate sharing a key with any set, keeping input order', () => {
    const cands = [
      candidate({ title: 'Keep A', tvdbId: 10 }),
      candidate({ title: 'Watched', tvdbId: 1 }),
      candidate({ title: 'Started', kind: 'movie', tmdbId: 2 }),
      candidate({ title: 'Not interested', imdbId: 'tt3' }),
      candidate({ title: 'Not mine', tvdbId: 4 }),
      candidate({ title: 'Keep B', tvdbId: 11 }),
    ];
    expect(excludeCandidates(cands, ex, { kids: false }).map((c) => c.title)).toEqual([
      'Keep A',
      'Keep B',
    ]);
  });

  it('drops the same title from another source through a shared key (group-aware)', () => {
    const seedOnly = candidate({
      title: 'Watched, per TMDB',
      titleKey: 'tmdb:show:100',
      tmdbId: 100,
      onPlex: false,
    });
    const library = candidate({ title: 'Watched', titleKey: 'tvdb:1', tvdbId: 1, tmdbId: 100 });
    expect(excludeCandidates([seedOnly, library], ex, { kids: false })).toEqual([]);
  });

  it('keeps only grown-up titles by default and only children’s titles for kids', () => {
    const cands = [
      candidate({ title: 'Grown-up', tvdbId: 20 }),
      candidate({ title: 'Kids by genre', tvdbId: 21, genres: ['Kids'] }),
      candidate({ title: 'Kids by rating', tvdbId: 22, contentRating: 'TV-Y7' }),
      candidate({ title: 'Kids by flag', tvdbId: 23, isKids: true }),
    ];
    const none = {
      everWatched: new Set<string>(),
      started: new Set<string>(),
      notInterested: new Set<string>(),
      notMine: new Set<string>(),
    };
    expect(excludeCandidates(cands, none, { kids: false }).map((c) => c.title)).toEqual([
      'Grown-up',
    ]);
    expect(excludeCandidates(cands, none, { kids: true }).map((c) => c.title)).toEqual([
      'Kids by genre',
      'Kids by rating',
      'Kids by flag',
    ]);
  });

  it('judges a title by all its sources: Animation from one and Family from another make a kids movie', () => {
    const none = {
      everWatched: new Set<string>(),
      started: new Set<string>(),
      notInterested: new Set<string>(),
      notMine: new Set<string>(),
    };
    const cands = [
      candidate({ title: 'Luca', kind: 'movie', tmdbId: 508943, genres: ['Animation', 'Comedy'] }),
      candidate({
        title: 'Luca',
        kind: 'movie',
        tmdbId: 508943,
        genres: ['Family'],
        onPlex: false,
      }),
    ];
    expect(excludeCandidates(cands, none, { kids: false })).toEqual([]);
    expect(excludeCandidates(cands, none, { kids: true })).toHaveLength(2);
    expect(mergeCandidates(cands)[0]?.isKids).toBe(true);
  });
});

describe('mergeCandidates', () => {
  const library = candidate({
    title: 'Severance',
    year: 2022,
    titleKey: 'tvdb:371980',
    tvdbId: 371980,
    tmdbId: 95396,
    genres: ['Drama'],
    ratings: { imdb: 8.7 },
    addedAt: NOW - 100 * DAY,
  });
  const watchlist = candidate({
    title: 'Severance',
    year: 2022,
    titleKey: 'plex:plex://show/5f5a',
    plexGuid: 'plex://show/5f5a',
    tmdbId: 95396,
    genres: ['Drama', 'Mystery'],
    onPlex: false,
    watchlist: true,
  });
  const seed = candidate({
    title: 'Severance',
    year: 2022,
    titleKey: 'tmdb:show:95396',
    tmdbId: 95396,
    genres: ['Mystery', 'Sci-Fi & Fantasy'],
    onPlex: false,
    ratings: { tmdb: 8.4 },
    seeds: [{ titleKey: 'plex:silo', title: 'Silo', lastWatchedAt: NOW - DAY }],
  });

  it('merges one title from three sources into one candidate', () => {
    const [merged, ...rest] = mergeCandidates([library, watchlist, seed]);
    expect(rest).toEqual([]);
    expect(merged).toMatchObject({
      titleKey: 'plex:plex://show/5f5a',
      plexGuid: 'plex://show/5f5a',
      tvdbId: 371980,
      tmdbId: 95396,
      onPlex: true,
      watchlist: true,
      addedAt: NOW - 100 * DAY,
      ratings: { imdb: 8.7, tmdb: 8.4, rottenTomatoes: null },
      genres: ['Drama', 'Mystery', 'Sci-Fi & Fantasy'],
      seeds: [{ titleKey: 'plex:silo', title: 'Silo', lastWatchedAt: NOW - DAY }],
    });
  });

  it('does not depend on input order', () => {
    expect(mergeCandidates([seed, watchlist, library])).toEqual(
      mergeCandidates([library, watchlist, seed]),
    );
  });

  it('never merges a show and a movie through a shared name', () => {
    const show = candidate({ title: 'Shogun', year: 1980, kind: 'show' });
    const film = candidate({ title: 'Shogun', year: 1980, kind: 'movie' });
    expect(mergeCandidates([show, film])).toHaveLength(2);
  });
});

describe('scoreCandidates (D-19)', () => {
  const profile = { 'sci-fi': 0.5, drama: 0.3, comedy: 0.2 };
  const genreTitles = {
    'sci-fi': 'The Expanse',
    drama: 'Succession',
    comedy: 'Parks and Recreation',
    kids: 'Bluey',
  };

  it('computes 0.45 × affinity + 0.30 × quality + boosts', () => {
    const [pick] = scoreCandidates(
      [
        candidate({
          title: 'Foundation',
          genres: ['Science Fiction', 'Drama'],
          ratings: { imdb: 8, tmdb: 7, rottenTomatoes: 90 },
          watchlist: true,
          seeds: [
            { titleKey: 'a', title: 'The Expanse', lastWatchedAt: NOW - 10 * DAY },
            { titleKey: 'b', title: 'Silo', lastWatchedAt: NOW - DAY },
          ],
          addedAt: NOW - 10 * DAY,
        }),
      ],
      profile,
      { now: NOW, genreTitles },
    );
    expect(pick?.affinity).toBeCloseTo(0.8, 12);
    expect(pick?.quality).toBeCloseTo(0.8, 12);
    expect(pick?.boost).toBeCloseTo(0.65, 12);
    expect(pick?.score).toBeCloseTo(1.25, 12);
    expect(pick?.reason).toBe('on your watchlist');
  });

  it('uses 0.6 quality without ratings, caps affinity and seed agreement', () => {
    expect(candidateQuality(null)).toBe(0.6);
    expect(candidateQuality({ imdb: 0, tmdb: null })).toBe(0.6);
    const seeds = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        titleKey: `s${i}`,
        title: `S${i}`,
        lastWatchedAt: NOW,
      }));
    const picks = scoreCandidates(
      [
        candidate({ title: 'All genres', genres: ['Sci-Fi', 'Drama', 'Comedy', 'Horror'] }),
        candidate({ title: 'One seed', genres: ['Western'], seeds: seeds(1) }),
        candidate({ title: 'Five seeds', genres: ['Western'], seeds: seeds(5) }),
      ],
      profile,
      { now: NOW },
    );
    const by = Object.fromEntries(picks.map((p) => [p.candidate.title, p]));
    expect(by['All genres']?.affinity).toBe(1);
    expect(by['One seed']?.boost).toBeCloseTo(0.1, 12);
    expect(by['Five seeds']?.boost).toBeCloseTo(0.3, 12);
  });

  it('picks the reason in the D-19 order, with "new to you" last', () => {
    const picks = scoreCandidates(
      [
        candidate({
          title: 'Seeded',
          genres: ['Western'],
          seeds: [
            { titleKey: 'a', title: 'The Expanse', lastWatchedAt: NOW - 10 * DAY },
            { titleKey: 'b', title: 'Silo', lastWatchedAt: NOW - DAY },
          ],
        }),
        candidate({ title: 'Genre', genres: ['Science Fiction', 'Drama'], ratings: { imdb: 9 } }),
        candidate({ title: 'Rated', genres: ['Western'], ratings: { imdb: 7.25 } }),
        candidate({ title: 'Rated whole', genres: ['Western'], ratings: { imdb: 8 } }),
        candidate({ title: 'Fresh', genres: ['Western'], addedAt: NOW - 3 * DAY }),
        candidate({ title: 'Plain', genres: [] }),
        candidate({ title: 'Bluey-ish', genres: ['Kids'] }),
      ],
      profile,
      { now: NOW, genreTitles },
    );
    const reasons = Object.fromEntries(picks.map((p) => [p.candidate.title, p.reason]));
    expect(reasons).toEqual({
      Seeded: 'because you watched Silo',
      Genre: 'sci-fi like The Expanse',
      Rated: 'rated 7.3 on IMDb',
      'Rated whole': 'rated 8 on IMDb',
      Fresh: 'new on Plex',
      Plain: 'new to you',
      'Bluey-ish': 'for kids, like Bluey',
    });
  });

  it('names the strongest shared genre, drama only when nothing else is shared', () => {
    const dramaHeavy = { drama: 0.6, 'sci-fi': 0.1, comedy: 0.3 };
    const picks = scoreCandidates(
      [
        candidate({ title: 'Andor', genres: ['Sci-Fi & Fantasy', 'Drama'] }),
        candidate({ title: 'Succession-like', genres: ['Drama'] }),
        candidate({ title: 'Dramedy', genres: ['Drama', 'Comedy', 'Science Fiction'] }),
      ],
      dramaHeavy,
      { now: NOW, genreTitles },
    );
    const reasons = Object.fromEntries(picks.map((p) => [p.candidate.title, p.reason]));
    expect(reasons).toEqual({
      Andor: 'sci-fi like The Expanse',
      'Succession-like': 'drama like Succession',
      Dramedy: 'comedy like Parks and Recreation',
    });
  });

  it('names the requested genre in the reason and filters by genre and kind', () => {
    const cands = [
      candidate({ title: 'Both', genres: ['Science Fiction', 'Drama'] }),
      candidate({ title: 'Comedy film', kind: 'movie', genres: ['Comedy'] }),
    ];
    const drama = scoreCandidates(cands, profile, { now: NOW, genre: 'dramas', genreTitles });
    expect(drama.map((p) => [p.candidate.title, p.reason])).toEqual([
      ['Both', 'drama like Succession'],
    ]);
    expect(
      scoreCandidates(cands, profile, { now: NOW, kind: 'movie' }).map((p) => p.candidate.title),
    ).toEqual(['Comedy film']);
    expect(scoreCandidates(cands, profile, { now: NOW, kind: 'any' })).toHaveLength(2);
  });

  it('breaks ties on quality, then title', () => {
    const picks = scoreCandidates(
      [
        candidate({ title: 'Beta', genres: [], ratings: { imdb: 7 } }),
        candidate({ title: 'alpha', genres: [], ratings: { imdb: 7 } }),
        candidate({ title: 'Gamma', genres: ['Drama'], ratings: { imdb: 5 } }),
        candidate({ title: 'Delta', genres: [], ratings: { imdb: 8 } }),
      ],
      { drama: 1 },
      { now: NOW },
    );
    // Gamma: 0.45 + 0.15 = 0.60; Delta 0.24; alpha/Beta 0.21 each → title order.
    expect(picks.map((p) => p.candidate.title)).toEqual(['Gamma', 'Delta', 'alpha', 'Beta']);
  });

  it('is deterministic: shuffled input, same output', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pool = ['Drama', 'Comedy', 'Science Fiction', 'Horror', 'Western'];
    const cands = Array.from({ length: 40 }, (_, i) =>
      candidate({
        title: `Title ${i % 13}`,
        titleKey: `tvdb:${1000 + i}`,
        tvdbId: 1000 + i,
        year: 2000 + (i % 7),
        genres: pool.filter(() => rand() < 0.4),
        ratings: rand() < 0.5 ? { imdb: Math.round(rand() * 100) / 10 } : null,
        watchlist: rand() < 0.2,
        onPlex: rand() < 0.8,
        addedAt: rand() < 0.3 ? NOW - Math.floor(rand() * 40) * DAY : null,
      }),
    );
    const expected = scoreCandidates(cands, profile, { now: NOW, genreTitles });
    for (let round = 0; round < 20; round++) {
      const shuffled = [...cands];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as RecoCandidate, shuffled[i] as RecoCandidate];
      }
      expect(scoreCandidates(shuffled, profile, { now: NOW, genreTitles })).toEqual(expected);
    }
  });
});

describe('pickRecommendations (the pure recommend pipeline)', () => {
  it('excludes, merges, scores with the right profile and splits on Plex / not on Plex', () => {
    const profile = { adult: { drama: 1 }, kids: { kids: 1 } };
    const exclusions = {
      everWatched: new Set(['tvdb:1']),
      started: new Set<string>(),
      notInterested: new Set<string>(),
      notMine: new Set<string>(),
    };
    const candidates = [
      candidate({ title: 'Watched', titleKey: 'tvdb:1', tvdbId: 1 }),
      candidate({ title: 'Severance', titleKey: 'tvdb:2', tvdbId: 2, tmdbId: 22 }),
      candidate({
        title: 'Severance',
        titleKey: 'tmdb:show:22',
        tmdbId: 22,
        onPlex: false,
        watchlist: true,
      }),
      candidate({
        title: 'Dark Matter',
        titleKey: 'tmdb:show:33',
        tmdbId: 33,
        onPlex: false,
        watchlist: true,
      }),
      candidate({ title: 'Bluey', titleKey: 'tvdb:4', tvdbId: 4, genres: ['Kids'] }),
    ];
    const grownUp = pickRecommendations({ candidates, exclusions, profile, now: NOW });
    expect(grownUp.onPlex.map((p) => [p.candidate.title, p.reason])).toEqual([
      ['Severance', 'on your watchlist'],
    ]);
    expect(grownUp.notOnPlex.map((p) => p.candidate.title)).toEqual(['Dark Matter']);

    const kids = pickRecommendations({ candidates, exclusions, profile, now: NOW, kids: true });
    expect(kids.onPlex.map((p) => p.candidate.title)).toEqual(['Bluey']);
    expect(kids.onPlex[0]?.affinity).toBe(1);
  });
});
