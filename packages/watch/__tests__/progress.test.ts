// DESIGN-049 D-10 — progress math over fixtures: specials, the cross-server union, next after
// furthest, resume-only starts, the preferred server, rewatch, movies, children's titles, the state
// table boundaries, and the D-14 write-through (applyFlips).
import { describe, expect, it } from 'vitest';
import {
  applyFlips,
  compareUnfinished,
  computeMovieProgress,
  computeShowProgress,
  isKidsTitle,
  movieState,
  parseEpisodeMap,
  showState,
  type EpisodeObs,
  type EventObs,
  type ServerEpisodes,
  type ServerMovieObs,
} from '../src/progress';
import type { PlexServer } from '../src/types';

const at = (iso: string) => Date.parse(iso) / 1000;
const DAY = 86_400;
const NOW = at('2026-09-23T16:00:00Z');
const SEPT_1 = at('2026-09-01T02:00:00Z');

type Ep = [season: number, episode: number, extra?: Partial<EpisodeObs>];

function onServer(server: PlexServer, prefix: string, episodes: Ep[]): ServerEpisodes {
  return {
    server,
    episodes: episodes.map(([season, episode, extra]) => ({
      season,
      episode,
      ratingKey: `${prefix}${season}x${episode}`,
      watched: false,
      lastViewedAt: null,
      viewOffsetMs: null,
      ...extra,
    })),
  };
}

const W = (lastViewedAt = SEPT_1): Partial<EpisodeObs> => ({ watched: true, lastViewedAt });

function event(
  season: number | null,
  episode: number | null,
  extra: Partial<EventObs> = {},
): EventObs {
  return { season, episode, watched: true, startedAt: SEPT_1, stoppedAt: SEPT_1 + 1800, ...extra };
}

