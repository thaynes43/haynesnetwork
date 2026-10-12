// ADR-107 / DESIGN-054: source evidence and canonical identities, without recommendation judgment.
// CPU budget: serial tests and fake timers; no load loops or stress tools in this shared pod.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchEventRow, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import {
  checkPersonalSnapshot,
  personalRecords,
  viewingContextFromSnapshot,
  type WatchPersonalSnapshot,
  type WatchTitleLookup,
} from '../src';

const NOW = new Date('2026-10-11T12:00:00Z');
const AT = new Date('2026-10-10T12:00:00Z');
const snapshot = (extra: Partial<WatchPersonalSnapshot> = {}): WatchPersonalSnapshot => ({
  titles: [],
  events: [],
  marks: [],
  ledger: [],
  watchlist: [],
  watchlistFetchedAt: null,
  ledgerRefreshedAt: null,
  isOwner: true,
  ...extra,
});
function title(extra: Partial<WatchTitleRow> = {}): WatchTitleRow {
  return {
    id: 1,
    plexAccountId: 1,
    titleKey: 'tmdb:movie:1',
    kind: 'movie',
    title: 'A Film',
    year: 2020,
    plexGuid: null,
    tmdbId: 1,
    tvdbId: null,
    imdbId: null,
    mediaItemId: null,
    genres: ['Mystery'],
    contentRating: null,
    isKids: false,
    onPlex: [],
    plexCounts: {},
    episodeMap: null,
    episodesTotal: null,
    episodesWatched: null,
    furthestSeason: null,
    furthestEpisode: null,
    nextSeason: null,
    nextEpisode: null,
    nextTitle: null,
    nextServer: null,
    nextRatingKey: null,
    nextResume: false,
    resumePercent: null,
    plexWatched: false,
    plexLastViewedAt: null,
    eventPlays: 0,
    eventWatchedEpisodes: 0,
    firstWatchedAt: null,
    lastWatchedAt: null,
    rewatch: false,
    showStatus: null,
    refreshedAt: AT,
    ...extra,
  };
}
function event(extra: Partial<WatchEventRow> = {}): WatchEventRow {
  return {
    id: 1,
    plexAccountId: 1,
    instance: 'haynesops',
    tautulliRowId: 1,
    kind: 'movie',
    itemGuid: null,
    showGuid: null,
    title: 'A Film',
    showTitle: null,
    season: null,
    episode: null,
    year: 2020,
    ratingKey: null,
    grandparentRatingKey: null,
    startedAt: AT,
    stoppedAt: AT,
    percentComplete: 95,
    watched: true,
    ingestedAt: AT,
    ...extra,
  };
}
function mark(extra: Partial<WatchMarkRow> = {}): WatchMarkRow {
  return {
    id: 1,
    plexAccountId: 1,
    action: 'not_interested',
    scope: 'movie',
    titleKey: 'imdb:tt123',
    kind: 'movie',
    title: 'A Film',
    year: 2020,
    plexGuid: null,
    tmdbId: null,
    tvdbId: null,
    imdbId: 'tt123',
    season: null,
    episode: null,
    query: 'A Film',
    consumer: 'test',
    actorUserId: null,
    flipped: [],
    plexResult: 'none',
    plexError: null,
    createdAt: AT,
    revertedAt: null,
    revertResult: null,
    ...extra,
  };
}
const searchEmpty = async () => ({ results: [] });

afterEach(() => vi.useRealTimers());

