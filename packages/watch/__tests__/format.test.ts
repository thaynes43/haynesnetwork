// DESIGN-049 D-21 / D-20 / D-14 / D-15 — the spoken answers: the design's example sentences, dates in
// the owner's calendar, "And N more.", the 1,200-character cap cut at a sentence boundary, and no
// markdown, emoji or URLs ever.
import { describe, expect, it } from 'vitest';
import {
  formatAmbiguous,
  formatDismissResult,
  formatMarkResult,
  formatNotFound,
  formatNotReady,
  formatRecentHistory,
  formatRecommendations,
  formatUndoResult,
  formatUnfinished,
  formatWatchError,
  formatWatchStatus,
  type MarkResultView,
  type UnfinishedItem,
  type WatchStatusView,
} from '../src/format';
import type { RecoCandidate, ScoredPick } from '../src/recommend';
import {
  SPOKEN_MAX_CHARS,
  capSpoken,
  capSpokenList,
  countWord,
  spokenDate,
  spokenSince,
  spokenTitle,
} from '../src/spoken';

const at = (iso: string) => Date.parse(iso) / 1000;
// Noon in New York on 2026-09-23.
const NOW = at('2026-09-23T16:00:00Z');
const opts = { now: NOW };

describe('spokenDate / spokenSince (D-21 dates, the owner’s calendar)', () => {
  it('says today, yesterday, a day this year, or a month and year', () => {
    expect(spokenDate(at('2026-09-23T04:30:00Z'), NOW)).toBe('today');
    // 23:30 on the 22nd in New York is still the 23rd in UTC: the owner's calendar wins.
    expect(spokenDate(at('2026-09-23T03:30:00Z'), NOW)).toBe('yesterday');
    expect(spokenDate(at('2026-09-23T03:30:00Z'), NOW, { timeZone: 'UTC' })).toBe('today');
    expect(spokenDate(at('2026-09-12T18:00:00Z'), NOW)).toBe('on September 12');
    expect(spokenDate(at('2026-01-01T18:00:00Z'), NOW)).toBe('on January 1');
    expect(spokenDate(at('2025-03-10T18:00:00Z'), NOW)).toBe('in March 2025');
    expect(spokenDate(at('2025-12-31T18:00:00Z'), NOW)).toBe('in December 2025');
  });

  it('phrases the same dates after "since"', () => {
    expect(spokenSince(at('2026-09-22T18:00:00Z'), NOW)).toBe('since yesterday');
    expect(spokenSince(at('2026-06-01T18:00:00Z'), NOW)).toBe('since June 1');
    expect(spokenSince(at('2025-03-10T18:00:00Z'), NOW)).toBe('since March 2025');
  });

  it('counts in words up to twenty', () => {
    expect([0, 1, 3, 20, 21].map((n) => countWord(n))).toEqual([
      'no',
      'one',
      'three',
      'twenty',
      '21',
    ]);
    expect(countWord(4, true)).toBe('Four');
  });
});

describe('capSpoken / capSpokenList (the 1,200-character cap)', () => {
  it('leaves short text alone and cuts long text at the last sentence that fits', () => {
    expect(capSpoken('One. Two.')).toBe('One. Two.');
    expect(capSpoken('One. Two. Three.', 10)).toBe('One. Two.');
    expect(capSpoken('Is it? Yes! No.', 12)).toBe('Is it? Yes!');
  });

  it('does not cut after an abbreviation or an initial', () => {
    expect(capSpoken('Watch Mr. Robot now. Then rest.', 25)).toBe('Watch Mr. Robot now.');
    expect(capSpoken('We saw S.W.A.T. last. Then more.', 26)).toBe('We saw S.W.A.T. last.');
  });

  it('falls back to a word boundary when no sentence fits, and never exceeds the cap', () => {
    const cut = capSpoken('word '.repeat(50), 23);
    expect(cut).toBe('word word word word.');
    let seed = 3;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 48271) % 2147483647;
      const max = 5 + (seed % 300);
      const text = Array.from(
        { length: 1 + (seed % 60) },
        (_, j) => `Sentence ${j} has words.`,
      ).join(' ');
      expect(capSpoken(text, max).length).toBeLessThanOrEqual(max);
    }
  });

  it('drops the tail first, then items from the end, and says how many it left out', () => {
    expect(
      capSpokenList({ lead: 'Lead.', items: ['Item one.', 'Item two.', 'Item three.'] }, 30),
    ).toBe('Lead. Item one. And 2 more.');
    expect(
      capSpokenList(
        { lead: 'Five picks.', items: ['A one.', 'B two.'], tail: ['Not on Plex yet: C.'] },
        30,
      ),
    ).toBe('Five picks. A one. B two.');
    expect(capSpokenList({ lead: 'Lead.', items: ['Item.'], more: 4 })).toBe(
      'Lead. Item. And 4 more.',
    );
  });
});

