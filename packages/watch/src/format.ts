// Spoken answers (DESIGN-049 D-21, D-20, D-14, D-15): the plain-text results of the seven watch tools.
// Short natural sentences that lead with the count, name episodes as "season 3 episode 1", say dates
// the way people do, list at most `limit` items then "And N more.", and never exceed 1,200 characters.

import { canonicalGenre } from './genres';
import { compareUnfinished, type EpisodeRef, type MovieState, type ShowState } from './progress';
import type { Dismissal, MarkAction, Recommendations, ScoredPick } from './recommend';
import type { ResolverCandidate } from './resolver';
import {
  capSpoken,
  capSpokenList,
  countWord,
  plural,
  spokenDate,
  spokenSince,
  spokenTitle,
  type DateOptions,
} from './spoken';
import type { WatchKind } from './types';
import { compareText, validTime } from './util';

/** Every date-bearing formatter takes `now` (unix seconds) and an optional time zone. */
export interface SpokenOptions extends DateOptions {
  now: number;
}

type NextRef = EpisodeRef & { resume?: boolean | null };

function episodeName(ref: EpisodeRef): string {
  return `season ${ref.season} episode ${ref.episode}`;
}

function nextPhrase(next: NextRef): string {
  return next.resume ? `resume ${episodeName(next)}` : `next is ${episodeName(next)}`;
}