describe('personal candidate checks', () => {
  it('resolves outside Plex/watchlist and retains no-recorded-viewing versus unknown membership', async () => {
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [{ title: 'Outside Film', year: 2025, kind: 'movie', tmdbId: 999 }],
      now: NOW,
      lookup: {
        searchMulti: searchEmpty,
        getMovieIdentity: async () => ({
          id: 999,
          title: 'Outside Film',
          release_date: '2025-01-01',
          imdb_id: 'tt999',
        }),
      },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'resolved',
      identity: { tmdbId: 999, imdbId: 'tt999' },
      evidence: {
        viewing: 'no_recorded_viewing',
        viewingBasis: [],
        onPlex: null,
        onWatchlist: null,
        personalRating: { status: 'unavailable' },
      },
    });
    expect(out.coverage).toMatchObject({
      completeHistory: false,
      history: { status: 'unknown' },
      watchlist: { status: 'unknown', asOf: null },
    });
  });

  it('uses the external-ID bridge to recognize existing TMDB history for an IMDb candidate', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({ titles: [title({ plexWatched: true, eventPlays: 1 })] }),
      {
        titles: [{ imdbId: 'tt123', kind: 'movie' }],
        now: NOW,
        lookup: {
          searchMulti: searchEmpty,
          findByExternalId: async () => ({
            movie_results: [{ id: 1, title: 'A Film', release_date: '2020-01-01' }],
          }),
        },
      },
    );
    expect(out.results[0]).toMatchObject({
      resolution: 'resolved',
      identity: { tmdbId: 1, imdbId: 'tt123' },
      evidence: { viewing: 'watched', everWatched: true },
    });
  });

  it('hydrates a title-search identity to recognize an IMDb-only dismissal', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({ marks: [mark({ title: 'Local Display Name' })] }),
      {
        titles: [{ title: 'A Film', year: 2020, kind: 'movie' }],
        now: NOW,
        lookup: {
          searchMulti: async () => ({
            results: [{ id: 1, title: 'A Film', release_date: '2020-01-01', media_type: 'movie' }],
          }),
          getMovieIdentity: async () => ({
            id: 1,
            title: 'A Film',
            release_date: '2020-01-01',
            imdb_id: 'tt123',
          }),
        },
      },
    );
    // Canonical hydration is necessary even when the stored display title differs.
    expect(out.results[0]).toMatchObject({
      resolution: 'resolved',
      evidence: { dismissal: 'not_interested', statementCount: 1 },
    });
  });

  it('recognizes a marks-only title and keeps not_interested separate from not_mine', async () => {
    const data = snapshot({
      marks: [
        mark(),
        mark({ id: 2, title: 'Household Film', imdbId: 'tt222', action: 'not_mine' }),
      ],
      events: [event({ title: 'Household Film', year: 2020 })],
    });
    const out = await checkPersonalSnapshot(data, {
      titles: [{ imdbId: 'tt123' }, { imdbId: 'tt222' }],
      now: NOW,
    });
    expect(out.results[0]?.evidence).toMatchObject({
      dismissal: 'not_interested',
      viewing: 'no_recorded_viewing',
      plays: 0,
    });
    expect(out.results[1]?.evidence).toMatchObject({
      dismissal: 'not_mine',
      viewing: 'not_mine',
      viewingBasis: ['explicit_not_mine'],
      everWatched: false,
      completedPlays: 1,
    });
    const context = viewingContextFromSnapshot(data, { now: NOW });
    expect(context.items.map((i) => i.evidence.dismissal).sort()).toEqual([
      'not_interested',
      'not_mine',
    ]);
    expect(viewingContextFromSnapshot(data, { now: NOW, section: 'viewing' }).items).toEqual([]);
  });

  it('records a direct partial event honestly without a Title State', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({ events: [event({ watched: false, percentComplete: 20 })] }),
      { titles: [{ title: 'A Film', year: 2020, kind: 'movie' }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'partial',
      viewingBasis: ['partial_playback'],
      everWatched: false,
      plays: 1,
      completedPlays: 0,
      progress: { state: 'unknown' },
    });
  });

  it('aggregates duplicate Title States instead of taking the oldest empty row', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({
        titles: [title(), title({ id: 2, plexWatched: true, eventPlays: 2, genres: ['Thriller'] })],
      }),
      { titles: [{ kind: 'movie', tmdbId: 1 }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['plex_watched_state'],
      everWatched: true,
      plays: 2,
      genres: ['Mystery', 'Thriller'],
    });
    expect(personalRecords(snapshot({ titles: [title(), title({ id: 2 })] }))).toHaveLength(1);
  });

  it('names Plex watched-state evidence despite no recorded completed playback', async () => {
    const out = await checkPersonalSnapshot(snapshot({ titles: [title({ plexWatched: true })] }), {
      titles: [{ kind: 'movie', tmdbId: 1 }],
      now: NOW,
    });
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['plex_watched_state'],
      completedPlays: 0,
      progress: { state: 'finished' },
    });
  });

  it('keeps retained historical movie completion separate from the current replay', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({
        titles: [
          title({ eventWatchedEpisodes: 1, eventPlays: 2, resumePercent: 13, lastWatchedAt: AT }),
        ],
      }),
      { titles: [{ kind: 'movie', tmdbId: 1 }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['historical_completion'],
      completedPlays: 0,
      plays: 2,
      progress: { state: 'in_progress', resumePercent: 13 },
    });
  });

  it('uses the source watched verdict and excludes a later partial replay from watched provenance', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({
        events: [
          event({ percentComplete: 85 }),
          event({ id: 2, tautulliRowId: 2, watched: false, percentComplete: 13 }),
        ],
      }),
      { titles: [{ title: 'A Film', year: 2020, kind: 'movie' }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['completed_playback'],
      completedPlays: 1,
      plays: 2,
    });
  });

  it('derives decisive statements before optional statement metadata is clipped', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({
        marks: [
          mark({ tmdbId: 1, action: 'watched', createdAt: new Date('2026-01-01T00:00:00Z') }),
          ...Array.from({ length: 6 }, (_, i) => mark({ id: i + 2, tmdbId: 1 })),
        ],
      }),
      { titles: [{ kind: 'movie', tmdbId: 1 }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['explicit_watched'],
      statementCount: 7,
      clipped: true,
    });
    expect(out.results[0]?.evidence?.statements).toHaveLength(5);
    expect(out.results[0]?.evidence?.statements.every((s) => s.action === 'not_interested')).toBe(
      true,
    );
  });

  it('identifies watched episode evidence without turning it into whole-show completion', async () => {
    const out = await checkPersonalSnapshot(
      snapshot({
        titles: [
          title({
            kind: 'show',
            title: 'A Show',
            episodeMap: {
              '1': [
                [1, 1, 0, {}],
                [2, 0, 0, {}],
                [3, 0, 0, {}],
              ],
            },
            nextSeason: 1,
            nextEpisode: 2,
          }),
        ],
        marks: [
          mark({
            tmdbId: 1,
            imdbId: null,
            kind: 'show',
            title: 'A Show',
            action: 'watched',
            scope: 'episode',
            season: 1,
            episode: 1,
          }),
        ],
      }),
      { titles: [{ kind: 'show', tmdbId: 1 }], now: NOW },
    );
    expect(out.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      viewingBasis: ['explicit_watched', 'plex_episode_state'],
      completedPlays: 0,
      progress: { episodesWatched: 1, episodesTotal: 3 },
      statements: [{ scope: 'episode', season: 1, episode: 1 }],
    });
    expect(out.results[0]?.evidence?.progress.state).not.toBe('finished');
  });

  it('reports all watched supporting sources but lets not-mine override the classification', async () => {
    const data = snapshot({
      titles: [
        title({
          kind: 'show',
          title: 'A Show',
          plexWatched: true,
          episodesWatched: 1,
          episodesTotal: 1,
          eventWatchedEpisodes: 1,
          showStatus: 'ended',
        }),
      ],
      events: [
        event({ kind: 'episode', title: 'Pilot', showTitle: 'A Show', season: 1, episode: 1 }),
      ],
      marks: [
        mark({
          tmdbId: 1,
          imdbId: null,
          kind: 'show',
          title: 'A Show',
          scope: 'show',
          action: 'watched',
        }),
      ],
    });
    const watched = await checkPersonalSnapshot(data, {
      titles: [{ kind: 'show', tmdbId: 1 }],
      now: NOW,
    });
    expect(watched.results[0]?.evidence?.viewingBasis).toEqual([
      'explicit_watched',
      'plex_watched_state',
      'plex_episode_state',
      'completed_playback',
      'historical_completion',
    ]);
    const notMine = await checkPersonalSnapshot(
      {
        ...data,
        marks: [
          ...data.marks,
          mark({
            id: 2,
            tmdbId: 1,
            imdbId: null,
            kind: 'show',
            title: 'A Show',
            scope: 'show',
            action: 'not_mine',
          }),
        ],
      },
      { titles: [{ kind: 'show', tmdbId: 1 }], now: NOW },
    );
    expect(notMine.results[0]?.evidence).toMatchObject({
      viewing: 'not_mine',
      viewingBasis: ['explicit_not_mine'],
      everWatched: false,
      completedPlays: 1,
      progress: { state: 'finished' },
    });
    expect(notMine.results[0]?.evidence?.sources.map((s) => s.source)).toEqual([
      'title_state',
      'tautulli_events',
      'explicit_statements',
    ]);
  });

  it('names both partial sources and distinguishes a play with no completion verdict', async () => {
    const partial = await checkPersonalSnapshot(
      snapshot({
        titles: [title({ resumePercent: 13 })],
        events: [event({ watched: false, percentComplete: 13 })],
      }),
      { titles: [{ kind: 'movie', tmdbId: 1 }], now: NOW },
    );
    expect(partial.results[0]?.evidence).toMatchObject({
      viewing: 'partial',
      viewingBasis: ['partial_playback', 'plex_resume'],
    });
    const played = await checkPersonalSnapshot(
      snapshot({ events: [event({ watched: false, percentComplete: null })] }),
      { titles: [{ title: 'A Film', year: 2020, kind: 'movie' }], now: NOW },
    );
    expect(played.results[0]?.evidence).toMatchObject({
      viewing: 'played',
      viewingBasis: ['recorded_playback'],
    });
  });

  it('does not attribute a yearless remake play to either canonical title', async () => {
    const data = snapshot({
      titles: [
        title({ title: 'A Remake', year: 1980, tmdbId: 1 }),
        title({ id: 2, title: 'A Remake', year: 2020, tmdbId: 2 }),
      ],
      events: [event({ title: 'A Remake', year: null })],
    });
    const out = await checkPersonalSnapshot(data, {
      titles: [
        { kind: 'movie', tmdbId: 1 },
        { kind: 'movie', tmdbId: 2 },
      ],
      now: NOW,
    });
    expect(out.results.map((r) => r.evidence?.viewing)).toEqual(['unknown', 'unknown']);
    expect(out.results[0]?.evidence).toMatchObject({
      everWatched: null,
      attributionAmbiguous: true,
      viewingBasis: ['ambiguous_attribution'],
      unattributedPlays: 1,
      plays: 0,
    });
    const direct = await checkPersonalSnapshot(
      {
        ...data,
        titles: [
          title({ title: 'A Remake', year: 1980, tmdbId: 1, plexWatched: true }),
          title({ id: 2, title: 'A Remake', year: 2020, tmdbId: 2 }),
        ],
      },
      { titles: [{ kind: 'movie', tmdbId: 1 }], now: NOW },
    );
    expect(direct.results[0]?.evidence).toMatchObject({
      viewing: 'watched',
      everWatched: true,
      attributionAmbiguous: true,
    });
  });

  it('fails closed on contradictory IDs instead of using the matching name', async () => {
    const out = await checkPersonalSnapshot(snapshot({ titles: [title({ imdbId: 'tt123' })] }), {
      titles: [{ title: 'A Film', kind: 'movie', tmdbId: 1, imdbId: 'tt999' }],
      now: NOW,
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'unresolved',
      reason: 'conflicting_ids',
      evidence: null,
      options: [],
    });
  });

  it('returns a confirmed local canonical-year alternative without a provider call or personal evidence', async () => {
    const search = vi.fn(searchEmpty);
    const out = await checkPersonalSnapshot(
      snapshot({ titles: [title({ plexWatched: true, imdbId: 'tt123' })] }),
      {
        titles: [{ title: 'A Film', kind: 'movie', year: 2019, tmdbId: 1, imdbId: 'tt123' }],
        now: NOW,
        lookup: { searchMulti: search },
      },
    );
    expect(out.results[0]).toMatchObject({
      resolution: 'unresolved',
      reason: 'year_mismatch',
      identity: null,
      evidence: null,
      options: [{ title: 'A Film', year: 2020, tmdbId: 1, imdbId: 'tt123' }],
    });
    expect(search).not.toHaveBeenCalled();
    expect(out.results[0]?.options[0]).not.toHaveProperty('viewing');
  });

  it('does not let a name-only local alternative suppress a same-name catalog title in the requested year', async () => {
    const search = vi.fn(async () => ({
      results: [{ id: 2, title: 'A Film', release_date: '2019-01-01', media_type: 'movie' }],
    }));
    const data = snapshot({ titles: [title({ plexWatched: true })] });
    const out = await checkPersonalSnapshot(data, {
      titles: [{ title: 'A Film', kind: 'movie', year: 2019 }],
      now: NOW,
      lookup: { searchMulti: search },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'resolved',
      identity: { year: 2019, tmdbId: 2 },
      evidence: { viewing: 'no_recorded_viewing' },
    });
    expect(search).toHaveBeenCalledTimes(1);
    const offline = await checkPersonalSnapshot(data, {
      titles: [{ title: 'A Film', kind: 'movie', year: 2019 }],
      now: NOW,
    });
    expect(offline.results[0]).toMatchObject({
      resolution: 'unavailable',
      reason: 'catalog_unavailable',
      identity: null,
      evidence: null,
      options: [{ year: 2020, tmdbId: 1 }],
    });
  });

  it('keeps provider failure unavailable despite name-only alternate-year records', async () => {
    const out = await checkPersonalSnapshot(snapshot({ titles: [title()] }), {
      titles: [{ title: 'A Film', year: 2019, kind: 'movie' }],
      now: NOW,
      lookup: {
        searchMulti: async () => {
          throw new Error('offline');
        },
      },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'unavailable',
      reason: 'catalog_lookup_failed',
      evidence: null,
      options: [{ year: 2020, tmdbId: 1 }],
    });
  });

  it('deduplicates and caps exact-name known-year options while excluding fuzzy names and other kinds', async () => {
    const search = vi.fn(async () => ({
      results: [
        { id: 1, title: 'A Film', release_date: '2020-01-01', media_type: 'movie' },
        { id: 1, title: 'A Film', release_date: '2020-01-01', media_type: 'movie' },
        { id: 2, name: 'A Film', first_air_date: '2020-01-01', media_type: 'tv' },
        { id: 3, title: 'A Film', media_type: 'movie' },
        { id: 4, title: 'A Film Returns', release_date: '2020-01-01', media_type: 'movie' },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: i + 10,
          title: 'A Film',
          release_date: `${2021 + i}-01-01`,
          media_type: 'movie',
        })),
      ],
    }));
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [{ title: 'A Film', year: 2019, kind: 'movie' }],
      now: NOW,
      lookup: { searchMulti: search },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'unresolved',
      reason: 'year_mismatch',
      identity: null,
      evidence: null,
    });
    expect(out.results[0]?.options.map((o) => o.tmdbId)).toEqual([1, 10, 11, 12, 13]);
    expect(out.coverage.clipped).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('rejects unverified or conflicting IDs and unrelated local names as year alternatives', async () => {
    const data = snapshot({ titles: [title({ imdbId: 'tt123' })] });
    const out = await checkPersonalSnapshot(data, {
      titles: [
        { title: 'A Film', year: 2019, kind: 'movie', tmdbId: 1, imdbId: 'tt999' },
        { title: 'Different Film', year: 2019, kind: 'movie', tmdbId: 1 },
        { title: 'A Film', year: 2019, kind: 'show' },
        { title: 'A Film', year: 2019, kind: 'movie', tmdbId: 2, imdbId: 'tt777' },
      ],
      now: NOW,
      lookup: {
        searchMulti: searchEmpty,
        getMovieIdentity: async (id) => ({ id, title: 'A Film', release_date: '2020-01-01' }),
      },
    });
    expect(out.results.every((r) => r.resolution !== 'resolved' && r.options.length === 0)).toBe(
      true,
    );
    expect(out.results[0]?.reason).toBe('conflicting_ids');
  });

  it('returns an identity-only alternate year discovered by detail hydration', async () => {
    const detail = vi.fn(async () => ({
      id: 2,
      title: 'A Film',
      release_date: '2020-01-01',
      imdb_id: 'tt123',
    }));
    const out = await checkPersonalSnapshot(snapshot({ marks: [mark({ action: 'watched' })] }), {
      titles: [{ title: 'A Film', year: 2019, kind: 'movie' }],
      now: NOW,
      lookup: {
        searchMulti: async () => ({
          results: [{ id: 2, title: 'A Film', release_date: '2019-01-01', media_type: 'movie' }],
        }),
        getMovieIdentity: detail,
      },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'unresolved',
      reason: 'year_mismatch',
      identity: null,
      evidence: null,
      options: [{ year: 2020, tmdbId: 2, imdbId: 'tt123' }],
    });
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('cannot treat unverified supplied IDs as equivalence after a canonical lookup', async () => {
    const lookup: WatchTitleLookup = {
      searchMulti: searchEmpty,
      getMovieIdentity: async () => ({ id: 1, title: 'A Film', release_date: '2020-01-01' }),
    };
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [
        { kind: 'movie', tmdbId: 1, imdbId: 'tt123' },
        { kind: 'movie', tmdbId: 1, plexGuid: 'plex://movie/unknown' },
      ],
      now: NOW,
      lookup,
    });
    expect(out.results.map((r) => [r.resolution, r.reason])).toEqual([
      ['unavailable', 'canonical_ids_unverified'],
      ['unavailable', 'canonical_ids_unverified'],
    ]);
  });

  it('confirms additional IDs through detail hydration and refuses a contradictory bridge', async () => {
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [
        { kind: 'show', tvdbId: 22, imdbId: 'tt456' },
        { kind: 'show', tvdbId: 22, imdbId: 'tt999' },
      ],
      now: NOW,
      lookup: {
        searchMulti: searchEmpty,
        findByExternalId: async () => ({
          tv_results: [{ id: 2, name: 'A Show', first_air_date: '2021-01-01' }],
        }),
        getTvIdentity: async () => ({
          id: 2,
          name: 'A Show',
          first_air_date: '2021-01-01',
          external_ids: { tvdb_id: 22, imdb_id: 'tt456' },
        }),
      },
    });
    expect(out.results.map((r) => r.resolution)).toEqual(['resolved', 'unresolved']);
    expect(out.results[1]?.reason).toBe('conflicting_ids');
  });

  it('searches numeric literal titles before treating their final number as a year hint', async () => {
    const search = vi.fn(async (query: string) => ({
      results:
        query === 'Blade Runner 2049'
          ? [
              {
                id: 2049,
                title: 'Blade Runner 2049',
                release_date: '2017-01-01',
                media_type: 'movie',
              },
            ]
          : [],
    }));
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [{ title: 'Blade Runner 2049', kind: 'movie' }],
      now: NOW,
      lookup: { searchMulti: search },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'resolved',
      identity: { title: 'Blade Runner 2049', year: 2017 },
    });
    expect(search.mock.calls.map((c) => c[0])).toEqual(['Blade Runner 2049']);
  });

  it('never invents a canonical year from a numeric title when catalog dates are missing', async () => {
    const lookup: WatchTitleLookup = {
      searchMulti: async () => ({
        results: [{ id: 2049, title: 'Blade Runner 2049', media_type: 'movie' }],
      }),
      getMovieIdentity: async () => ({ id: 2049, title: 'Blade Runner 2049' }),
      getTvIdentity: async () => ({ id: 2049, name: 'A Show 2049' }),
      findByExternalId: async () => ({ movie_results: [{ id: 2049, title: 'Blade Runner 2049' }] }),
    };
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [
        { title: 'Blade Runner 2049', year: 2022, kind: 'movie' },
        { title: 'Blade Runner 2049', year: 2022, kind: 'movie', tmdbId: 2049 },
        { title: 'A Show 2049', year: 2022, kind: 'show', tmdbId: 2049 },
        { title: 'Blade Runner 2049', year: 2022, kind: 'movie', imdbId: 'tt2049' },
      ],
      now: NOW,
      lookup,
    });
    expect(out.results.every((r) => r.resolution === 'unresolved' && r.options.length === 0)).toBe(
      true,
    );
    const literal = await checkPersonalSnapshot(snapshot(), {
      titles: [{ title: 'Blade Runner 2049', kind: 'movie' }],
      now: NOW,
      lookup,
    });
    expect(literal.results[0]).toMatchObject({
      resolution: 'resolved',
      identity: { title: 'Blade Runner 2049', year: null },
    });
  });

  it('does not turn a missing hydrated date into a numeric-title year alternative', async () => {
    const detail = vi.fn(async () => ({ id: 2049, title: 'Blade Runner 2049', imdb_id: 'tt2049' }));
    const out = await checkPersonalSnapshot(snapshot({ marks: [mark({ imdbId: 'tt2049' })] }), {
      titles: [{ title: 'Blade Runner 2049', year: 2022, kind: 'movie' }],
      now: NOW,
      lookup: {
        searchMulti: async () => ({
          results: [
            {
              id: 2049,
              title: 'Blade Runner 2049',
              release_date: '2022-01-01',
              media_type: 'movie',
            },
          ],
        }),
        getMovieIdentity: detail,
      },
    });
    expect(out.results[0]).toMatchObject({
      resolution: 'unresolved',
      reason: 'year_mismatch',
      identity: null,
      evidence: null,
      options: [],
    });
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('tries a stripped year hint only after literal search and never substitutes another year', async () => {
    const search = vi.fn(async (query: string) => ({
      results:
        query === 'Foundation'
          ? [{ id: 20, name: 'Foundation', first_air_date: '2020-01-01', media_type: 'tv' }]
          : [],
    }));
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [
        { title: 'Foundation 2020', kind: 'show' },
        { title: 'Foundation (2021)', kind: 'show' },
      ],
      now: NOW,
      lookup: { searchMulti: search },
    });
    expect(out.results[0]).toMatchObject({ resolution: 'resolved', identity: { year: 2020 } });
    expect(out.results[1]).toMatchObject({
      resolution: 'unresolved',
      reason: 'year_mismatch',
      identity: null,
      evidence: null,
      options: [{ title: 'Foundation', year: 2020, tmdbId: 20 }],
    });
    expect(search.mock.calls.map((c) => c[0])).toEqual([
      'Foundation 2020',
      'Foundation (2021)',
      'Foundation',
      'Foundation',
    ]);
  });

  it('distinguishes same-name ambiguity, wrong year, missing title, and unavailable provider', async () => {
    const lookup: WatchTitleLookup = {
      searchMulti: async () => ({
        results: [
          { id: 11, title: 'Duplicated', release_date: '2020-01-01', media_type: 'movie' },
          { id: 12, title: 'Duplicated', release_date: '2020-01-01', media_type: 'movie' },
        ],
      }),
    };
    const out = await checkPersonalSnapshot(snapshot(), {
      titles: [
        { title: 'Duplicated', year: 2020 },
        { title: 'Duplicated', year: 2021 },
        { title: 'Missing' },
      ],
      now: NOW,
      lookup,
    });
    expect(out.results.map((r) => r.resolution)).toEqual(['ambiguous', 'unresolved', 'unresolved']);
    expect(out.results[1]?.reason).toBe('year_mismatch');
    const down = await checkPersonalSnapshot(snapshot(), {
      titles: [{ title: 'Missing' }],
      now: NOW,
      lookup: {
        searchMulti: async () => {
          throw new Error('offline');
        },
      },
    });
    expect(down.results[0]?.resolution).toBe('unavailable');
    const notFound = await checkPersonalSnapshot(snapshot(), {
      titles: [{ kind: 'movie', tmdbId: 404 }],
      now: NOW,
      lookup: {
        searchMulti: searchEmpty,
        getMovieIdentity: async () => {
          throw { status: 404 };
        },
      },
    });
    expect(notFound.results[0]?.resolution).toBe('unresolved');
  });

  it('preserves mixed input order without grouping by Plex membership', async () => {
    const data = snapshot({
      titles: [
        title({
          title: 'Owned',
          tmdbId: 1,
          onPlex: [{ server: 'haynesops', ratingKey: 'owned', local: false }],
        }),
        title({ id: 2, title: 'External', tmdbId: 2 }),
      ],
    });
    const out = await checkPersonalSnapshot(data, {
      titles: [{ kind: 'movie', tmdbId: 2 }, { title: 'Unresolved' }, { kind: 'movie', tmdbId: 1 }],
      now: NOW,
    });
    expect(out.results.map((r) => r.input)).toEqual([
      { kind: 'movie', tmdbId: 2 },
      { title: 'Unresolved' },
      { kind: 'movie', tmdbId: 1 },
    ]);
    expect(out.results.map((r) => r.evidence?.onPlex)).toEqual([false, undefined, true]);
  });

  it('uses one shared lookup deadline and keeps later local results when a provider stalls', async () => {
    vi.useFakeTimers();
    const search = vi.fn(() => new Promise<{ results: [] }>(() => {}));
    const pending = checkPersonalSnapshot(snapshot({ titles: [title({ plexWatched: true })] }), {
      titles: [
        { title: 'Slow 1' },
        { title: 'Slow 2' },
        { kind: 'movie', tmdbId: 1 },
        { title: 'Slow 3' },
      ],
      now: NOW,
      lookup: { searchMulti: search },
      lookupBudgetMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    const out = await pending;
    expect(out.results.map((r) => r.resolution)).toEqual([
      'unavailable',
      'unavailable',
      'resolved',
      'unavailable',
    ]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('factual viewing context', () => {
  it('keeps full name-only identities distinct before clipping display metadata', () => {
    const prefix = 'Long title '.repeat(21);
    const first = `${prefix}First`;
    const second = `${prefix}Second`;
    const data = snapshot({
      events: [event({ title: first }), event({ id: 2, tautulliRowId: 2, title: second })],
    });
    const records = personalRecords(data);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.identity.titleKey)).size).toBe(2);
    const out = viewingContextFromSnapshot(data, { now: NOW });
    expect(out.items.map((i) => i.identity.title)).toEqual([first, second]);
    expect(out.items.every((i) => i.evidence.plays === 1)).toBe(true);
    expect(out.coverage.clipped).toBe(true);
  });

  it('separates explicit feedback from plays and supports paging/kind filters', () => {
    const data = snapshot({
      marks: [
        mark({ action: 'watched' }),
        mark({ id: 2, title: 'A Show', kind: 'show', scope: 'show', tmdbId: 2, imdbId: null }),
        mark({ id: 3, title: 'Another Film', imdbId: 'tt456' }),
      ],
    });
    const all = viewingContextFromSnapshot(data, { now: NOW, limit: 1 });
    expect(all.section).toBe('all');
    expect(all.page).toEqual({ offset: 0, limit: 1, total: 3, hasMore: true });
    expect(
      viewingContextFromSnapshot(data, { now: NOW, section: 'feedback', kind: 'show' }).items,
    ).toHaveLength(1);
    const viewed = viewingContextFromSnapshot(data, { now: NOW, section: 'viewing' });
    expect(viewed.items).toHaveLength(1);
    expect(viewed.items[0]?.evidence).toMatchObject({
      viewing: 'watched',
      plays: 0,
      statements: [{ action: 'watched' }],
    });
  });

  it('reports clipped optional details and unavailable owner-only watchlist for another principal', () => {
    const data = snapshot({
      isOwner: false,
      titles: [title({ plexWatched: true, genres: ['a', 'b', 'c', 'd', 'e', 'f'] })],
      marks: Array.from({ length: 8 }, (_, i) => mark({ id: i, tmdbId: 1 })),
    });
    const out = viewingContextFromSnapshot(data, { now: NOW });
    expect(out.coverage).toMatchObject({
      clipped: true,
      watchlist: { status: 'unavailable', asOf: null },
    });
    expect(out.items[0]?.evidence).toMatchObject({
      statementCount: 8,
      clipped: true,
      onWatchlist: null,
    });
    expect(out.items[0]?.evidence.statements).toHaveLength(5);
    expect(out.items[0]?.evidence.genres).toHaveLength(5);
  });

  it('does not turn watchlist actions/catalog hints into taste or completion evidence', async () => {
    const data = snapshot({
      marks: [mark({ action: 'watchlist_remove' })],
      cachedCatalog: [{ kind: 'movie', title: 'Seed Title', year: 2021, tmdbId: 9 }],
    });
    const out = await checkPersonalSnapshot(data, {
      now: NOW,
      titles: [{ imdbId: 'tt123' }, { kind: 'movie', tmdbId: 9 }],
    });
    expect(out.results.every((r) => r.evidence?.viewing === 'no_recorded_viewing')).toBe(true);
    expect(out.results.every((r) => r.evidence?.statementCount === 0)).toBe(true);
    expect(viewingContextFromSnapshot(data, { now: NOW }).items).toEqual([]);
  });
});