describe('formatUnfinished (D-21)', () => {
  const silo: UnfinishedItem = {
    kind: 'show',
    title: 'Silo',
    state: 'in_progress',
    lastWatchedAt: at('2026-09-20T23:00:00Z'),
    episodesWatched: 30,
    episodesTotal: 40,
    next: { season: 3, episode: 1 },
  };
  const fam: UnfinishedItem = {
    kind: 'show',
    title: 'For All Mankind',
    state: 'in_progress',
    lastWatchedAt: at('2026-09-12T23:00:00Z'),
    episodesWatched: 42,
    episodesTotal: 50,
    next: { season: 5, episode: 3 },
  };
  const gemstones: UnfinishedItem = {
    kind: 'show',
    title: 'The Righteous Gemstones',
    state: 'stalled',
    lastWatchedAt: at('2025-03-15T18:00:00Z'),
    episodesWatched: 36,
    episodesTotal: 45,
    next: { season: 4, episode: 1 },
  };

  it('reads like the design example, newest in-progress first, stalled last', () => {
    expect(formatUnfinished([gemstones, fam, silo], { ...opts, limit: 5 })).toBe(
      'Three unfinished shows. Silo: 30 of 40 watched, next is season 3 episode 1, last watched on ' +
        'September 20. For All Mankind: next is season 5 episode 3, on September 12. Stalled: The ' +
        'Righteous Gemstones, 36 of 45, untouched since March 2025.',
    );
  });

  it('lists at most `limit` and says how many more', () => {
    expect(formatUnfinished([gemstones, fam, silo], { ...opts, limit: 1 })).toBe(
      'Three unfinished shows. Silo: 30 of 40 watched, next is season 3 episode 1, last watched on ' +
        'September 20. And 2 more.',
    );
  });

  it('says so when nothing is unfinished', () => {
    expect(formatUnfinished([], { ...opts, limit: 5 })).toBe('No unfinished shows.');
    expect(formatUnfinished([], { ...opts, limit: 5, kind: 'movie' })).toBe(
      'No unfinished movies.',
    );
    expect(formatUnfinished([], { ...opts, limit: 5, kind: 'any' })).toBe('Nothing unfinished.');
  });

  it('flags a rewatch, a started next episode, a relative date and movies', () => {
    const rick: UnfinishedItem = {
      kind: 'show',
      title: 'Rick and Morty',
      state: 'in_progress',
      lastWatchedAt: at('2026-09-22T23:00:00Z'),
      episodesWatched: 28,
      episodesTotal: 106,
      next: { season: 3, episode: 7, resume: true },
      rewatch: true,
    };
    const dune: UnfinishedItem = {
      kind: 'movie',
      title: 'Dune: Part Two',
      state: 'in_progress',
      lastWatchedAt: at('2026-09-12T23:00:00Z'),
      resumePercent: 45.4,
    };
    const heat: UnfinishedItem = {
      kind: 'movie',
      title: 'Heat',
      state: 'stalled',
      lastWatchedAt: at('2025-01-10T23:00:00Z'),
      resumePercent: 30,
    };
    expect(formatUnfinished([heat, dune, rick, silo], { ...opts, limit: 5, kind: 'any' })).toBe(
      'Four unfinished: two shows and two movies. Rick and Morty (rewatch): 28 of 106 watched, resume ' +
        'season 3 episode 7, last watched yesterday. Silo: next is season 3 episode 1, on September 20. ' +
        'Dune: Part Two (movie): 45 percent in, on September 12. Stalled: Heat (movie), 30 percent in, ' +
        'untouched since January 2025.',
    );
  });

  it('stays under 1,200 characters on a long list and still says how many it skipped', () => {
    const many = Array.from({ length: 60 }, (_, i): UnfinishedItem => ({
      kind: 'show',
      title: `An Exceptionally Long Show Title Number ${i} With A Subtitle About Something Else Entirely`,
      state: 'in_progress',
      lastWatchedAt: NOW - i * 3600,
      episodesWatched: 3,
      episodesTotal: 90,
      next: { season: 1, episode: 4 },
    }));
    const text = formatUnfinished(many, { ...opts, limit: 10 });
    expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(text).toMatch(/^Sixty unfinished shows\.|^60 unfinished shows\./);
    expect(text).toMatch(/ And \d+ more\.$/);
  });
});