describe('computeShowProgress (D-10)', () => {
  it('ignores specials everywhere: counts, furthest, next, the map and the dates', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [0, 1, W(at('2026-09-22T00:00:00Z'))],
          [0, 2],
          [1, 1, W()],
          [1, 2],
        ]),
      ],
      [event(0, 1, { stoppedAt: at('2026-09-22T01:00:00Z') })],
    );
    expect(p.episodesTotal).toBe(2);
    expect(p.episodesWatched).toBe(1);
    expect(p.furthest).toEqual({ season: 1, episode: 1 });
    expect(p.next).toMatchObject({ season: 1, episode: 2 });
    expect(Object.keys(p.episodeMap)).toEqual(['1']);
    expect(p.lastWatchedAt).toBe(SEPT_1);
    expect(p.eventPlays).toBe(0);
    expect(p.eventWatchedEpisodes).toBe(0);
  });

  it('unites the servers: a pair is watched when any server says so', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, W()],
          [1, 2, W()],
          [1, 3, W()],
          [1, 4],
          [1, 5],
        ]),
        onServer('haynestower', 't', [
          [1, 4, W(at('2026-09-02T00:00:00Z'))],
          [2, 1],
          [2, 2],
        ]),
      ],
      [],
    );
    expect(p.episodesTotal).toBe(7);
    expect(p.episodesWatched).toBe(4);
    expect(p.furthest).toEqual({ season: 1, episode: 4 });
    expect(p.next).toEqual({
      season: 1,
      episode: 5,
      title: null,
      server: 'haynesops',
      ratingKey: 'o1x5',
      resume: false,
    });
    expect(p.episodeMap['1']?.[3]).toEqual([
      4,
      1,
      at('2026-09-02T00:00:00Z'),
      { haynesops: 'o1x4', haynestower: 't1x4' },
    ]);
    expect(p.episodeMap['2']).toEqual([
      [1, 0, 0, { haynestower: 't2x1' }],
      [2, 0, 0, { haynestower: 't2x2' }],
    ]);
    expect(p.plexWatched).toBe(false);
  });

  it('puts next right after the furthest watched pair, skipping earlier gaps, across seasons', () => {
    const gaps = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, W()],
          [1, 2],
          [1, 3, W()],
          [1, 4],
        ]),
      ],
      [],
    );
    expect(gaps.furthest).toEqual({ season: 1, episode: 3 });
    expect(gaps.next).toMatchObject({ season: 1, episode: 4 });

    const nextSeason = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [2, 1],
          [1, 2, W()],
          [1, 1, W()],
        ]),
      ],
      [],
    );
    expect(nextSeason.next).toMatchObject({ season: 2, episode: 1 });
  });

  it('serves next from HaynesOps when it holds it, else HaynesTower, with a title from either', () => {
    const both = computeShowProgress(
      [
        onServer('haynestower', 't', [
          [1, 1, W()],
          [1, 2, { title: 'Machine Learning' }],
        ]),
        onServer('haynesops', 'o', [
          [1, 1, W()],
          [1, 2],
        ]),
      ],
      [],
    );
    expect(both.next).toMatchObject({
      server: 'haynesops',
      ratingKey: 'o1x2',
      title: 'Machine Learning',
    });

    const towerOnly = computeShowProgress(
      [
        onServer('haynesops', 'o', [[1, 1, W()]]),
        onServer('haynestower', 't', [[1, 2, { title: 'Pilot Two' }]]),
      ],
      [],
    );
    expect(towerOnly.next).toMatchObject({
      server: 'haynestower',
      ratingKey: 't1x2',
      title: 'Pilot Two',
    });
  });

  it('starts from a resume point when nothing is watched (the most recently viewed one)', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, { viewOffsetMs: 300_000, lastViewedAt: at('2026-09-10T00:00:00Z') }],
          [1, 2],
          [1, 3, { viewOffsetMs: 600_000, lastViewedAt: at('2026-09-20T00:00:00Z') }],
        ]),
      ],
      [],
    );
    expect(p.episodesWatched).toBe(0);
    expect(p.furthest).toBeNull();
    expect(p.next).toMatchObject({ season: 1, episode: 3, resume: true });
    expect(p.lastWatchedAt).toBe(at('2026-09-20T00:00:00Z'));

    const untouched = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1],
          [1, 2],
        ]),
      ],
      [],
    );
    expect(untouched.next).toBeNull();
  });

  it('flags a started next episode as a resume', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, W()],
          [1, 2, { viewOffsetMs: 1_000 }],
        ]),
      ],
      [],
    );
    expect(p.next).toMatchObject({ season: 1, episode: 2, resume: true });
  });

  it('has no next and plexWatched when every pair is watched', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, W()],
          [1, 2, W()],
        ]),
      ],
      [],
    );
    expect(p.next).toBeNull();
    expect(p.plexWatched).toBe(true);
  });

  it('flags a rewatch when the events hold more than watched + 2 distinct episodes', () => {
    const plex = [
      onServer('haynesops', 'o', [
        [1, 1, W()],
        [1, 2, W()],
        [1, 3, W()],
        [1, 4],
        [1, 5],
        [1, 6],
      ]),
    ];
    const six = [1, 2, 3, 4, 5, 6].map((e) => event(1, e));
    const reset = computeShowProgress(plex, [
      ...six,
      event(1, 1),
      event(1, 7, { watched: false }),
      event(0, 1),
    ]);
    expect(reset.eventWatchedEpisodes).toBe(6);
    expect(reset.rewatch).toBe(true);
    expect(reset.eventPlays).toBe(8);

    const five = computeShowProgress(plex, six.slice(0, 5));
    expect(five.eventWatchedEpisodes).toBe(5);
    expect(five.rewatch).toBe(false);
  });

  it('takes last watched from Plex or events (a missing stop counts at its start), first watched likewise', () => {
    const p = computeShowProgress(
      [
        onServer('haynesops', 'o', [
          [1, 1, W(at('2026-09-10T00:00:00Z'))],
          [1, 2, W(at('2026-08-01T00:00:00Z'))],
        ]),
      ],
      [
        event(1, 1, {
          startedAt: at('2026-07-01T00:00:00Z'),
          stoppedAt: at('2026-09-15T00:00:00Z'),
        }),
        event(1, 2, { startedAt: at('2026-09-18T00:00:00Z'), stoppedAt: null }),
      ],
    );
    expect(p.plexLastViewedAt).toBe(at('2026-09-10T00:00:00Z'));
    expect(p.lastWatchedAt).toBe(at('2026-09-18T00:00:00Z'));
    expect(p.firstWatchedAt).toBe(at('2026-07-01T00:00:00Z'));
  });

  it('writes the compact D-07 episode map that parseEpisodeMap accepts', () => {
    const p = computeShowProgress(
      [
        onServer('haynestower', 't', [
          [2, 1],
          [1, 1, W(100)],
        ]),
        onServer('haynesops', 'o', [
          [1, 1],
          [1, 2],
        ]),
      ],
      [],
    );
    expect(p.episodeMap).toEqual({
      '1': [
        [1, 1, 100, { haynesops: 'o1x1', haynestower: 't1x1' }],
        [2, 0, 0, { haynesops: 'o1x2' }],
      ],
      '2': [[1, 0, 0, { haynestower: 't2x1' }]],
    });
    expect(parseEpisodeMap(JSON.parse(JSON.stringify(p.episodeMap)))).toEqual(p.episodeMap);
    expect(() => parseEpisodeMap({ '0': [[1, 1, 0, {}]] })).toThrow();
    expect(() => parseEpisodeMap({ '1': [[1, 2, 0, {}]] })).toThrow();
  });
});

