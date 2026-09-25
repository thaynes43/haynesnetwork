// ADR-092 / DESIGN-051 D-07 (PLAN-071 S2) — the D-17 seed picker reads Watch Marks: only a dismissal
// (`not_interested`, `not_mine`) drops a seed. A Watchlist Change (`watchlist_add` / `watchlist_remove`) is not a
// watch statement, so a title added to or removed from the watchlist stays a seed. Pure — no database.
import { describe, expect, it } from 'vitest';
import type { WatchMarkRow, WatchTitleRow } from '@hnet/db';
import { pickSeeds } from '../src/watch';

const NOW = new Date('2026-09-25T20:00:00Z');

function finishedShow(title: string, tmdbId: number): WatchTitleRow {
  return {
    id: tmdbId,
    plexAccountId: 1,
    kind: 'show',
    titleKey: `tmdb:show:${tmdbId}`,
    plexGuid: null,
    tmdbId,
    tvdbId: null,
    imdbId: null,
    mediaItemId: null,
    title,
    year: 2020,
    genres: ['Drama'],
    contentRating: null,
    isKids: false,
    onPlex: [],
    plexCounts: {},
    episodeMap: null,
    episodesTotal: 10,
    episodesWatched: 10,
    furthestSeason: 1,
    furthestEpisode: 10,
    nextSeason: null,
    nextEpisode: null,
    nextTitle: null,
    nextServer: null,
    nextRatingKey: null,
    nextResume: false,
    resumePercent: null,
    plexWatched: true,
    plexLastViewedAt: new Date(NOW.getTime() - 86_400_000),
    eventPlays: 10,
    eventWatchedEpisodes: 10,
    firstWatchedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    lastWatchedAt: new Date(NOW.getTime() - 86_400_000),
    rewatch: false,
    showStatus: 'ended',
    refreshedAt: NOW,
  } as WatchTitleRow;
}

function mark(action: WatchMarkRow['action'], row: WatchTitleRow): WatchMarkRow {
  return {
    id: row.id,
    plexAccountId: 1,
    action,
    scope: 'show',
    titleKey: row.titleKey,
    kind: 'show',
    title: row.title,
    year: row.year,
    plexGuid: null,
    tmdbId: row.tmdbId,
    tvdbId: null,
    imdbId: null,
    season: null,
    episode: null,
    query: row.title,
    consumer: 'hop',
    actorUserId: null,
    flipped: [],
    plexResult: action.startsWith('watchlist_') ? 'written' : 'none',
    plexError: null,
    createdAt: NOW,
    revertedAt: null,
    revertResult: null,
  };
}

describe('pickSeeds — only dismissals drop a seed (DESIGN-051 D-07)', () => {
  it('a Watchlist Change never drops a seed; a dismissal does', () => {
    const a = finishedShow('Alpha', 101);
    const b = finishedShow('Bravo', 102);
    const c = finishedShow('Charlie', 103);
    const seeds = pickSeeds(
      [a, b, c],
      [mark('watchlist_add', a), mark('watchlist_remove', b), mark('not_interested', c)],
      NOW,
      15,
    );
    expect(seeds.map((s) => s.title).sort()).toEqual(['Alpha', 'Bravo']);
  });
});
