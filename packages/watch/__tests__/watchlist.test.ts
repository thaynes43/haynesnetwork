// ADR-092 / DESIGN-051 D-02 / D-04 / D-05 / D-07 (PLAN-071 S2) — the watchlist's pure half: the read-time
// overlay (an add, a remove, a revert, an event the cache already reflects, the 5-minute margin, no cached rows,
// events ordered by time then mark id), the same-title rule, the statement filter, the `watchlist` and
// `set_watchlist` answers (entries, kind, started / watched, empty, past the end, a later page, the cap), the
// undo answers with their Seerr sentences (and, since the third review pass on PR #580, a failed clear, a remove
// left off, a change still going through, DESIGN-051 D-15k/m/o), the "can't tell them apart" answer (D-15l), and
// `watch_status`'s four availability sentences.
import { describe, expect, it } from 'vitest';
import type { WatchMarkRow } from '@hnet/db';
import {
  formatNotOnWatchlist,
  formatUndoResult,
  formatWatchlist,
  formatWatchlistChange,
  formatWatchlistDuplicates,
  formatWatchlistNotSetUp,
  formatWatchStatus,
  type WatchlistItemView,
  type WatchStatusView,
} from '../src/format';
import { SPOKEN_MAX_CHARS } from '../src/spoken';
import type { TitleFactsRow } from '../src/queries/watchlist';
import { indexMarks, onPlexFor, watchlistItems } from '../src/views';
import {
  isOnWatchlist,
  isStatementAction,
  overlayWatchlist,
  sameWatchlistTitle,
  statementMarks,
  watchlistEvents,
  WATCHLIST_OVERLAY_MARGIN_SECONDS,
  type WatchlistEntry,
  type WatchlistMarkLike,
} from '../src/watchlist';

const FETCHED = 1_790_000_000; // the cache's fetched_at (unix seconds)
const at = (s: number) => new Date(s * 1000);

function entry(title: string, over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    kind: 'show',
    title,
    year: 2022,
    titleKey: `name:show:${title.toLowerCase()}|2022`,
    plexGuid: null,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    source: 'cache',
    ...over,
  };
}

let nextId = 1;
function mark(action: 'watchlist_add' | 'watchlist_remove', createdAt: number, over: Partial<WatchlistMarkLike> = {}): WatchlistMarkLike {
  return {
    id: nextId++,
    action,
    kind: 'movie',
    titleKey: 'plex:plex://movie/5d776825880197001ec967c0',
    title: 'The Matrix',
    year: 1999,
    plexGuid: 'plex://movie/5d776825880197001ec967c0',
    tmdbId: 603,
    tvdbId: null,
    imdbId: 'tt0133093',
    plexResult: 'written',
    createdAt: at(createdAt),
    revertedAt: null,
    revertResult: null,
    ...over,
  };
}

const SEV = entry('Severance', { plexGuid: 'plex://show/5d9c086c46115600200aa9b1', tmdbId: 95396, tvdbId: 371980 });
const DARK = entry('Dark Matter', { year: 2024, tmdbId: 203744 });
const BASE = [SEV, DARK];
const titles = (list: readonly WatchlistEntry[]) => list.map((e) => e.title);

