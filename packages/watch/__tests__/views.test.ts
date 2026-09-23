// DESIGN-049 D-17 / D-21 (PLAN-068 S7 review) — the pure view helpers the MCP answers build on:
// `recent_history` leaves out a `not_mine` show even when its episodes still carry no show guid (Q-06: the
// group's name key has no year, the mark's does), and `ledgerExclusions` turns the owner's Title States and
// live marks into the per-kind id arrays the D-17 library query is anti-joined on.
import { describe, expect, it } from 'vitest';
import type { WatchEventRow, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import { indexMarks, ledgerExclusions, recentEntries, titleKeyFor } from '../src';

const NOW = Date.parse('2026-09-23T20:00:00Z');
let rowId = 0;

function episode(showTitle: string, showGuid: string | null, season: number, ep: number, hoursAgo: number): WatchEventRow {
  rowId += 1;
  const startedAt = new Date(NOW - hoursAgo * 3_600_000);
  return {
    id: rowId,
    plexAccountId: 1,
    instance: 'haynesops',
    tautulliRowId: rowId,
    kind: 'episode',
    itemGuid: null,
    showGuid,
    title: `${showTitle} ${season}x${ep}`,
    showTitle,
    season,
    episode: ep,
    // Tautulli's year on an episode row is the episode's, not the show's.
    year: 2024,
    ratingKey: `rk-${rowId}`,
    grandparentRatingKey: null,
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + 1_800_000),
    percentComplete: 100,
    watched: true,
    ingestedAt: startedAt,
  };
}

function mark(
  action: WatchMarkRow['action'],
  t: { kind: 'show' | 'movie'; title: string; year: number | null; plexGuid?: string | null; tvdbId?: number | null },
  revertedAt: Date | null = null,
): WatchMarkRow {
  const ids = { kind: t.kind, title: t.title, year: t.year, plexGuid: t.plexGuid ?? null, tmdbId: null, tvdbId: t.tvdbId ?? null, imdbId: null };
  return {
    id: 1,
    plexAccountId: 1,
    action,
    scope: t.kind,
    titleKey: titleKeyFor(ids),
    ...ids,
    season: null,
    episode: null,
    query: t.title,
    consumer: 'hop',
    actorUserId: null,
    flipped: [],
    plexResult: 'none',
    plexError: null,
    createdAt: new Date(NOW),
    revertedAt,
    revertResult: null,
  };
}

const titles = (entries: ReturnType<typeof recentEntries>) => entries.map((e) => e.title).sort();

describe('recentEntries — not_mine (D-21, Q-06)', () => {
  const bluey = { kind: 'show' as const, title: 'Bluey', year: 2018, plexGuid: 'plex://show/bluey', tvdbId: 353546 };

  it('leaves out a not_mine show whose episodes have no show guid (the name matches without the year)', () => {
    const events = [episode('Bluey', null, 3, 1, 5), episode('Bluey', null, 3, 2, 4), episode('Silo', 'plex://show/silo', 1, 7, 2)];
    expect(titles(recentEntries(events, indexMarks([])))).toEqual(['Bluey', 'Silo']);
    expect(titles(recentEntries(events, indexMarks([mark('not_mine', bluey)])))).toEqual(['Silo']);
  });

  it('still matches a guid-carrying group by its guid', () => {
    const events = [episode('Bluey', 'plex://show/bluey', 3, 1, 5)];
    expect(titles(recentEntries(events, indexMarks([mark('not_mine', bluey)])))).toEqual([]);
  });

  it('does not match by name when both sides carry a different guid (another show of the same name)', () => {
    const events = [episode('Bluey', 'plex://show/bluey-1976', 1, 1, 5)];
    expect(titles(recentEntries(events, indexMarks([mark('not_mine', bluey)])))).toEqual(['Bluey']);
  });

  it('ignores not_interested, reverted and movie marks, and other names', () => {
    const events = [episode('Bluey', null, 3, 1, 5), episode('Bluey Tales', null, 1, 1, 3)];
    for (const m of [
      mark('not_interested', bluey),
      mark('not_mine', bluey, new Date(NOW)),
      mark('not_mine', { kind: 'movie', title: 'Bluey', year: 2018 }),
    ]) {
      expect(titles(recentEntries(events, indexMarks([m])))).toEqual(['Bluey', 'Bluey Tales']);
    }
    expect(titles(recentEntries(events, indexMarks([mark('not_mine', bluey)])))).toEqual(['Bluey Tales']);
  });

  it('normalizes both names the same way (case, punctuation, a year hint)', () => {
    const events = [episode('BLUEY!', null, 3, 1, 5)];
    expect(titles(recentEntries(events, indexMarks([mark('not_mine', { ...bluey, title: 'Bluey (2018)', plexGuid: null })])))).toEqual([]);
  });
});

type TitleIn = Parameters<typeof ledgerExclusions>[0][number];

function title(kind: 'show' | 'movie', ids: Partial<TitleIn>, state: Partial<TitleIn> = {}): TitleIn {
  return {
    kind,
    mediaItemId: null,
    tvdbId: null,
    tmdbId: null,
    imdbId: null,
    episodesWatched: null,
    plexWatched: false,
    eventWatchedEpisodes: 0,
    nextResume: false,
    resumePercent: null,
    ...ids,
    ...state,
  } satisfies Pick<WatchTitleRow, keyof TitleIn>;
}

describe('ledgerExclusions (D-17 anti-join inputs)', () => {
  it('takes every started-or-watched Title State and every live mark, per kind, without NULLs or duplicates', () => {
    const ex = ledgerExclusions(
      [
        title('show', { mediaItemId: 'a', tvdbId: 1, tmdbId: 10, imdbId: 'tt1' }, { episodesWatched: 2 }),
        title('show', { tvdbId: 2 }, { plexWatched: true }),
        title('show', { tmdbId: 10 }, { eventWatchedEpisodes: 1 }),
        title('show', { imdbId: 'tt3' }, { nextResume: true }),
        title('movie', { mediaItemId: 'b', tmdbId: 10 }, { resumePercent: 12 }),
        // Untouched: excludes nothing.
        title('show', { mediaItemId: 'z', tvdbId: 99, tmdbId: 99, imdbId: 'tt99' }, { episodesWatched: 0, resumePercent: 0 }),
      ],
      [
        mark('not_mine', { kind: 'show', title: 'M', year: null, tvdbId: 5 }),
        mark('watched', { kind: 'movie', title: 'N', year: null }),
        mark('not_interested', { kind: 'show', title: 'R', year: null, tvdbId: 77 }, new Date(NOW)),
      ],
    );
    expect(ex).toEqual({
      show: { mediaItemIds: ['a'], tvdbIds: [1, 2, 5], tmdbIds: [10], imdbIds: ['tt1', 'tt3'] },
      movie: { mediaItemIds: ['b'], tvdbIds: [], tmdbIds: [10], imdbIds: [] },
    });
  });
});