function pick(
  title: string,
  year: number | null,
  kind: 'show' | 'movie',
  reason: string,
  onPlex = true,
): ScoredPick {
  const candidate: RecoCandidate = {
    titleKey: `name:${title}`,
    kind,
    title,
    year,
    genres: [],
    onPlex,
  };
  return {
    candidate,
    score: 1,
    affinity: 0,
    quality: 0.6,
    boost: 0,
    reason,
    reasonKind: 'watchlist',
  };
}

describe('formatRecommendations (D-20/D-21)', () => {
  const onPlex = [
    pick('Foundation', 2021, 'show', 'because you watched The Expanse'),
    pick('Severance', 2022, 'show', 'on your watchlist'),
    pick('Andor', 2022, 'show', 'sci-fi like The Expanse'),
    pick('Oppenheimer', 2023, 'movie', 'rated 8.3 on IMDb'),
    pick('Shogun', 2024, 'show', 'new on Plex'),
  ];
  const notOnPlex = [pick('Dark Matter', 2024, 'show', 'on your watchlist', false)];

  it('reads like the design example', () => {
    expect(formatRecommendations({ onPlex, notOnPlex }, { limit: 5 })).toBe(
      'Five picks on Plex. Foundation, a 2021 show, because you watched The Expanse. Severance, a 2022 ' +
        'show, on your watchlist. Andor, a 2022 show, sci-fi like The Expanse. Oppenheimer, a 2023 ' +
        'movie, rated 8.3 on IMDb. Shogun, a 2024 show, new on Plex. Not on Plex yet: Dark Matter, a ' +
        '2024 show, on your watchlist.',
    );
  });

  it('says nothing matches when nothing survives', () => {
    expect(formatRecommendations({ onPlex: [], notOnPlex: [] }, { limit: 5 })).toBe(
      'Nothing new matches that. Try another genre or kind.',
    );
  });

  it('pages with offset, says how many more, and pages the not-on-Plex picks too', () => {
    const more = [
      ...onPlex,
      pick('Slow Horses', 2022, 'show', 'new to you'),
      pick('Heat', 1995, 'movie', 'new to you'),
    ];
    const off = ['A', 'B', 'C', 'D'].map((t) => pick(t, null, 'movie', 'on your watchlist', false));
    const first = formatRecommendations({ onPlex: more, notOnPlex: off }, { limit: 5 });
    expect(first).toContain(
      'Shogun, a 2024 show, new on Plex. And 2 more. Not on Plex yet: A, a movie',
    );
    expect(first).toContain('B, a movie, on your watchlist.');
    expect(first).not.toContain('C, a movie');
    expect(formatRecommendations({ onPlex: more, notOnPlex: off }, { limit: 5, offset: 5 })).toBe(
      'Two picks on Plex. Slow Horses, a 2022 show, new to you. Heat, a 1995 movie, new to you. Not on ' +
        'Plex yet: C, a movie, on your watchlist. D, a movie, on your watchlist.',
    );
    expect(formatRecommendations({ onPlex: more, notOnPlex: [] }, { limit: 5, offset: 10 })).toBe(
      'No more picks. Try another genre or kind.',
    );
  });

  it('names the genre, the audience and the kind in the lead', () => {
    expect(
      formatRecommendations(
        { onPlex: onPlex.slice(2, 3), notOnPlex: [] },
        { limit: 5, genre: 'scifi', kind: 'show' },
      ),
    ).toBe('One sci-fi show pick on Plex. Andor, a 2022 show, sci-fi like The Expanse.');
    expect(
      formatRecommendations(
        { onPlex: onPlex.slice(0, 2), notOnPlex: [] },
        { limit: 5, kids: true },
      ),
    ).toMatch(/^Two kids' picks on Plex\./);
    expect(formatRecommendations({ onPlex: [], notOnPlex }, { limit: 5 })).toBe(
      'No picks on Plex. Not on Plex yet: Dark Matter, a 2024 show, on your watchlist.',
    );
    expect(
      formatRecommendations(
        { onPlex: [pick('Tabu', 1893, 'movie', 'new to you')], notOnPlex: [] },
        { limit: 5 },
      ),
    ).toBe('One pick on Plex. Tabu, an 1893 movie, new to you.');
  });
});

function status(
  extra: Partial<WatchStatusView> & Pick<WatchStatusView, 'title' | 'state'>,
): WatchStatusView {
  return {
    kind: 'show',
    year: null,
    onPlex: true,
    everWatched: false,
    lastWatchedAt: null,
    ...extra,
  };
}

describe('formatWatchStatus (D-21)', () => {
  it.each([
    [
      status({
        title: 'The Expanse',
        year: 2015,
        state: 'finished',
        everWatched: true,
        episodesWatched: 62,
        episodesTotal: 62,
        lastWatchedAt: at('2025-03-08T02:00:00Z'),
      }),
      'The Expanse (2015 show): all 62 episodes watched, finished in March 2025. On Plex.',
    ],
    [
      status({
        title: 'Silo',
        year: 2023,
        state: 'in_progress',
        everWatched: true,
        episodesWatched: 30,
        episodesTotal: 40,
        next: { season: 3, episode: 1 },
        lastWatchedAt: at('2026-09-20T23:00:00Z'),
      }),
      'Silo (2023 show): 30 of 40 watched, next is season 3 episode 1, last watched on September 20. On Plex.',
    ],
    [
      status({
        title: 'Rick and Morty',
        year: 2013,
        state: 'stalled',
        everWatched: true,
        rewatch: true,
        episodesWatched: 28,
        episodesTotal: 106,
        next: { season: 3, episode: 7 },
        lastWatchedAt: at('2025-03-08T02:00:00Z'),
      }),
      'Rick and Morty (2013 show): rewatching, 28 of 106 watched, next is season 3 episode 7, untouched since March 2025. On Plex.',
    ],
    [
      status({
        title: 'Slow Horses',
        year: 2022,
        state: 'caught_up',
        everWatched: true,
        episodesWatched: 30,
        episodesTotal: 30,
        lastWatchedAt: at('2026-09-23T14:00:00Z'),
      }),
      'Slow Horses (2022 show): all 30 episodes watched, caught up, last watched today. On Plex.',
    ],
    [
      status({
        title: 'Breaking Bad',
        year: 2008,
        state: 'unstarted',
        onPlex: false,
        everWatched: true,
        eventWatchedEpisodes: 62,
        lastWatchedAt: at('2025-03-08T02:00:00Z'),
      }),
      'Breaking Bad (2008 show): watched 62 episodes before, last watched in March 2025. Not on Plex.',
    ],
    [
      status({
        title: 'Dark Matter',
        year: 2024,
        state: 'unstarted',
        onPlex: false,
        everWatched: true,
      }),
      'Dark Matter (2024 show): marked as watched. Not on Plex.',
    ],
    [
      status({ title: 'Pluribus', year: 2025, state: 'unstarted' }),
      'Pluribus (2025 show): not watched yet. On Plex.',
    ],
    [
      status({
        title: 'Bluey',
        year: 2018,
        state: 'caught_up',
        everWatched: false,
        dismissed: 'not_mine',
      }),
      "Bluey (2018 show): marked as someone else's viewing, so it isn't in your history. On Plex.",
    ],
    [
      status({
        title: "Grey's Anatomy",
        year: 2005,
        state: 'unstarted',
        dismissed: 'not_interested',
      }),
      "Grey's Anatomy (2005 show): not watched yet. You dismissed it, so it won't be suggested. On Plex.",
    ],
    [
      status({
        title: 'WarGames',
        year: 1983,
        kind: 'movie',
        state: 'finished',
        everWatched: true,
        lastWatchedAt: at('2026-09-05T23:00:00Z'),
      }),
      'WarGames (1983 movie): watched on September 5. On Plex.',
    ],
    [
      status({
        title: 'Dune: Part Two',
        year: 2024,
        kind: 'movie',
        state: 'in_progress',
        resumePercent: 45,
        lastWatchedAt: at('2026-09-22T23:00:00Z'),
      }),
      'Dune: Part Two (2024 movie): 45 percent in, last watched yesterday. On Plex.',
    ],
    [
      status({
        title: 'Heat',
        year: 1995,
        kind: 'movie',
        state: 'stalled',
        resumePercent: 30,
        lastWatchedAt: at('2025-03-08T02:00:00Z'),
      }),
      'Heat (1995 movie): 30 percent in, untouched since March 2025. On Plex.',
    ],
    [
      status({
        title: 'Ronin',
        year: 1998,
        kind: 'movie',
        state: 'unstarted',
        onPlex: false,
        everWatched: true,
        lastWatchedAt: at('2025-03-08T02:00:00Z'),
      }),
      'Ronin (1998 movie): watched in March 2025. Not on Plex.',
    ],
  ])('%#: %s', (view, expected) => {
    expect(formatWatchStatus(view, opts)).toBe(expected);
  });
});

describe('formatRecentHistory (D-21)', () => {
  const silo = {
    kind: 'show' as const,
    title: 'Silo',
    episodes: 5,
    latest: { season: 2, episode: 10 },
    lastAt: at('2026-09-20T23:00:00Z'),
  };
  const wargames = {
    kind: 'movie' as const,
    title: 'WarGames',
    lastAt: at('2026-09-05T23:00:00Z'),
  };

  it('reads like the design example, newest first', () => {
    expect(formatRecentHistory([wargames, silo], { ...opts, days: 14, limit: 8 })).toBe(
      'In the last two weeks: Silo, 5 episodes, latest season 2 episode 10 on September 20. WarGames, a ' +
        'movie, on September 5.',
    );
  });

  it('names one episode directly, phrases the window, and caps the list', () => {
    const one = { ...silo, episodes: 1, lastAt: at('2026-09-23T14:00:00Z') };
    expect(formatRecentHistory([one], { ...opts, days: 7, limit: 8 })).toBe(
      'In the last week: Silo, season 2 episode 10, today.',
    );
    expect(formatRecentHistory([], { ...opts, days: 14, limit: 8 })).toBe(
      'Nothing watched in the last two weeks.',
    );
    expect(formatRecentHistory([], { ...opts, days: 45, limit: 8 })).toBe(
      'Nothing watched in the last 45 days.',
    );
    expect(formatRecentHistory([], { ...opts, days: 365, limit: 8 })).toBe(
      'Nothing watched in the last year.',
    );
    expect(formatRecentHistory([wargames, silo], { ...opts, days: 14, limit: 1 })).toMatch(
      /September 20\. And 1 more\.$/,
    );
  });
});

describe('formatMarkResult (D-14 read-back)', () => {
  const severance = { kind: 'show' as const, title: 'Severance', year: 2022 };
  const cases: Array<[MarkResultView, string]> = [
    [
      { ...severance, scope: 'show', plexResult: 'written', episodes: 19, flipped: 19 },
      'Marked Severance (2022) as watched in Plex, all 19 episodes.',
    ],
    [
      { kind: 'show', title: 'Dark Matter', year: 2024, scope: 'show', plexResult: 'not_on_plex' },
      "Noted Dark Matter (2024) as watched. It isn't on Plex, so only your history changed.",
    ],
    [
      { ...severance, scope: 'season', season: 2, plexResult: 'written', episodes: 10, flipped: 4 },
      'Marked season 2 of Severance (2022) as watched in Plex, 10 episodes.',
    ],
    [
      { ...severance, scope: 'episode', season: 2, episode: 3, plexResult: 'written', flipped: 1 },
      'Marked Severance (2022) season 2 episode 3 as watched in Plex.',
    ],
    [
      {
        ...severance,
        scope: 'through',
        season: 2,
        episode: 3,
        plexResult: 'written',
        episodes: 13,
        flipped: 5,
      },
      'Marked Severance (2022) as watched in Plex through season 2 episode 3, 13 episodes.',
    ],
    [
      {
        kind: 'movie',
        title: 'WarGames',
        year: 1983,
        scope: 'movie',
        plexResult: 'written',
        flipped: 1,
      },
      'Marked WarGames (1983) as watched in Plex.',
    ],
    [
      { ...severance, scope: 'show', plexResult: 'none', episodes: 19, flipped: 0 },
      'Severance (2022) was already watched in Plex, all 19 episodes.',
    ],
    [
      { ...severance, scope: 'season', season: 2, plexResult: 'written', episodes: 10, flipped: 0 },
      'Season 2 of Severance (2022) was already watched in Plex, 10 episodes.',
    ],
    [
      { ...severance, scope: 'show', plexResult: 'partial', episodes: 19, flipped: 12 },
      'Marked Severance (2022) as watched, but only part of it reached Plex. Say it again to retry the rest.',
    ],
    [
      { ...severance, scope: 'show', plexResult: 'failed', episodes: 19, flipped: 0 },
      "Noted Severance (2022) as watched in your history, but Plex didn't take the change. Try again in a minute.",
    ],
  ];
  it.each(cases)('%#: %s', (view, expected) => {
    expect(formatMarkResult(view)).toBe(expected);
  });
});

describe('formatDismissResult / formatUndoResult (D-15)', () => {
  it('reads back a dismissal without promising any Plex change', () => {
    expect(
      formatDismissResult({
        kind: 'show',
        title: "Grey's Anatomy",
        year: 2005,
        reason: 'not_interested',
      }),
    ).toBe("Got it. I won't suggest Grey's Anatomy (2005) again.");
    expect(
      formatDismissResult({ kind: 'show', title: 'Bluey', year: 2018, reason: 'not_mine' }),
    ).toBe(
      "Got it. Bluey (2018) is marked as someone else's viewing, so it's out of your history and picks. Plex is unchanged.",
    );
  });

  it('says what it undid, or that there was nothing', () => {
    const sev = {
      undone: true as const,
      kind: 'show' as const,
      title: 'Severance',
      year: 2022,
      action: 'watched' as const,
    };
    expect(formatUndoResult({ undone: false })).toBe('Nothing to undo from the past day.');
    expect(formatUndoResult({ ...sev, scope: 'show', revertResult: 'written', episodes: 19 })).toBe(
      'Undone. Severance (2022) is back to unwatched in Plex, 19 episodes.',
    );
    expect(
      formatUndoResult({
        ...sev,
        scope: 'episode',
        season: 2,
        episode: 3,
        revertResult: 'written',
        episodes: 1,
      }),
    ).toBe('Undone. Severance (2022) season 2 episode 3 is back to unwatched in Plex.');
    expect(
      formatUndoResult({
        ...sev,
        kind: 'movie',
        title: 'WarGames',
        year: 1983,
        scope: 'movie',
        revertResult: 'written',
        episodes: 1,
      }),
    ).toBe('Undone. WarGames (1983) is back to unwatched in Plex.');
    expect(
      formatUndoResult({ ...sev, title: 'Dark Matter', year: 2024, revertResult: 'none' }),
    ).toBe('Undone. Dark Matter (2024) is no longer marked as watched.');
    expect(formatUndoResult({ ...sev, revertResult: 'partial' })).toBe(
      'Undid the mark on Severance (2022), but only part of it reached Plex.',
    );
    expect(formatUndoResult({ ...sev, revertResult: 'failed' })).toBe(
      "Undid the mark on Severance (2022) in your history, but Plex didn't take the change, so it still shows as watched there.",
    );
    expect(
      formatUndoResult({ ...sev, action: 'not_interested', title: "Grey's Anatomy", year: 2005 }),
    ).toBe("Undone. Grey's Anatomy (2005) can be suggested again.");
    expect(formatUndoResult({ ...sev, action: 'not_mine', title: 'Bluey', year: 2018 })).toBe(
      'Undone. Bluey (2018) counts as your viewing again.',
    );
  });
});

describe('resolver outcomes and fixed answers', () => {
  it('asks between up to three titles like the design example, or offers one', () => {
    expect(
      formatAmbiguous('Dune', [
        { title: 'Dune', year: 2021, kind: 'movie' },
        { title: 'Dune', year: 1984, kind: 'movie' },
        { title: 'Dune: Prophecy', year: 2024, kind: 'show' },
        { title: 'Dune', year: 2000, kind: 'show' },
      ]),
    ).toBe(
      'More than one match for Dune: Dune (2021, movie), Dune (1984, movie), Dune: Prophecy (2024, show). Which one?',
    );
    expect(formatAmbiguous('slo', [{ title: 'Silo', year: 2023, kind: 'show' }])).toBe(
      'Did you mean Silo (2023, show)?',
    );
    expect(formatAmbiguous('dune?', [])).toBe("I couldn't find anything called dune.");
  });

  it('answers not found, not ready and errors in plain words', () => {
    expect(formatNotFound('Severence')).toBe("I couldn't find anything called Severence.");
    expect(formatNotFound('Severence', { kind: 'show' })).toBe(
      "I couldn't find a show called Severence.",
    );
    expect(formatNotFound('  ')).toBe("I couldn't find anything called that.");
    expect(formatNotReady()).toBe("Watch history isn't ready yet.");
    expect(formatWatchError()).toBe('Watch history hit an error. Try again in a minute.');
  });
});

describe('spoken hygiene (no markdown, bullets, emoji or URLs)', () => {
  const nasty = [
    'M*A*S*H',
    '[REC]',
    'Love 💕 Actually',
    'Watch https://example.com now',
    '#Alive',
    'Under_score `code`',
  ];

  it('cleans titles', () => {
    expect(nasty.map(spokenTitle)).toEqual([
      'MASH',
      'REC',
      'Love Actually',
      'Watch now',
      'Alive',
      'Underscore code',
    ]);
  });

  it('keeps every formatter output plain and under the cap', () => {
    const outputs: string[] = [];
    for (const title of nasty) {
      outputs.push(
        formatUnfinished(
          [
            {
              kind: 'show',
              title,
              state: 'in_progress',
              lastWatchedAt: NOW,
              episodesWatched: 1,
              episodesTotal: 2,
              next: { season: 1, episode: 2 },
            },
          ],
          { ...opts, limit: 5 },
        ),
        formatRecommendations(
          {
            onPlex: [pick(title, 2020, 'show', 'new to you')],
            notOnPlex: [pick(title, null, 'movie', 'on your watchlist', false)],
          },
          { limit: 5 },
        ),
        formatWatchStatus(status({ title, state: 'unstarted' }), opts),
        formatRecentHistory([{ kind: 'movie', title, lastAt: NOW }], {
          ...opts,
          days: 14,
          limit: 8,
        }),
        formatMarkResult({
          kind: 'show',
          title,
          year: 2020,
          scope: 'show',
          plexResult: 'written',
          episodes: 2,
          flipped: 2,
        }),
        formatDismissResult({ kind: 'show', title, year: 2020, reason: 'not_mine' }),
        formatUndoResult({
          undone: true,
          action: 'watched',
          kind: 'show',
          title,
          year: 2020,
          revertResult: 'written',
          episodes: 2,
        }),
        formatAmbiguous(title, [
          { title, year: 2020, kind: 'show' },
          { title, year: 2021, kind: 'movie' },
        ]),
        formatNotFound(title),
      );
    }
    for (const text of outputs) {
      expect(text).not.toMatch(/[*_`#|~<>[\]{}\\]/);
      expect(text).not.toMatch(/https?:|www\./i);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\n|^\s*[-•]/);
      expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
      expect(text).toMatch(/[.?]$/);
    }
  });
});