describe('overlayWatchlist (D-05)', () => {
  it('an add of a title not present goes on top; a remove drops every row of the same title', () => {
    const add = mark('watchlist_add', FETCHED + 60);
    expect(titles(overlayWatchlist(BASE, [add], FETCHED))).toEqual(['The Matrix', 'Severance', 'Dark Matter']);
    const synthetic = overlayWatchlist(BASE, [add], FETCHED)[0];
    expect(synthetic).toMatchObject({ source: 'change', kind: 'movie', year: 1999, tmdbId: 603 });
    const remove = mark('watchlist_remove', FETCHED + 60, {
      kind: 'show',
      title: 'Severance',
      year: 2022,
      titleKey: 'plex:plex://show/5d9c086c46115600200aa9b1',
      plexGuid: 'plex://show/5d9c086c46115600200aa9b1',
      tmdbId: null,
      imdbId: null,
    });
    expect(titles(overlayWatchlist([...BASE, SEV], [remove], FETCHED))).toEqual(['Dark Matter']);
  });

  it('a written revert is the inverse at its reverted_at; a failed change or revert changes nothing', () => {
    const undone = mark('watchlist_add', FETCHED + 60, { revertedAt: at(FETCHED + 90), revertResult: 'written' });
    expect(titles(overlayWatchlist(BASE, [undone], FETCHED))).toEqual(['Severance', 'Dark Matter']);
    const failed = mark('watchlist_add', FETCHED + 60, { plexResult: 'failed' });
    const pending = mark('watchlist_add', FETCHED + 60, { plexResult: 'pending' });
    expect(titles(overlayWatchlist(BASE, [failed, pending], FETCHED))).toEqual(['Severance', 'Dark Matter']);
    const revertFailed = mark('watchlist_add', FETCHED + 60, { revertResult: 'failed' });
    expect(titles(overlayWatchlist(BASE, [revertFailed], FETCHED))).toEqual(['The Matrix', 'Severance', 'Dark Matter']);
    // A remove undone puts the title back on top.
    const removeUndone = mark('watchlist_remove', FETCHED + 60, {
      kind: 'show',
      title: 'Dark Matter',
      year: 2024,
      titleKey: 'tmdb:show:203744',
      plexGuid: null,
      tmdbId: 203744,
      imdbId: null,
      revertedAt: at(FETCHED + 120),
      revertResult: 'written',
    });
    expect(titles(overlayWatchlist(BASE, [removeUndone], FETCHED))).toEqual(['Dark Matter', 'Severance']);
  });

  it('an event the cache already reflects changes nothing (set operations), inside the 5-minute margin', () => {
    // An add written 2 minutes BEFORE the sync read plex.tv: the cache already has it — no duplicate.
    const seen = mark('watchlist_add', FETCHED - 120, {
      kind: 'show',
      title: 'Severance',
      year: 2022,
      titleKey: 'plex:plex://show/5d9c086c46115600200aa9b1',
      plexGuid: 'plex://show/5d9c086c46115600200aa9b1',
      tmdbId: 95396,
      imdbId: null,
    });
    expect(titles(overlayWatchlist(BASE, [seen], FETCHED))).toEqual(['Severance', 'Dark Matter']);
    // An add whose row predates the read by 4 minutes but that the read missed (its PUT landed later): applied.
    const missed = mark('watchlist_add', FETCHED - 240);
    expect(titles(overlayWatchlist(BASE, [missed], FETCHED))).toEqual(['The Matrix', 'Severance', 'Dark Matter']);
    // Older than the margin: the cache is the truth.
    const old = mark('watchlist_add', FETCHED - WATCHLIST_OVERLAY_MARGIN_SECONDS - 1);
    expect(titles(overlayWatchlist(BASE, [old], FETCHED))).toEqual(['Severance', 'Dark Matter']);
  });

  it('with no cached rows, the changes alone make the list; events apply by time, then mark id', () => {
    const a = mark('watchlist_add', FETCHED + 10);
    const r = mark('watchlist_remove', FETCHED + 10); // same second, later id: removed after the add
    expect(overlayWatchlist([], [r, a], FETCHED)).toEqual([]);
    expect(watchlistEvents([r, a], FETCHED).map((e) => e.op)).toEqual(['add', 'remove']);
    expect(titles(overlayWatchlist([], [a], FETCHED))).toEqual(['The Matrix']);
    const b = mark('watchlist_add', FETCHED + 20, { title: 'Arrival', year: 2016, titleKey: 'tmdb:movie:329865', plexGuid: null, tmdbId: 329865, imdbId: null });
    expect(titles(overlayWatchlist([], [b, a], FETCHED))).toEqual(['Arrival', 'The Matrix']);
  });
});