describe('applyFlips (D-14 step 6 write-through, D-15 undo)', () => {
  const before = computeShowProgress(
    [
      onServer('haynesops', 'o', [
        [1, 1, W()],
        [1, 2],
        [1, 3],
        [2, 1],
        [2, 2],
      ]),
      onServer('haynestower', 't', [
        [1, 1, W()],
        [1, 2],
        [1, 3],
      ]),
    ],
    [],
  );
  const flipped = [
    { server: 'haynesops' as const, ratingKey: 'o1x2' },
    { server: 'haynesops' as const, ratingKey: 'o1x3' },
  ];

  it('marks the flipped pairs watched and moves next on, without a second read', () => {
    const after = computeShowProgress(
      applyFlips(before.episodeMap, flipped, true, { at: NOW }),
      [],
    );
    expect(after.episodesWatched).toBe(3);
    expect(after.furthest).toEqual({ season: 1, episode: 3 });
    expect(after.next).toMatchObject({ season: 2, episode: 1, server: 'haynesops', title: null });
    expect(after.lastWatchedAt).toBe(NOW);
    // The whole pair flips, so the other server's copy reads watched too (view-state sync).
    expect(after.episodeMap['1']?.[1]).toEqual([
      2,
      1,
      NOW,
      { haynesops: 'o1x2', haynestower: 't1x2' },
    ]);
  });

  it('undo with the same keys restores the progress exactly', () => {
    const marked = computeShowProgress(
      applyFlips(before.episodeMap, flipped, true, { at: NOW }),
      [],
    );
    const undone = computeShowProgress(applyFlips(marked.episodeMap, flipped, false), []);
    expect(undone.episodeMap).toEqual(before.episodeMap);
    expect(undone.episodesWatched).toBe(before.episodesWatched);
    expect(undone.next).toEqual(before.next);
    expect(undone.lastWatchedAt).toBe(before.lastWatchedAt);
  });

  it('matches a flip through any server key and ignores keys the map does not hold', () => {
    const viaTower = computeShowProgress(
      applyFlips(
        before.episodeMap,
        [
          { server: 'haynestower', ratingKey: 't1x2' },
          { server: 'haynesops', ratingKey: 'nope' },
        ],
        true,
      ),
      [],
    );
    expect(viaTower.episodesWatched).toBe(2);
    expect(viaTower.episodeMap['1']?.[1]?.[2]).toBe(0);
  });

  it('rebuilds per-server inputs without resume points', () => {
    const servers = applyFlips(before.episodeMap, [], true);
    expect(servers.map((s) => s.server)).toEqual(['haynesops', 'haynestower']);
    expect(servers[0]?.episodes).toHaveLength(5);
    expect(servers.every((s) => s.episodes.every((e) => e.viewOffsetMs === null))).toBe(true);
  });
});