function sentence(clauses: ReadonlyArray<string | null | undefined | false>): string {
  return clauses.filter((c): c is string => typeof c === 'string' && c.length > 0).join(', ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function titleAndYear(title: string, year: number | null | undefined): string {
  const t = spokenTitle(title);
  return year ? `${t} (${year})` : t;
}

function yearAndKind(year: number | null | undefined, kind: WatchKind): string {
  if (!year) return `a ${kind}`;
  const article = year >= 1800 && year < 1900 ? 'an' : 'a';
  return `${article} ${year} ${kind}`;
}

function percent(n: number): string {
  return `${Math.round(n)} percent in`;
}

// ---------------------------------------------------------------------------------------------------
// unfinished

export interface UnfinishedItem {
  kind: WatchKind;
  title: string;
  state: 'in_progress' | 'stalled';
  lastWatchedAt: number | null;
  episodesWatched?: number | null;
  episodesTotal?: number | null;
  next?: NextRef | null;
  rewatch?: boolean | null;
  /** Movies. */
  resumePercent?: number | null;
}

function unfinishedLead(items: readonly UnfinishedItem[], kind: WatchKind | 'any'): string {
  const shows = items.filter((i) => i.kind === 'show').length;
  const movies = items.length - shows;
  const counted = (n: number, noun: string) =>
    n === 0
      ? `No unfinished ${noun}s.`
      : `${countWord(n, true)} unfinished ${noun}${n === 1 ? '' : 's'}.`;
  if (kind === 'show') return counted(items.length, 'show');
  if (kind === 'movie') return counted(items.length, 'movie');
  if (items.length === 0) return 'Nothing unfinished.';
  if (movies === 0) return counted(shows, 'show');
  if (shows === 0) return counted(movies, 'movie');
  return `${countWord(items.length, true)} unfinished: ${countWord(shows)} ${shows === 1 ? 'show' : 'shows'} and ${countWord(movies)} ${movies === 1 ? 'movie' : 'movies'}.`;
}

function activeSentence(it: UnfinishedItem, first: boolean, opts: SpokenOptions): string {
  const last = validTime(it.lastWatchedAt);
  const date = last === null ? null : spokenDate(last, opts.now, opts);
  const relative = date === 'today' || date === 'yesterday';
  const when = date === null ? null : first || relative ? `last watched ${date}` : date;
  if (it.kind === 'movie') {
    const pct = typeof it.resumePercent === 'number' ? percent(it.resumePercent) : null;
    return `${spokenTitle(it.title)} (movie): ${sentence([pct, when]) || 'in progress'}.`;
  }
  const name = `${spokenTitle(it.title)}${it.rewatch ? ' (rewatch)' : ''}`;
  const w = it.episodesWatched ?? 0;
  const t = it.episodesTotal ?? 0;
  const counts = first && w > 0 && t > 0 ? `${w} of ${t} watched` : null;
  const next = it.next ? nextPhrase(it.next) : null;
  return `${name}: ${sentence([counts, next, when]) || 'in progress'}.`;
}

function stalledSentence(it: UnfinishedItem, opts: SpokenOptions): string {
  const last = validTime(it.lastWatchedAt);
  const since = last === null ? null : `untouched ${spokenSince(last, opts.now, opts)}`;
  if (it.kind === 'movie') {
    const pct = typeof it.resumePercent === 'number' ? percent(it.resumePercent) : null;
    return `${sentence([`${spokenTitle(it.title)} (movie)`, pct, since])}.`;
  }
  const w = it.episodesWatched ?? 0;
  const t = it.episodesTotal ?? 0;
  const progress =
    w > 0 && t > 0 ? `${w} of ${t}` : it.next ? `started ${episodeName(it.next)}` : null;
  const name = `${spokenTitle(it.title)}${it.rewatch ? ' (rewatch)' : ''}`;
  return `${sentence([name, progress, since])}.`;
}

/**
 * `unfinished` (D-21): "Three unfinished shows. Silo: 30 of 40 watched, next is season 3 episode 1,
 * last watched on September 20. For All Mankind: next is season 5 episode 3, on September 12.
 * Stalled: The Righteous Gemstones, 36 of 45, untouched since March 2025." Items are ordered
 * in-progress first, newest first ({@link compareUnfinished}); the count is the whole list, then at
 * most `limit` items and "And N more."
 */
export function formatUnfinished(
  items: readonly UnfinishedItem[],
  opts: SpokenOptions & { limit: number; kind?: WatchKind | 'any' },
): string {
  const sorted = [...items].sort(compareUnfinished);
  const lead = unfinishedLead(sorted, opts.kind ?? 'show');
  if (sorted.length === 0) return lead;
  const shown = sorted.slice(0, Math.max(0, Math.floor(opts.limit)));
  let firstActive = true;
  let firstStalled = true;
  const sentences = shown.map((it) => {
    if (it.state === 'stalled') {
      const s = stalledSentence(it, opts);
      const out = firstStalled ? `Stalled: ${s}` : s;
      firstStalled = false;
      return out;
    }
    const s = activeSentence(it, firstActive, opts);
    firstActive = false;
    return s;
  });
  return capSpokenList({ lead, items: sentences, more: sorted.length - shown.length });
}

// ---------------------------------------------------------------------------------------------------
// recommend

function pickSentence(p: ScoredPick): string {
  const c = p.candidate;
  return `${spokenTitle(c.title)}, ${yearAndKind(c.year, c.kind)}, ${p.reason}.`;
}

/**
 * `recommend` (D-20/D-21): "Five picks on Plex. Foundation, a 2021 show, because you watched The
 * Expanse. … Not on Plex yet: Dark Matter, a 2024 show, on your watchlist." Up to `limit` on-Plex
 * picks after skipping `offset`, "And N more." when more remain, then at most two not-on-Plex picks
 * (the next two on each later page, so "more" does not repeat them).
 */
export function formatRecommendations(
  recs: Recommendations,
  opts: {
    limit: number;
    offset?: number;
    genre?: string | null;
    kids?: boolean;
    kind?: WatchKind | 'any' | null;
  },
): string {
  if (recs.onPlex.length === 0 && recs.notOnPlex.length === 0) {
    return 'Nothing new matches that. Try another genre or kind.';
  }
  const limit = Math.max(0, Math.floor(opts.limit));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const page = recs.onPlex.slice(offset, offset + limit);
  const more = Math.max(0, recs.onPlex.length - offset - page.length);
  const pageIndex = limit > 0 ? Math.floor(offset / limit) : 0;
  const notOnPlex = recs.notOnPlex.slice(pageIndex * 2, pageIndex * 2 + 2);
  if (page.length === 0 && notOnPlex.length === 0) {
    return 'No more picks. Try another genre or kind.';
  }

  const genre = opts.genre ? canonicalGenre(opts.genre) : null;
  const kidsWord = opts.kids || genre === 'kids' ? "kids'" : null;
  const genreWord = genre === 'kids' ? null : genre;
  const kindWord = opts.kind === 'show' || opts.kind === 'movie' ? opts.kind : null;
  const noun = [genreWord, kidsWord, kindWord, 'pick'].filter(Boolean).join(' ');
  const lead =
    page.length > 0
      ? `${countWord(page.length, true)} ${noun}${page.length === 1 ? '' : 's'} on Plex.`
      : `No ${offset > 0 ? 'more ' : ''}${noun}s on Plex.`;
  const tail = notOnPlex.map((p, i) =>
    i === 0 ? `Not on Plex yet: ${pickSentence(p)}` : pickSentence(p),
  );
  return capSpokenList({ lead, items: page.map(pickSentence), more, tail });
}

// ---------------------------------------------------------------------------------------------------
// watch_status

export interface WatchStatusView {
  kind: WatchKind;
  title: string;
  year: number | null;
  onPlex: boolean;
  /** {@link showState} / {@link movieState} of the Plex progress. */
  state: ShowState | MovieState;
  /** Ever Watched (T-247). */
  everWatched: boolean;
  episodesWatched?: number | null;
  episodesTotal?: number | null;
  eventWatchedEpisodes?: number | null;
  next?: NextRef | null;
  rewatch?: boolean | null;
  resumePercent?: number | null;
  lastWatchedAt: number | null;
  dismissed?: Dismissal | null;
}

const NOT_MINE_BODY = "marked as someone else's viewing, so it isn't in your history";

function allEpisodes(total: number): string {
  return total === 1 ? 'the one episode watched' : `all ${total} episodes watched`;
}

function showStatusBody(v: WatchStatusView, opts: SpokenOptions): string {
  if (v.dismissed === 'not_mine') return NOT_MINE_BODY;
  const w = v.episodesWatched ?? 0;
  const t = v.episodesTotal ?? 0;
  const last = validTime(v.lastWatchedAt);
  const when = last === null ? null : spokenDate(last, opts.now, opts);
  const counts = t > 0 && w >= t ? allEpisodes(t) : w > 0 && t > 0 ? `${w} of ${t} watched` : null;
  const rewatch = v.rewatch ? 'rewatching' : null;
  const next = v.next ? nextPhrase(v.next) : null;
  switch (v.state) {
    case 'finished':
      return sentence([counts, when ? `finished ${when}` : 'finished']);
    case 'caught_up':
      return sentence([counts, 'caught up', when && `last watched ${when}`]);
    case 'in_progress':
    case 'taster':
      return sentence([rewatch, counts, next, when && `last watched ${when}`]);
    case 'stalled':
      return sentence([
        rewatch,
        counts,
        next,
        last !== null && `untouched ${spokenSince(last, opts.now, opts)}`,
      ]);
    default: {
      const history = v.eventWatchedEpisodes ?? 0;
      if (history > 0) {
        return sentence([
          `watched ${plural(history, 'episode')} before`,
          when && `last watched ${when}`,
        ]);
      }
      return v.everWatched ? 'marked as watched' : 'not watched yet';
    }
  }
}

function movieStatusBody(v: WatchStatusView, opts: SpokenOptions): string {
  if (v.dismissed === 'not_mine') return NOT_MINE_BODY;
  const last = validTime(v.lastWatchedAt);
  const when = last === null ? null : spokenDate(last, opts.now, opts);
  const pct = typeof v.resumePercent === 'number' ? percent(v.resumePercent) : null;
  switch (v.state) {
    case 'in_progress':
      return sentence([pct, when && `last watched ${when}`]);
    case 'stalled':
      return sentence([pct, last !== null && `untouched ${spokenSince(last, opts.now, opts)}`]);
    case 'finished':
      return when ? `watched ${when}` : 'watched';
    default:
      if (!v.everWatched) return 'not watched yet';
      return when ? `watched ${when}` : 'watched before';
  }
}

/**
 * `watch_status` (D-21): "The Expanse (2015 show): all 62 episodes watched, finished in March 2025.
 * On Plex." Covers progress, a rewatch, history the Plex state no longer shows ("watched 62 episodes
 * before"), dismissals and availability.
 */
export function formatWatchStatus(v: WatchStatusView, opts: SpokenOptions): string {
  const head = `${spokenTitle(v.title)} (${v.year ? `${v.year} ` : ''}${v.kind})`;
  const body = v.kind === 'show' ? showStatusBody(v, opts) : movieStatusBody(v, opts);
  const parts = [`${head}: ${body || 'no progress yet'}.`];
  if (v.dismissed === 'not_interested') parts.push("You dismissed it, so it won't be suggested.");
  parts.push(v.onPlex ? 'On Plex.' : 'Not on Plex.');
  return capSpoken(parts.join(' '));
}

// ---------------------------------------------------------------------------------------------------
// recent_history

export interface RecentEntry {
  kind: WatchKind;
  title: string;
  /** Distinct episodes watched in the window (shows). */
  episodes?: number | null;
  /** The latest episode watched in the window (shows). */
  latest?: EpisodeRef | null;
  /** When it was last watched (unix seconds). */
  lastAt: number;
}

const WINDOW_WORDS: Readonly<Record<number, string>> = {
  1: 'day',
  7: 'week',
  14: 'two weeks',
  21: 'three weeks',
  28: 'four weeks',
  30: 'month',
  31: 'month',
  60: 'two months',
  90: 'three months',
  180: 'six months',
  365: 'year',
};

function windowPhrase(days: number): string {
  const d = Math.max(1, Math.floor(days));
  return `in the last ${WINDOW_WORDS[d] ?? `${d} days`}`;
}

function recentSentence(e: RecentEntry, opts: SpokenOptions): string {
  const title = spokenTitle(e.title);
  const date = spokenDate(e.lastAt, opts.now, opts);
  if (e.kind === 'movie') return `${title}, a movie, ${date}.`;
  const n = e.episodes ?? 1;
  if (n <= 1) return `${sentence([title, e.latest ? episodeName(e.latest) : '1 episode', date])}.`;
  const latest = e.latest ? `latest ${episodeName(e.latest)} ${date}` : `latest ${date}`;
  return `${sentence([title, plural(n, 'episode'), latest])}.`;
}

/**
 * `recent_history` (D-21): "In the last two weeks: Silo, 5 episodes, latest season 2 episode 10 on
 * September 20. WarGames, a movie, on September 5." Newest first, at most `limit`, then "And N more."
 */
export function formatRecentHistory(
  entries: readonly RecentEntry[],
  opts: SpokenOptions & { days: number; limit: number },
): string {
  const window = windowPhrase(opts.days);
  if (entries.length === 0) return `Nothing watched ${window}.`;
  const sorted = [...entries].sort((a, b) => b.lastAt - a.lastAt || compareText(a.title, b.title));
  const shown = sorted.slice(0, Math.max(0, Math.floor(opts.limit)));
  return capSpokenList({
    lead: `${capitalize(window)}:`,
    items: shown.map((e) => recentSentence(e, opts)),
    more: sorted.length - shown.length,
  });
}

// ---------------------------------------------------------------------------------------------------
// mark_watched, dismiss, undo_last_change

export type MarkScope = 'movie' | 'show' | 'season' | 'episode' | 'through';
export type PlexWriteResult = 'written' | 'partial' | 'failed' | 'not_on_plex' | 'none';

export interface MarkResultView {
  kind: WatchKind;
  title: string;
  year: number | null;
  scope: MarkScope;
  season?: number | null;
  episode?: number | null;
  plexResult: PlexWriteResult;
  /** Episodes the scope covers (show, season, through). */
  episodes?: number | null;
  /** Items that actually changed in Plex (`flipped.length`); 0 means it was already watched. */
  flipped?: number | null;
}

function markSubject(r: {
  title: string;
  year: number | null;
  scope?: MarkScope | null;
  season?: number | null;
  episode?: number | null;
}): { subject: string; through: string } {
  const label = titleAndYear(r.title, r.year);
  const s = r.season ?? null;
  const e = r.episode ?? null;
  if (r.scope === 'season' && s !== null) {
    return { subject: `season ${s} of ${label}`, through: '' };
  }
  if (r.scope === 'episode' && s !== null && e !== null) {
    return { subject: `${label} ${episodeName({ season: s, episode: e })}`, through: '' };
  }
  if (r.scope === 'through' && s !== null && e !== null) {
    return { subject: label, through: ` through ${episodeName({ season: s, episode: e })}` };
  }
  return { subject: label, through: '' };
}

function episodeCount(r: MarkResultView): string {
  const n = r.episodes ?? null;
  if (n === null || n <= 0) return '';
  if (r.scope === 'show') return n === 1 ? ', its one episode' : `, all ${n} episodes`;
  if (r.scope === 'season' || r.scope === 'through') return `, ${plural(n, 'episode')}`;
  return '';
}

/**
 * The `mark_watched` read-back (D-14 step 8): "Marked Severance (2022) as watched in Plex, all 19
 * episodes." / "Noted Dark Matter (2024) as watched. It isn't on Plex, so only your history
 * changed." Covers each scope, an already-watched title, and partial or failed Plex writes.
 */
export function formatMarkResult(r: MarkResultView): string {
  const { subject, through } = markSubject(r);
  const count = episodeCount(r);
  switch (r.plexResult) {
    case 'not_on_plex':
      return capSpoken(
        `Noted ${subject}${through} as watched. It isn't on Plex, so only your history changed.`,
      );
    case 'failed':
      return capSpoken(
        `Noted ${subject}${through} as watched in your history, but Plex didn't take the change. Try again in a minute.`,
      );
    case 'partial':
      return capSpoken(
        `Marked ${subject}${through} as watched, but only part of it reached Plex. Say it again to retry the rest.`,
      );
    default:
      if (r.flipped === 0) {
        return capSpoken(`${capitalize(subject)} was already watched in Plex${through}${count}.`);
      }
      return capSpoken(`Marked ${subject} as watched in Plex${through}${count}.`);
  }
}

/** The `dismiss` read-back (D-15). Dismissals never touch Plex. */
export function formatDismissResult(r: {
  kind: WatchKind;
  title: string;
  year: number | null;
  reason: Dismissal;
}): string {
  const label = titleAndYear(r.title, r.year);
  if (r.reason === 'not_mine') {
    return capSpoken(
      `Got it. ${label} is marked as someone else's viewing, so it's out of your history and picks. Plex is unchanged.`,
    );
  }
  return capSpoken(`Got it. I won't suggest ${label} again.`);
}

export type UndoView =
  | { undone: false }
  | {
      undone: true;
      action: MarkAction;
      kind: WatchKind;
      title: string;
      year: number | null;
      scope?: MarkScope | null;
      season?: number | null;
      episode?: number | null;
      /** The unscrobble outcome for a `watched` mark (`none` when nothing had changed in Plex). */
      revertResult?: 'written' | 'partial' | 'failed' | 'none' | null;
      /** Items put back to unwatched. */
      episodes?: number | null;
    };

/** The `undo_last_change` read-back (D-15). */
export function formatUndoResult(r: UndoView): string {
  if (!r.undone) return 'Nothing to undo from the past day.';
  const label = titleAndYear(r.title, r.year);
  if (r.action === 'not_interested') return capSpoken(`Undone. ${label} can be suggested again.`);
  if (r.action === 'not_mine') return capSpoken(`Undone. ${label} counts as your viewing again.`);
  const { subject, through } = markSubject(r);
  const n = r.episodes ?? 0;
  switch (r.revertResult) {
    case 'written':
      return capSpoken(
        `Undone. ${capitalize(subject)}${through} is back to unwatched in Plex${n > 1 ? `, ${n} episodes` : ''}.`,
      );
    case 'partial':
      return capSpoken(`Undid the mark on ${subject}${through}, but only part of it reached Plex.`);
    case 'failed':
      return capSpoken(
        `Undid the mark on ${subject}${through} in your history, but Plex didn't take the change, so it still shows as watched there.`,
      );
    default:
      return capSpoken(`Undone. ${capitalize(subject)}${through} is no longer marked as watched.`);
  }
}

// ---------------------------------------------------------------------------------------------------
// resolver outcomes and fixed answers

function spokenQuery(query: string): string {
  const q = spokenTitle(query)
    .replace(/[\s.?!,;:]+$/, '')
    .slice(0, 100)
    .trim();
  return q || 'that';
}

function optionLabel(o: Pick<ResolverCandidate, 'title' | 'year' | 'kind'>): string {
  return `${spokenTitle(o.title)} (${o.year ? `${o.year}, ` : ''}${o.kind})`;
}

/**
 * An ambiguous title (D-13/D-21): "More than one match for Dune: Dune (2021, movie), Dune (1984,
 * movie), Dune: Prophecy (2024, show). Which one?" One option asks "Did you mean …?".
 */
export function formatAmbiguous(
  query: string,
  options: readonly Pick<ResolverCandidate, 'title' | 'year' | 'kind'>[],
): string {
  const labels = options.slice(0, 3).map(optionLabel);
  if (labels.length === 0) return formatNotFound(query);
  if (labels.length === 1) return capSpoken(`Did you mean ${labels[0]}?`);
  return capSpoken(
    `More than one match for ${spokenQuery(query)}: ${labels.join(', ')}. Which one?`,
  );
}

/** Nothing matched (D-13): "I couldn't find anything called Severence." */
export function formatNotFound(query: string, opts: { kind?: WatchKind | null } = {}): string {
  const what = opts.kind ? `a ${opts.kind} called` : 'anything called';
  return capSpoken(`I couldn't find ${what} ${spokenQuery(query)}.`);
}

/** No owner row yet (D-03). */
export function formatNotReady(): string {
  return "Watch history isn't ready yet.";
}

/** The `isError` text for an unexpected failure (D-06). */
export function formatWatchError(): string {
  return 'Watch history hit an error. Try again in a minute.';
}