describe('the same title on the watchlist (D-05) and the statement filter (D-07)', () => {
  it('matches a plex guid or an external id of the same kind; a name only when an id is missing on a side', () => {
    expect(sameWatchlistTitle(SEV, { kind: 'show', title: 'Severance (US)', year: 2022, tvdbId: 371980 })).toBe(true);
    expect(sameWatchlistTitle(SEV, { kind: 'movie', title: 'Severance', year: 2022, tmdbId: 95396 })).toBe(false);
    expect(sameWatchlistTitle(SEV, { kind: 'show', title: 'Severance', year: 2022, tmdbId: 1 })).toBe(false);
    expect(sameWatchlistTitle(SEV, { kind: 'show', title: 'Severance', year: 2022 })).toBe(true);
    expect(isOnWatchlist(BASE, { kind: 'show', title: 'dark matter', year: 2024, tmdbId: 203744 })).toBe(true);
  });

  it('only watched / not_interested / not_mine are watch statements', () => {
    expect(['watched', 'not_interested', 'not_mine', 'watchlist_add', 'watchlist_remove'].map(isStatementAction)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    const row = { ...mark('watchlist_add', FETCHED), plexAccountId: 1, scope: 'movie' } as unknown as WatchMarkRow;
    expect(statementMarks([row])).toEqual([]);
    const index = indexMarks([row]);
    expect([...index.watched, ...index.notInterested, ...index.notMine, ...index.notMineShowNames]).toEqual([]);
  });
});

describe('the watchlist items (D-02): on Plex, started, watched', () => {
  const facts = {
    ledger: [
      {
        id: 'l1',
        arrKind: 'sonarr' as const,
        title: 'Severance',
        year: 2022,
        tvdbId: 371980,
        tmdbId: 95396,
        imdbId: null,
        genres: [],
        imdbRating: null,
        tmdbRating: null,
        rtTomatometer: null,
        onPlex: true,
        addedToPlex: null,
      },
    ],
    titles: [],
  };

  it('on Plex by a ledger match with a Plex match; not otherwise', () => {
    expect(onPlexFor(SEV, facts)).toBe(true);
    expect(onPlexFor(DARK, facts)).toBe(false);
    expect(onPlexFor(SEV, { ...facts, ledger: [{ ...facts.ledger[0]!, onPlex: false }] })).toBe(false);
    const items = watchlistItems(BASE, facts, indexMarks([]), FETCHED);
    expect(items).toEqual([
      { kind: 'show', title: 'Severance', year: 2022, onPlex: true, progress: null },
      { kind: 'show', title: 'Dark Matter', year: 2024, onPlex: false, progress: null },
    ]);
  });

  it('a taster (a show tried and left) reads started, not watched', () => {
    const taster: TitleFactsRow = {
      kind: 'show' as const,
      titleKey: 'tvdb:371980',
      title: 'Severance',
      year: 2022,
      plexGuid: null,
      tmdbId: 95396,
      tvdbId: 371980,
      imdbId: null,
      onPlex: [{ server: 'haynesops', ratingKey: 'sev', local: false }],
      episodesWatched: 1,
      episodesTotal: 19,
      eventWatchedEpisodes: 1,
      nextSeason: 1,
      nextEpisode: 2,
      nextResume: false,
      resumePercent: null,
      plexWatched: false,
      lastWatchedAt: new Date((FETCHED - 400 * 86_400) * 1000),
      showStatus: 'continuing',
    };
    const items = watchlistItems([BASE[0]!], { ...facts, titles: [taster] }, indexMarks([]), FETCHED);
    expect(items[0]!.progress).toBe('started');
    // A Title State with `on_plex` is on Plex by itself (no ledger match needed).
    expect(onPlexFor(SEV, { ledger: [], titles: [taster] })).toBe(true);
  });
});

describe('formatWatchlist (D-02)', () => {
  const items: WatchlistItemView[] = [
    { kind: 'show', title: 'Slow Horses', year: 2022, onPlex: true, progress: 'started' },
    { kind: 'movie', title: 'The Toxic Avenger', year: 2023, onPlex: false, progress: null },
    { kind: 'movie', title: 'The Matrix', year: 1999, onPlex: true, progress: 'watched' },
  ];

  it('the design example, a kind, a later page, empty, past the end', () => {
    expect(formatWatchlist(items.slice(0, 2), { total: 150, offset: 0 })).toBe(
      'Your watchlist has 150 titles. Newest first: Slow Horses, a 2022 show, on Plex, started. The Toxic Avenger, a 2023 movie, not on Plex yet. And 148 more.',
    );
    expect(formatWatchlist([items[0]!], { total: 61, offset: 0, kind: 'show' })).toBe(
      'Your watchlist has 61 shows. Newest first: Slow Horses, a 2022 show, on Plex, started. And 60 more.',
    );
    expect(formatWatchlist(items.slice(1), { total: 12, offset: 5 })).toBe(
      'Your watchlist has twelve titles. Numbers 6 to 7: The Toxic Avenger, a 2023 movie, not on Plex yet. The Matrix, a 1999 movie, on Plex, watched. And 5 more.',
    );
    expect(formatWatchlist([], { total: 0, offset: 0 })).toBe('Your watchlist is empty.');
    expect(formatWatchlist([], { total: 0, offset: 0, kind: 'movie' })).toBe('Your watchlist has no movies.');
    expect(formatWatchlist([], { total: 3, offset: 3 })).toBe("That's the end of your watchlist.");
    expect(formatWatchlist([items[2]!], { total: 1, offset: 0, kind: 'movie' })).toBe(
      'Your watchlist has one movie. Newest first: The Matrix, a 1999 movie, on Plex, watched.',
    );
  });

  it('stays under 1,200 characters and says how many it skipped', () => {
    const long = Array.from({ length: 10 }, (_, i): WatchlistItemView => ({
      kind: 'movie',
      title: `An Exceptionally Long Title For A Film On The Watchlist Number ${i}, Subtitled At Considerable Length`,
      year: 2001,
      onPlex: i % 2 === 0,
      progress: null,
    }));
    const text = formatWatchlist(long, { total: 150, offset: 0 });
    expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(text).toMatch(/And \d+ more\.$/);
    expect(text).not.toMatch(/[*#_`\u2014\u2013]/);
  });

  it('fits the items to the cap FIRST, then says the range and the rest of the items it kept (PR #580 ruling 8)', () => {
    const long = Array.from({ length: 10 }, (_, i): WatchlistItemView => ({
      kind: 'movie',
      title: `An Exceptionally Long Title For A Film On The Watchlist Number ${i}, Subtitled At Considerable Length`,
      year: 2001,
      onPlex: true,
      progress: null,
    }));
    for (const offset of [0, 20]) {
      const text = formatWatchlist(long, { total: 150, offset });
      expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
      const range = /(?:Newest first, numbers|Numbers) (\d+) to (\d+): /.exec(text);
      expect(range, text).not.toBeNull();
      const [from, to] = [Number(range![1]), Number(range![2])];
      const listed = (text.match(/Film On The Watchlist Number \d+/g) ?? []).length;
      const more = Number(/And (\d+) more\.$/.exec(text)![1]);
      // The range names exactly the titles said, and "more" is everything after them: paging on from `to` skips none.
      expect([from, to - from + 1]).toEqual([offset + 1, listed]);
      expect(listed).toBeLessThan(10);
      expect(to + more).toBe(150);
    }
  });
});

describe('formatWatchlistChange and the not-set-up answers (D-02)', () => {
  it('says back plex.tv\'s title and year, and the Seerr line for a title not on Plex', () => {
    const m = { kind: 'movie' as const, title: 'The Matrix', year: 1999 };
    expect(formatWatchlistChange({ status: 'added', ...m, onPlex: true })).toBe(
      "Added The Matrix (1999 movie) to your watchlist. It's on Plex.",
    );
    expect(formatWatchlistChange({ status: 'added', kind: 'movie', title: 'Dune: Part Three', year: 2026, onPlex: false })).toBe(
      "Added Dune: Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    expect(formatWatchlistChange({ status: 'removed', ...m })).toBe('Removed The Matrix (1999 movie) from your watchlist.');
    expect(formatWatchlistChange({ status: 'unchanged', action: 'add', ...m, onPlex: true })).toBe(
      'The Matrix (1999 movie) is already on your watchlist.',
    );
    expect(formatWatchlistChange({ status: 'unchanged', action: 'remove', ...m, onPlex: true })).toBe(
      "The Matrix (1999 movie) isn't on your watchlist.",
    );
    expect(formatWatchlistChange({ status: 'unchanged', action: 'remove', ...m, onPlex: false })).toBe(
      "The Matrix (1999 movie) isn't on your watchlist.",
    );
    expect(formatWatchlistChange({ status: 'not_in_catalog', ...m })).toBe(
      "I found The Matrix (1999 movie) but not in Plex's catalog, so your watchlist didn't change.",
    );
    expect(formatWatchlistChange({ status: 'unconfirmed', ...m })).toBe(
      "I couldn't confirm The Matrix (1999 movie) in Plex's catalog, so your watchlist didn't change.",
    );
    expect(formatWatchlistChange({ status: 'failed' })).toBe("I couldn't reach Plex, so your watchlist didn't change.");
    expect(formatWatchlistChange({ status: 'unknown', action: 'add', ...m, onPlex: true })).toBe(
      "Plex didn't answer in time, so I can't tell whether The Matrix (1999 movie) changed.",
    );
    expect(formatWatchlistChange({ status: 'unknown', action: 'remove', ...m, onPlex: false })).toBe(
      "Plex didn't answer in time, so I can't tell whether The Matrix (1999 movie) changed.",
    );
    expect(formatNotOnWatchlist('the fixture')).toBe("I couldn't find the fixture on your watchlist.");
    expect(formatNotOnWatchlist('Silo', { kind: 'show' })).toBe("I couldn't find a show called Silo on your watchlist.");
    expect(formatWatchlistNotSetUp()).toBe("Your Plex watchlist isn't set up for your account yet.");
  });

  // D-15j: a retried add that landed answers "already on", and an unconfirmed add may have landed: when the title is
  // not on Plex, both still say Seerr will request it (the first answer may never have been heard).
  it('an "already on" or unconfirmed add of a title not on Plex still carries the Seerr sentence', () => {
    const d = { kind: 'movie' as const, title: 'Dune: Part Three', year: 2026, onPlex: false };
    expect(formatWatchlistChange({ status: 'unchanged', action: 'add', ...d })).toBe(
      "Dune: Part Three (2026 movie) is already on your watchlist. It isn't on Plex yet, so Seerr will request it if it hasn't already.",
    );
    expect(formatWatchlistChange({ status: 'unknown', action: 'add', ...d })).toBe(
      "Plex didn't answer in time, so I can't tell whether Dune: Part Three (2026 movie) changed. It isn't on Plex yet, so if it was added, Seerr will request it.",
    );
    const u = { undone: true as const, kind: 'movie' as const, title: 'Dune: Part Three', year: 2026 };
    expect(
      formatUndoResult({ ...u, action: 'watchlist_remove', revertResult: 'failed', watchlistOutcome: 'unknown', onPlex: false }),
    ).toBe(
      "Plex didn't answer in time, so I can't tell whether Dune: Part Three (2026 movie) changed. It isn't on Plex yet, so if it was put back, Seerr will request it.",
    );
    // Undoing an add sends a removal, which never downloads: no sentence.
    expect(
      formatUndoResult({ ...u, action: 'watchlist_add', revertResult: 'failed', watchlistOutcome: 'unknown', onPlex: false }),
    ).toBe("Plex didn't answer in time, so I can't tell whether Dune: Part Three (2026 movie) changed.");
    for (const text of [
      formatWatchlistChange({ status: 'unchanged', action: 'add', ...d }),
      formatWatchlistChange({ status: 'unknown', action: 'add', ...d }),
    ]) {
      expect(text).not.toMatch(/[\u2014\u2013]/);
    }
  });
});

describe('formatUndoResult for a Watchlist Change (D-04)', () => {
  const base = { undone: true as const, kind: 'movie' as const, title: 'The Matrix', year: 1999 };
  it('the inverse, the Seerr sentences, a failed inverse, a change that never reached Plex', () => {
    expect(formatUndoResult({ ...base, action: 'watchlist_add', revertResult: 'written', onPlex: true })).toBe(
      'Removed The Matrix (1999 movie) from your watchlist again.',
    );
    expect(formatUndoResult({ ...base, action: 'watchlist_add', revertResult: 'written', onPlex: false })).toBe(
      'Removed The Matrix (1999 movie) from your watchlist again. Seerr may already have requested it.',
    );
    expect(formatUndoResult({ ...base, action: 'watchlist_remove', revertResult: 'written', onPlex: true })).toBe(
      'Put The Matrix (1999 movie) back on your watchlist.',
    );
    expect(formatUndoResult({ ...base, action: 'watchlist_remove', revertResult: 'written', onPlex: false })).toBe(
      'Put The Matrix (1999 movie) back on your watchlist. Seerr will request it.',
    );
    expect(formatUndoResult({ ...base, action: 'watchlist_remove', revertResult: 'failed' })).toBe(
      "I couldn't reach Plex, so The Matrix (1999 movie) is still off your watchlist. Say undo again to retry.",
    );
    expect(formatUndoResult({ ...base, action: 'watchlist_add', revertResult: 'none' })).toBe(
      'Your last change, adding The Matrix (1999 movie) to your watchlist, never reached Plex, so there was nothing to undo.',
    );
    // PR #580 ruling 2: a failed add that went out is cleared anyway; a failed remove is left as it is; unknown.
    expect(
      formatUndoResult({ ...base, action: 'watchlist_add', revertResult: 'written', watchlistOutcome: 'cleared', onPlex: false }),
    ).toBe(
      "Your last change, adding The Matrix (1999 movie) to your watchlist, may not have reached Plex, so I made sure it's off your watchlist. Seerr may already have requested it.",
    );
    expect(
      formatUndoResult({ ...base, action: 'watchlist_remove', revertResult: 'none', watchlistOutcome: 'left_as_is' }),
    ).toBe(
      'Your last change, removing The Matrix (1999 movie) from your watchlist, never confirmed with Plex, so I left your watchlist as it is.',
    );
    expect(
      formatUndoResult({ ...base, action: 'watchlist_remove', revertResult: 'failed', watchlistOutcome: 'unknown' }),
    ).toBe("Plex didn't answer in time, so I can't tell whether The Matrix (1999 movie) changed.");
  });

  // The third review pass on PR #580 (DESIGN-051 D-15k, D-15m, D-15o).
  it('a failed clear, a remove left off, a change still going through: none says more than is known', () => {
    // D-15m: the add never confirmed, so a failed removal of it never says the title "is still on" the watchlist.
    const clearFailed = formatUndoResult({
      ...base,
      action: 'watchlist_add',
      revertResult: 'failed',
      watchlistOutcome: 'clear_failed',
    });
    expect(clearFailed).toBe(
      "I couldn't reach Plex, so I couldn't make sure The Matrix (1999 movie) is off your watchlist. Say undo again to retry.",
    );
    // A written add's failed inverse still says it is on (that one is known).
    expect(formatUndoResult({ ...base, action: 'watchlist_add', revertResult: 'failed', watchlistOutcome: 'failed' })).toBe(
      "I couldn't reach Plex, so The Matrix (1999 movie) is still on your watchlist. Say undo again to retry.",
    );
    // D-15k: a remove sent over an add plex.tv never settled is not re-added.
    const leftOff = formatUndoResult({
      ...base,
      action: 'watchlist_remove',
      revertResult: 'none',
      watchlistOutcome: 'left_off',
    });
    expect(leftOff).toBe(
      'Your last change, removing The Matrix (1999 movie) from your watchlist, came after an add Plex never confirmed, so I left it off your watchlist. To put it back, ask me to add it.',
    );
    // D-15o: still pending.
    const inProgress = formatUndoResult({ ...base, action: 'watchlist_add', revertResult: null, watchlistOutcome: 'in_progress' });
    expect(inProgress).toBe(
      'Plex is still working on your last change, adding The Matrix (1999 movie) to your watchlist. Say undo again in a moment.',
    );
    for (const text of [clearFailed, leftOff, inProgress]) expect(text).not.toMatch(/[\u2014\u2013]/);
  });
});

describe('formatWatchlistDuplicates (D-15e, D-15l): one spoken title, several watchlist titles', () => {
  it('is never a question: nothing the owner can say picks one of them', () => {
    const dark = { title: 'Dark Matter', year: 2024, kind: 'show' as const };
    const same = formatWatchlistDuplicates([dark, dark]);
    expect(same).toBe(
      "Your watchlist has more than one Dark Matter (2024 show), and I can't tell them apart, so I left it as it is. You can change it in the Plex app.",
    );
    expect(same).not.toMatch(/\?|Which one/);
    // Titles an id linked but that read differently are named.
    const linked = formatWatchlistDuplicates([dark, { ...dark, year: 2023 }]);
    expect(linked).toBe(
      "Dark Matter (2024 show) and Dark Matter (2023 show) on your watchlist look like the same title to me, so I left your watchlist as it is. You can change it in the Plex app.",
    );
    expect(linked).not.toMatch(/\?|[\u2014\u2013]/);
    expect(formatWatchlistDuplicates([dark, { ...dark, year: 2023 }, { ...dark, year: 2022 }])).toMatch(
      /^Dark Matter \(2024 show\), Dark Matter \(2023 show\) and Dark Matter \(2022 show\) on your watchlist/,
    );
  });
});

describe('formatWatchStatus — the availability sentence (D-02)', () => {
  const view = (onPlex: boolean, onWatchlist: boolean | null): WatchStatusView => ({
    kind: 'show',
    title: 'Slow Horses',
    year: 2022,
    onPlex,
    state: 'unstarted',
    everWatched: false,
    lastWatchedAt: null,
    onWatchlist,
  });
  it('says both, explicitly, four ways; without a watchlist to read, DESIGN-049\'s sentence', () => {
    const o = { now: FETCHED };
    expect(formatWatchStatus(view(true, true), o)).toBe('Slow Horses (2022 show): not watched yet. On Plex and on your watchlist.');
    expect(formatWatchStatus(view(true, false), o)).toBe('Slow Horses (2022 show): not watched yet. On Plex, not on your watchlist.');
    expect(formatWatchStatus(view(false, true), o)).toBe(
      'Slow Horses (2022 show): not watched yet. Not on Plex, but on your watchlist.',
    );
    expect(formatWatchStatus(view(false, false), o)).toBe('Slow Horses (2022 show): not watched yet. Not on Plex or your watchlist.');
    expect(formatWatchStatus(view(true, null), o)).toBe('Slow Horses (2022 show): not watched yet. On Plex.');
    expect(formatWatchStatus(view(false, null), o)).toBe('Slow Horses (2022 show): not watched yet. Not on Plex.');
  });
});