function movie(server: PlexServer, extra: Partial<ServerMovieObs>): ServerMovieObs {
  return {
    server,
    ratingKey: `${server}-m`,
    guid: 'plex://movie/abc',
    local: false,
    viewCount: 0,
    viewOffsetMs: null,
    durationMs: 7_200_000,
    lastViewedAt: null,
    ...extra,
  };
}

describe('computeMovieProgress (D-10)', () => {
  it('takes the resume point from the server viewed most recently', () => {
    const p = computeMovieProgress(
      [
        movie('haynestower', { viewOffsetMs: 4_320_000, lastViewedAt: at('2026-08-01T00:00:00Z') }),
        movie('haynesops', { viewOffsetMs: 2_160_000, lastViewedAt: at('2026-09-20T00:00:00Z') }),
      ],
      [],
    );
    expect(p.resumePercent).toBe(30);
    expect(p.resumeServer).toBe('haynesops');
    expect(p.plexWatched).toBe(false);
  });

  it('lets a newer full watch supersede a stale resume point elsewhere', () => {
    const p = computeMovieProgress(
      [
        movie('haynesops', { viewCount: 1, lastViewedAt: at('2026-09-20T00:00:00Z') }),
        movie('haynestower', { viewOffsetMs: 3_600_000, lastViewedAt: at('2026-01-05T00:00:00Z') }),
      ],
      [],
    );
    expect(p.plexWatched).toBe(true);
    expect(p.resumePercent).toBeNull();
  });

  it('breaks a lastViewedAt tie toward the server with a resume point, and rounds the percent', () => {
    const p = computeMovieProgress(
      [movie('haynesops', {}), movie('haynestower', { viewOffsetMs: 1_234_567 })],
      [],
    );
    expect(p.resumePercent).toBe(17);
    expect(p.resumeServer).toBe('haynestower');
  });

  it('counts events and folds them into the dates', () => {
    const p = computeMovieProgress(
      [movie('haynesops', { viewCount: 1, lastViewedAt: at('2026-09-01T00:00:00Z') })],
      [
        event(null, null, {
          watched: false,
          startedAt: at('2025-03-01T00:00:00Z'),
          stoppedAt: at('2025-03-01T01:00:00Z'),
        }),
        event(null, null, {
          startedAt: at('2026-09-05T00:00:00Z'),
          stoppedAt: at('2026-09-05T02:00:00Z'),
        }),
      ],
    );
    expect(p.eventPlays).toBe(2);
    expect(p.eventWatched).toBe(true);
    expect(p.lastWatchedAt).toBe(at('2026-09-05T02:00:00Z'));
    expect(p.firstWatchedAt).toBe(at('2025-03-01T00:00:00Z'));
  });
});

describe('isKidsTitle (D-10)', () => {
  it.each([
    [{ kind: 'show' as const, contentRating: 'TV-Y' }, true],
    [{ kind: 'show' as const, contentRating: 'TV-Y7' }, true],
    [{ kind: 'show' as const, contentRating: 'tv-y7 fv' }, true],
    [{ kind: 'show' as const, contentRating: 'us/TV-Y7-FV' }, true],
    [{ kind: 'show' as const, contentRating: 'TV-PG', genres: ['Kids'] }, true],
    [{ kind: 'show' as const, contentRating: 'TV-G', genres: ['Children'] }, true],
    [{ kind: 'movie' as const, contentRating: 'PG', genres: ['Animation', 'Family'] }, true],
    [{ kind: 'show' as const, contentRating: 'TV-G', genres: ['Animation', 'Family'] }, false],
    [{ kind: 'movie' as const, contentRating: 'PG-13', genres: ['Animation', 'Action'] }, false],
    [{ kind: 'movie' as const, contentRating: null, genres: null }, false],
  ])('%j → %s', (title, expected) => {
    expect(isKidsTitle(title)).toBe(expected);
  });
});

