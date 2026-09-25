// The watch tools' views (DESIGN-049 D-10, D-15, D-18..D-21): stored Title States, events and live marks →
// the inputs of the spoken formatters. Pure — the MCP layer reads (queries), revalidates (the domain), then
// builds its answer here and formats it (format.ts).
import type { WatchEventRow, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import type { RecentEntry, UnfinishedItem, WatchlistItemView, WatchStatusView } from './format';
import { keysOf, nameKey } from './identity';
import { normalizeTitle } from './normalize';
import { compareUnfinished, movieState, showState } from './progress';
import type { RecommendInputs, RecoTitleRow, UnfinishedRow } from './queries/answers';
import { ledgerMatchesTitle } from './queries/ledger';
import type { TitleFacts, TitleFactsRow } from './queries/watchlist';
import {
  buildExclusions,
  buildTasteProfile,
  genreExemplars,
  isEverWatched,
  pickRecommendations,
  type Dismissal,
  type HistoryFacts,
  type LiveMark,
  type MarkAction,
  type ProfileTitle,
  type Recommendations,
} from './recommend';
import type { TitleIds, WatchKind } from './types';
import { validTime } from './util';
import { sameWatchlistTitle, statementMarks, type WatchlistEntry } from './watchlist';

const sec = (d: Date | null | undefined): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

/** Live marks indexed by kind-scoped identity key. */
export interface MarkIndex {
  watched: ReadonlySet<string>;
  notInterested: ReadonlySet<string>;
  notMine: ReadonlySet<string>;
  /**
   * The normalized names (no year) of the shows marked `not_mine`: how an episode without a show guid (Q-06)
   * is matched to its show — the `selectTitleEvents` rule — since its name key has no year to match.
   */
  notMineShowNames: ReadonlySet<string>;
}

const SHOW_NAME_KEY = 'name:show:';

/** `name:show:<normalized>|<year>` → `<normalized>`. */
function showNameOf(key: string): string {
  const bar = key.lastIndexOf('|');
  return key.slice(SHOW_NAME_KEY.length, bar < SHOW_NAME_KEY.length ? undefined : bar);
}

export function indexMarks(marks: readonly WatchMarkRow[]): MarkIndex {
  const watched = new Set<string>();
  const notInterested = new Set<string>();
  const notMine = new Set<string>();
  const notMineShowNames = new Set<string>();
  // DESIGN-051 D-07: a Watchlist Change is not a watch statement (never Ever Watched, never a dismissal).
  for (const m of statementMarks(marks)) {
    if (m.revertedAt) continue;
    const set = m.action === 'watched' ? watched : m.action === 'not_interested' ? notInterested : notMine;
    for (const k of keysOf(m)) {
      set.add(`${m.kind}|${k}`);
      if (m.action === 'not_mine' && m.kind === 'show' && k.startsWith(SHOW_NAME_KEY)) notMineShowNames.add(showNameOf(k));
    }
  }
  return { watched, notInterested, notMine, notMineShowNames };
}

/** The live marks that apply to one title (any shared identity key, same kind). */
export function marksFor(
  index: MarkIndex,
  t: TitleIds & { titleKey?: string | null },
): { watched: boolean; dismissed: Dismissal | null } {
  const keys = keysOf(t).map((k) => `${t.kind}|${k}`);
  const has = (s: ReadonlySet<string>) => keys.some((k) => s.has(k));
  return {
    watched: has(index.watched),
    dismissed: has(index.notMine) ? 'not_mine' : has(index.notInterested) ? 'not_interested' : null,
  };
}

/**
 * Unfinished (T-245, D-10): shows `in_progress` or `stalled` (a Taster is neither), movies resumed between
 * 5% and 90%; not dismissed; children's titles only when `kids`. Ordered in progress first, newest first.
 */
export function unfinishedItems<R extends UnfinishedRow>(
  rows: readonly R[],
  marks: MarkIndex,
  opts: { kind: WatchKind | 'any'; kids: boolean; now: number },
): Array<{ row: R; item: UnfinishedItem }> {
  const out: Array<{ row: R; item: UnfinishedItem }> = [];
  for (const row of rows) {
    if (opts.kind !== 'any' && row.kind !== opts.kind) continue;
    if (row.isKids && !opts.kids) continue;
    if (marksFor(marks, row).dismissed) continue;
    const lastWatchedAt = sec(row.lastWatchedAt);
    if (row.kind === 'show') {
      const next =
        row.nextSeason !== null && row.nextEpisode !== null
          ? { season: row.nextSeason, episode: row.nextEpisode, resume: row.nextResume }
          : null;
      const state = showState(
        {
          episodesWatched: row.episodesWatched ?? 0,
          episodesTotal: row.episodesTotal ?? 0,
          next,
          lastWatchedAt,
        },
        { showStatus: row.showStatus, now: opts.now },
      );
      if (state !== 'in_progress' && state !== 'stalled') continue;
      out.push({
        row,
        item: {
          kind: 'show',
          title: row.title,
          state,
          lastWatchedAt,
          episodesWatched: row.episodesWatched,
          episodesTotal: row.episodesTotal,
          next,
          rewatch: row.rewatch,
        },
      });
    } else {
      const state = movieState(
        { plexWatched: row.plexWatched, resumePercent: row.resumePercent, lastWatchedAt },
        { now: opts.now },
      );
      if (state !== 'in_progress' && state !== 'stalled') continue;
      out.push({
        row,
        item: { kind: 'movie', title: row.title, state, lastWatchedAt, resumePercent: row.resumePercent },
      });
    }
  }
  return out.sort((a, b) => compareUnfinished(a.item, b.item));
}

/**
 * `recent_history` (D-21): the events grouped per title — a show by its guid (else its title), a movie by
 * its guid (else title and year) — with the distinct episodes played, the latest one, and when. A title
 * marked `not_mine` (someone else's viewing on the owner's account) is left out (PLAN-068 S7); a show whose
 * episodes carry no guid (Q-06) is matched to such a mark by its normalized name alone.
 */
export function recentEntries(events: readonly WatchEventRow[], marks: MarkIndex): RecentEntry[] {
  interface Acc {
    kind: WatchKind;
    title: string;
    year: number | null;
    guid: string | null;
    pairs: Set<string>;
    latest: { season: number; episode: number } | null;
    latestAt: number;
    lastAt: number;
  }
  const groups = new Map<string, Acc>();
  for (const e of events) {
    const at = validTime(sec(e.stoppedAt) ?? sec(e.startedAt)) ?? 0;
    const started = sec(e.startedAt) ?? 0;
    const isShow = e.kind === 'episode';
    const title = isShow ? (e.showTitle ?? e.title) : e.title;
    const guid = isShow ? e.showGuid : e.itemGuid?.startsWith('plex://movie/') ? e.itemGuid : null;
    const id = guid ?? (isShow ? `show|${normalizeTitle(title).norm}` : nameKey('movie', title, e.year));
    let g = groups.get(id);
    if (!g) {
      g = { kind: isShow ? 'show' : 'movie', title, year: e.year, guid, pairs: new Set(), latest: null, latestAt: -1, lastAt: 0 };
      groups.set(id, g);
    }
    g.lastAt = Math.max(g.lastAt, at);
    if (isShow && e.season !== null && e.episode !== null) {
      g.pairs.add(`${e.season}:${e.episode}`);
      if (started > g.latestAt) {
        g.latestAt = started;
        g.latest = { season: e.season, episode: e.episode };
        g.title = title;
      }
    }
  }
  const out: RecentEntry[] = [];
  for (const g of groups.values()) {
    const ids: TitleIds = { kind: g.kind, title: g.title, year: g.kind === 'movie' ? g.year : null, plexGuid: g.guid };
    if (marksFor(marks, ids).dismissed === 'not_mine') continue;
    if (g.kind === 'show' && g.guid === null && marks.notMineShowNames.has(showNameOf(nameKey('show', g.title)))) continue;
    out.push(
      g.kind === 'show'
        ? { kind: 'show', title: g.title, episodes: Math.max(1, g.pairs.size), latest: g.latest, lastAt: g.lastAt }
        : { kind: 'movie', title: g.title, lastAt: g.lastAt },
    );
  }
  return out;
}

/** A stored Title State as the exclusion input (D-18). */
export function historyFacts(row: RecoTitleRow): HistoryFacts {
  return {
    titleKey: row.titleKey,
    kind: row.kind,
    title: row.title,
    year: row.year,
    plexGuid: row.plexGuid,
    tmdbId: row.tmdbId,
    tvdbId: row.tvdbId,
    imdbId: row.imdbId,
    episodesWatched: row.episodesWatched,
    plexWatched: row.plexWatched,
    eventWatched: row.eventWatchedEpisodes > 0,
    resumePercent: row.resumePercent,
    nextResume: row.nextResume,
  };
}

/** A live mark as the exclusion input (D-18) — a watch statement only (DESIGN-051 D-07: see `statementMarks`). */
export function liveMark(m: WatchMarkRow & { action: MarkAction }): LiveMark {
  return {
    titleKey: m.titleKey,
    kind: m.kind,
    title: m.title,
    year: m.year,
    plexGuid: m.plexGuid,
    tmdbId: m.tmdbId,
    tvdbId: m.tvdbId,
    imdbId: m.imdbId,
    action: m.action,
  };
}

/**
 * `recommend` (D-16..D-20) from its inputs: the exclusion sets from the Title States and live marks, the
 * Taste Profile and genre exemplars from the Ever Watched titles, then the pure pipeline.
 */
export function recommendations(
  inputs: RecommendInputs,
  marks: readonly WatchMarkRow[],
  opts: { kind?: WatchKind | 'any' | null; genre?: string | null; kids?: boolean; now: number },
): Recommendations {
  // DESIGN-051 D-07: Watchlist Changes never change recommendations — only watch statements count.
  const live = statementMarks(marks).filter((m) => !m.revertedAt);
  const index = indexMarks(live);
  const exclusions = buildExclusions(inputs.titles.map(historyFacts), live.map(liveMark));
  const profileTitles: ProfileTitle[] = inputs.titles.map((t) => {
    const m = marksFor(index, t);
    return {
      kind: t.kind,
      title: t.title,
      genres: t.genres,
      isKids: t.isKids,
      everWatched: isEverWatched(historyFacts(t), { watched: m.watched, notMine: m.dismissed === 'not_mine' }),
      dismissed: m.dismissed,
      episodesWatched: t.episodesWatched,
      episodesTotal: t.episodesTotal,
      eventWatchedEpisodes: t.eventWatchedEpisodes,
      lastWatchedAt: sec(t.lastWatchedAt),
    };
  });
  return pickRecommendations({
    candidates: inputs.candidates,
    exclusions,
    profile: buildTasteProfile(profileTitles, opts.now),
    genreTitles: genreExemplars(profileTitles),
    kind: opts.kind ?? 'any',
    genre: opts.genre ?? null,
    kids: opts.kids === true,
    now: opts.now,
  });
}

/**
 * `watch_status` (D-21) for a resolved title: its Title State (when the owner has one) with the D-10
 * state, Ever Watched (T-247: Plex ∪ events ∪ a live `watched` mark, minus `not_mine`), dismissals, and
 * whether it is on Plex (its `on_plex`, else the ledger's match).
 */
export function watchStatusView(input: {
  title: { kind: WatchKind; title: string; year: number | null } & TitleIds & { titleKey?: string | null };
  row: WatchTitleRow | null;
  marks: MarkIndex;
  onPlexElsewhere: boolean;
  now: number;
  /** DESIGN-051 D-02: on the owner's overlaid watchlist; null when the principal's watchlist is not read. */
  onWatchlist?: boolean | null;
}): WatchStatusView {
  const { row } = input;
  const m = marksFor(input.marks, row ?? input.title);
  const onWatchlist = input.onWatchlist ?? null;
  if (!row) {
    return {
      kind: input.title.kind,
      title: input.title.title,
      year: input.title.year,
      onPlex: input.onPlexElsewhere,
      state: 'unstarted',
      everWatched: m.watched && m.dismissed !== 'not_mine',
      lastWatchedAt: null,
      dismissed: m.dismissed,
      onWatchlist,
    };
  }
  const lastWatchedAt = sec(row.lastWatchedAt);
  const next =
    row.nextSeason !== null && row.nextEpisode !== null
      ? { season: row.nextSeason, episode: row.nextEpisode, resume: row.nextResume }
      : null;
  const state =
    row.kind === 'show'
      ? showState(
          { episodesWatched: row.episodesWatched ?? 0, episodesTotal: row.episodesTotal ?? 0, next, lastWatchedAt },
          { showStatus: row.showStatus, now: input.now },
        )
      : movieState({ plexWatched: row.plexWatched, resumePercent: row.resumePercent, lastWatchedAt }, { now: input.now });
  return {
    kind: row.kind,
    title: row.title,
    year: row.year,
    onPlex: row.onPlex.length > 0 || input.onPlexElsewhere,
    state,
    everWatched: isEverWatched(
      { episodesWatched: row.episodesWatched, plexWatched: row.plexWatched, eventWatched: row.eventWatchedEpisodes > 0 },
      { watched: m.watched, notMine: m.dismissed === 'not_mine' },
    ),
    episodesWatched: row.episodesWatched,
    episodesTotal: row.episodesTotal,
    eventWatchedEpisodes: row.eventWatchedEpisodes,
    next,
    rewatch: row.rewatch,
    resumePercent: row.resumePercent,
    lastWatchedAt,
    dismissed: m.dismissed,
    onWatchlist,
  };
}

// ---------------------------------------------------------------------------------------------------
// The watchlist (ADR-092 / DESIGN-051 D-02)

type FactsIds = TitleIds & { titleKey?: string | null };

/**
 * DESIGN-051 D-02 "on Plex" (recommend's DESIGN-049 D-17 rule, PLAN-071 ruling 11): a live ledger item with a
 * shared external id and a `media_plex_matches` row, or the owner's Title State of the title with `on_plex`.
 */
export function onPlexFor(t: FactsIds, facts: TitleFacts): boolean {
  if (facts.ledger.some((l) => l.onPlex && ledgerMatchesTitle(t, l))) return true;
  return facts.titles.some((r) => r.onPlex.length > 0 && sameWatchlistTitle(r, t));
}

/** The owner's Title State of a title among the facts: the exact key first. */
function titleRowFor(t: FactsIds, facts: TitleFacts): TitleFactsRow | null {
  const rows = facts.titles.filter((r) => sameWatchlistTitle(r, t));
  return rows.find((r) => r.titleKey === t.titleKey) ?? rows[0] ?? null;
}

/**
 * The `watchlist` answer's items (DESIGN-051 D-02): each entry with its year and kind as plex.tv lists them, the
 * D-02 "on Plex" rule, and `started` when its Title State is in progress or stalled, `watched` when it is Ever
 * Watched (T-247: Plex ∪ events ∪ a live `watched` mark) and not unfinished. A title marked `not_mine` is
 * someone else's viewing, so it is neither.
 */
export function watchlistItems(
  entries: readonly WatchlistEntry[],
  facts: TitleFacts,
  marks: MarkIndex,
  now: number,
): WatchlistItemView[] {
  return entries.map((e) => {
    const row = titleRowFor(e, facts);
    const m = marksFor(marks, row ?? e);
    let progress: WatchlistItemView['progress'] = null;
    if (m.dismissed !== 'not_mine') {
      if (row) {
        const lastWatchedAt = sec(row.lastWatchedAt);
        const next =
          row.nextSeason !== null && row.nextEpisode !== null
            ? { season: row.nextSeason, episode: row.nextEpisode, resume: row.nextResume }
            : null;
        const state =
          row.kind === 'show'
            ? showState(
                { episodesWatched: row.episodesWatched ?? 0, episodesTotal: row.episodesTotal ?? 0, next, lastWatchedAt },
                { showStatus: row.showStatus, now },
              )
            : movieState({ plexWatched: row.plexWatched, resumePercent: row.resumePercent, lastWatchedAt }, { now });
        if (state === 'in_progress' || state === 'stalled') progress = 'started';
        else if (
          isEverWatched(
            { episodesWatched: row.episodesWatched, plexWatched: row.plexWatched, eventWatched: row.eventWatchedEpisodes > 0 },
            { watched: m.watched },
          )
        )
          progress = 'watched';
      } else if (m.watched) {
        progress = 'watched';
      }
    }
    return { kind: e.kind, title: e.title, year: e.year, onPlex: onPlexFor(e, facts), progress };
  });
}
