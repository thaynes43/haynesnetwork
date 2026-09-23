// The watch tools' views (DESIGN-049 D-10, D-15, D-18..D-21): stored Title States, events and live marks →
// the inputs of the spoken formatters. Pure — the MCP layer reads (queries), revalidates (the domain), then
// builds its answer here and formats it (format.ts).
import type { WatchEventRow, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import type { RecentEntry, UnfinishedItem, WatchStatusView } from './format';
import { keysOf, nameKey } from './identity';
import { normalizeTitle } from './normalize';
import { compareUnfinished, movieState, showState } from './progress';
import type { RecommendInputs, RecoTitleRow } from './queries/answers';
import {
  buildExclusions,
  buildTasteProfile,
  genreExemplars,
  isEverWatched,
  pickRecommendations,
  type Dismissal,
  type HistoryFacts,
  type LiveMark,
  type ProfileTitle,
  type Recommendations,
} from './recommend';
import type { TitleIds, WatchKind } from './types';
import { validTime } from './util';

const sec = (d: Date | null | undefined): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

/** Live marks indexed by kind-scoped identity key. */
export interface MarkIndex {
  watched: ReadonlySet<string>;
  notInterested: ReadonlySet<string>;
  notMine: ReadonlySet<string>;
}

export function indexMarks(marks: readonly WatchMarkRow[]): MarkIndex {
  const watched = new Set<string>();
  const notInterested = new Set<string>();
  const notMine = new Set<string>();
  for (const m of marks) {
    if (m.revertedAt) continue;
    const set = m.action === 'watched' ? watched : m.action === 'not_interested' ? notInterested : notMine;
    for (const k of keysOf(m)) set.add(`${m.kind}|${k}`);
  }
  return { watched, notInterested, notMine };
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
export function unfinishedItems(
  rows: readonly WatchTitleRow[],
  marks: MarkIndex,
  opts: { kind: WatchKind | 'any'; kids: boolean; now: number },
): Array<{ row: WatchTitleRow; item: UnfinishedItem }> {
  const out: Array<{ row: WatchTitleRow; item: UnfinishedItem }> = [];
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
 * marked `not_mine` (someone else's viewing on the owner's account) is left out (PLAN-068 S7).
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

/** A live mark as the exclusion input (D-18). */
export function liveMark(m: WatchMarkRow): LiveMark {
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
  const live = marks.filter((m) => !m.revertedAt);
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
}): WatchStatusView {
  const { row } = input;
  const m = marksFor(input.marks, row ?? input.title);
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
  };
}