describe('showState (the D-10 state table)', () => {
  const next = { season: 2, episode: 1 };
  const base = { episodesWatched: 10, episodesTotal: 20, next, lastWatchedAt: NOW };

  it('is in progress through exactly 90 days and stalled one second later', () => {
    expect(showState({ ...base, lastWatchedAt: NOW - 90 * DAY }, { now: NOW })).toBe('in_progress');
    expect(showState({ ...base, lastWatchedAt: NOW - 90 * DAY - 1 }, { now: NOW })).toBe('stalled');
  });

  it('is a taster at ≤ 2 watched, under 10%, untouched for more than 30 days — over in progress and stalled', () => {
    const taster = { ...base, episodesWatched: 1, episodesTotal: 20 };
    expect(showState({ ...taster, lastWatchedAt: NOW - 30 * DAY }, { now: NOW })).toBe(
      'in_progress',
    );
    expect(showState({ ...taster, lastWatchedAt: NOW - 30 * DAY - 1 }, { now: NOW })).toBe(
      'taster',
    );
    expect(showState({ ...taster, lastWatchedAt: NOW - 400 * DAY }, { now: NOW })).toBe('taster');
    // 2 of 20 is exactly 10%: not under it.
    expect(
      showState({ ...taster, episodesWatched: 2, lastWatchedAt: NOW - 40 * DAY }, { now: NOW }),
    ).toBe('in_progress');
    // 3 watched is never a taster, however small the share (Big Brother 3 of 1,012).
    expect(
      showState(
        { ...taster, episodesWatched: 3, episodesTotal: 1012, lastWatchedAt: NOW - 40 * DAY },
        { now: NOW },
      ),
    ).toBe('in_progress');
    // A resume-only start (nothing watched) can be a taster too.
    expect(
      showState({ ...taster, episodesWatched: 0, lastWatchedAt: NOW - 31 * DAY }, { now: NOW }),
    ).toBe('taster');
  });

  it('is caught up or finished without a next episode, by the ledger show status', () => {
    const done = { ...base, next: null };
    expect(showState(done, { now: NOW, showStatus: 'continuing' })).toBe('caught_up');
    expect(showState(done, { now: NOW, showStatus: null })).toBe('caught_up');
    expect(showState(done, { now: NOW, showStatus: 'ended' })).toBe('finished');
  });

  it('is unstarted with nothing watched and no resume point; an unknown time counts as old', () => {
    expect(
      showState(
        { episodesWatched: 0, episodesTotal: 8, next: null, lastWatchedAt: null },
        { now: NOW },
      ),
    ).toBe('unstarted');
    expect(showState({ ...base, lastWatchedAt: null }, { now: NOW })).toBe('stalled');
  });
});

describe('movieState (D-10)', () => {
  const base = { plexWatched: false, resumePercent: 50, lastWatchedAt: NOW - DAY };

  it('is in progress between 5 and 90 percent within 90 days, stalled after', () => {
    expect(movieState({ ...base, resumePercent: 5 }, { now: NOW })).toBe('in_progress');
    expect(movieState({ ...base, resumePercent: 90 }, { now: NOW })).toBe('in_progress');
    expect(movieState({ ...base, lastWatchedAt: NOW - 90 * DAY }, { now: NOW })).toBe(
      'in_progress',
    );
    expect(movieState({ ...base, lastWatchedAt: NOW - 90 * DAY - 1 }, { now: NOW })).toBe(
      'stalled',
    );
  });

  it('is finished when watched in Plex and unstarted otherwise outside that band', () => {
    expect(movieState({ ...base, resumePercent: 4 }, { now: NOW })).toBe('unstarted');
    expect(movieState({ ...base, resumePercent: 91, plexWatched: true }, { now: NOW })).toBe(
      'finished',
    );
    expect(movieState({ ...base, resumePercent: null, plexWatched: true }, { now: NOW })).toBe(
      'finished',
    );
  });
});

describe('compareUnfinished (T-245 order)', () => {
  it('lists in-progress first, then the most recent, then by title', () => {
    const items = [
      { state: 'stalled' as const, lastWatchedAt: NOW - 1, title: 'Z' },
      { state: 'in_progress' as const, lastWatchedAt: NOW - 100, title: 'B' },
      { state: 'in_progress' as const, lastWatchedAt: NOW - 100, title: 'a' },
      { state: 'in_progress' as const, lastWatchedAt: NOW - 5, title: 'C' },
    ];
    expect([...items].sort(compareUnfinished).map((i) => i.title)).toEqual(['C', 'a', 'B', 'Z']);
  });
});
