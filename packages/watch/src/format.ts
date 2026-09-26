// Spoken answers (DESIGN-049 D-21, D-20, D-14, D-15; DESIGN-051 D-02): the plain-text results of the nine
// watch tools.
// Short natural sentences that lead with the count, name episodes as "season 3 episode 1", say dates
// the way people do, list at most `limit` items then "And N more.", and never exceed 1,200 characters.

import { canonicalGenre } from './genres';
import { compareUnfinished, type EpisodeRef, type MovieState, type ShowState } from './progress';
import type { WatchMarkAction } from '@hnet/db/schema';
import type { Dismissal, Recommendations, ScoredPick } from './recommend';
import type { ResolverCandidate } from './resolver';
import {
  SPOKEN_MAX_CHARS,
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
  /**
   * DESIGN-051 D-02 — on the owner's (overlaid) watchlist. `null` / absent for a principal whose watchlist the
   * app cannot read (not the Server Owner): the answer keeps DESIGN-049's "On Plex." / "Not on Plex.".
   */
  onWatchlist?: boolean | null;
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

/** "The Expanse (2015 show)" — a title with its year and kind (watch_status, the watchlist answers). */
function titleYearKind(title: string, year: number | null | undefined, kind: WatchKind): string {
  return `${spokenTitle(title)} (${year ? `${year} ` : ''}${kind})`;
}

/**
 * The availability sentence (DESIGN-051 D-02): explicit both ways, so an agent never has to infer — "On Plex
 * and on your watchlist." · "On Plex, not on your watchlist." · "Not on Plex, but on your watchlist." · "Not
 * on Plex or your watchlist." Without a watchlist to read (`onWatchlist` null), DESIGN-049's sentence.
 */
function availabilitySentence(onPlex: boolean, onWatchlist: boolean | null | undefined): string {
  if (onWatchlist === null || onWatchlist === undefined) return onPlex ? 'On Plex.' : 'Not on Plex.';
  if (onPlex) return onWatchlist ? 'On Plex and on your watchlist.' : 'On Plex, not on your watchlist.';
  return onWatchlist ? 'Not on Plex, but on your watchlist.' : 'Not on Plex or your watchlist.';
}

/**
 * `watch_status` (D-21): "The Expanse (2015 show): all 62 episodes watched, finished in March 2025.
 * On Plex, not on your watchlist." Covers progress, a rewatch, history the Plex state no longer shows
 * ("watched 62 episodes before"), dismissals, and availability on Plex and on the watchlist (DESIGN-051 D-02).
 */
export function formatWatchStatus(v: WatchStatusView, opts: SpokenOptions): string {
  const head = titleYearKind(v.title, v.year, v.kind);
  const body = v.kind === 'show' ? showStatusBody(v, opts) : movieStatusBody(v, opts);
  const parts = [`${head}: ${body || 'no progress yet'}.`];
  if (v.dismissed === 'not_interested') parts.push("You dismissed it, so it won't be suggested.");
  parts.push(availabilitySentence(v.onPlex, v.onWatchlist));
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
  /**
   * ADR-091 C-04 — the mark was recorded in the history of an account that is not the Server Owner's: Plex
   * write-back is owner-only, so nothing was sent to Plex.
   */
  historyOnly?: boolean;
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
 * changed." Covers each scope, an already-watched title, partial or failed Plex writes, and a show
 * Plex lists with specials only (`none`: specials never take part in a mark, DESIGN-049 D-26).
 */
export function formatMarkResult(r: MarkResultView): string {
  const { subject, through } = markSubject(r);
  const count = episodeCount(r);
  if (r.historyOnly) {
    return capSpoken(
      `Noted ${subject}${through} as watched in your history. Only the server owner's marks change Plex.`,
    );
  }
  switch (r.plexResult) {
    case 'not_on_plex':
      return capSpoken(
        `Noted ${subject}${through} as watched. It isn't on Plex, so only your history changed.`,
      );
    case 'none':
      return capSpoken(
        `Noted ${subject}${through} as watched. Plex only lists specials for it, so nothing changed there.`,
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
      action: WatchMarkAction;
      kind: WatchKind;
      title: string;
      year: number | null;
      scope?: MarkScope | null;
      season?: number | null;
      episode?: number | null;
      /**
       * The Plex outcome: the unscrobble for a `watched` mark (`none` when nothing had changed in Plex); the
       * inverse watchlist call for a Watchlist Change (DESIGN-051 D-04).
       */
      revertResult?: 'written' | 'partial' | 'failed' | 'none' | null;
      /** Items put back to unwatched. */
      episodes?: number | null;
      /** A Watchlist Change: whether the title is on Plex (the Seerr sentences, DESIGN-051 D-04). */
      onPlex?: boolean | null;
      /** A Watchlist Change: what undoing it came to (DESIGN-051 D-04, PR #580 ruling 2). */
      watchlistOutcome?: WatchlistUndoOutcome | null;
    };

/**
 * What undoing a Watchlist Change came to (DESIGN-051 D-04, PR #580 ruling 2): `reverted` (the inverse call
 * landed), `cleared` (a failed add's removal landed), `not_sent` (the change never went out: nothing to undo),
 * `left_as_is` (a failed remove: its inverse, an add, could download, so nothing was sent), `failed` (the
 * inverse call failed; the change stays for the next undo), `unknown` (plex.tv never said).
 */
export type WatchlistUndoOutcome = 'reverted' | 'cleared' | 'not_sent' | 'left_as_is' | 'failed' | 'unknown';

/**
 * DESIGN-051 D-15j — the Seerr sentence of an add whose own answer may never have been heard: an "already on" add
 * (a client retrying an add that landed) and an add plex.tv never confirmed. The title is not on Plex, so it may
 * download either way (ADR-092 C-03: an add that will download says so).
 */
const SEERR_ALREADY_ON = "It isn't on Plex yet, so Seerr will request it if it hasn't already.";
const SEERR_IF_ADDED = "It isn't on Plex yet, so if it was added, Seerr will request it.";
const SEERR_IF_PUT_BACK = "It isn't on Plex yet, so if it was put back, Seerr will request it.";

/**
 * PR #580 ruling 2 — the answer when plex.tv never confirmed a watchlist call's outcome; `seerr` is D-15j's
 * sentence when the unconfirmed call was an add of a title not on Plex.
 */
function unknownOutcome(label: string, seerr: string | null = null): string {
  return capSpoken(`Plex didn't answer in time, so I can't tell whether ${label} changed.${seerr ? ` ${seerr}` : ''}`);
}

/**
 * DESIGN-051 D-04 — the undo of a Watchlist Change: "Removed The Matrix (1999 movie) from your watchlist
 * again." / "Put The Matrix (1999 movie) back on your watchlist." When the title is not on Plex, undoing an add
 * adds "Seerr may already have requested it." and undoing a remove "Seerr will request it." A failed or
 * unconfirmed inverse call leaves the change live for the next undo; an unconfirmed undo of a remove (its inverse
 * is an add) of a title not on Plex says Seerr will request it if it was put back (D-15j).
 */
function formatWatchlistUndo(r: Extract<UndoView, { undone: true }>): string {
  const label = titleYearKind(r.title, r.year, r.kind);
  const add = r.action === 'watchlist_add';
  const change = add ? `adding ${label} to` : `removing ${label} from`;
  const outcome: WatchlistUndoOutcome =
    r.watchlistOutcome ??
    (r.revertResult === 'written' ? 'reverted' : r.revertResult === 'none' ? 'not_sent' : 'failed');
  switch (outcome) {
    case 'not_sent':
      // PLAN-071 ruling 3: the change never reached Plex, so undoing it only closes the record.
      return capSpoken(`Your last change, ${change} your watchlist, never reached Plex, so there was nothing to undo.`);
    case 'left_as_is':
      return capSpoken(
        `Your last change, ${change} your watchlist, never confirmed with Plex, so I left your watchlist as it is.`,
      );
    case 'cleared':
      return capSpoken(
        `Your last change, ${change} your watchlist, may not have reached Plex, so I made sure it's off your watchlist.${r.onPlex === false ? ' Seerr may already have requested it.' : ''}`,
      );
    case 'unknown':
      // D-15j: undoing a remove sends an add, which downloads a title not on Plex if it landed.
      return unknownOutcome(label, !add && r.onPlex === false ? SEERR_IF_PUT_BACK : null);
    case 'failed':
      return capSpoken(
        `I couldn't reach Plex, so ${label} is still ${add ? 'on' : 'off'} your watchlist. Say undo again to retry.`,
      );
    default:
      if (add) {
        return capSpoken(
          `Removed ${label} from your watchlist again.${r.onPlex === false ? ' Seerr may already have requested it.' : ''}`,
        );
      }
      return capSpoken(`Put ${label} back on your watchlist.${r.onPlex === false ? ' Seerr will request it.' : ''}`);
  }
}

/** The `undo_last_change` read-back (D-15; a Watchlist Change: DESIGN-051 D-04). */
export function formatUndoResult(r: UndoView): string {
  if (!r.undone) return 'Nothing to undo from the past day.';
  if (r.action === 'watchlist_add' || r.action === 'watchlist_remove') return formatWatchlistUndo(r);
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
      return capSpoken(
        `Only part of ${subject}${through} went back to unwatched in Plex, so the mark stays for now. Say undo again to retry the rest.`,
      );
    case 'failed':
      return capSpoken(
        `Plex didn't take the change, so ${subject}${through} still shows as watched there and the mark stays for now. Say undo again to retry.`,
      );
    default:
      return capSpoken(`Undone. ${capitalize(subject)}${through} is no longer marked as watched.`);
  }
}

// ---------------------------------------------------------------------------------------------------
// watchlist, set_watchlist (DESIGN-051 D-02)

/** One title of the `watchlist` answer. */
export interface WatchlistItemView {
  kind: WatchKind;
  title: string;
  year: number | null;
  /** The D-02 rule (recommend's, DESIGN-049 D-17). */
  onPlex: boolean;
  /** `started`: the Title State is in progress, stalled or a taster (a show tried and left); `watched`: Ever Watched and not unfinished. */
  progress: 'started' | 'watched' | null;
}

function watchlistItemSentence(it: WatchlistItemView): string {
  return `${sentence([
    spokenTitle(it.title),
    yearAndKind(it.year, it.kind),
    it.onPlex ? 'on Plex' : 'not on Plex yet',
    it.progress,
  ])}.`;
}

/**
 * `watchlist` (DESIGN-051 D-02): "Your watchlist has 150 titles. Newest first: Slow Horses, a 2022 show, on
 * Plex, started. The Toxic Avenger, a 2023 movie, not on Plex yet. … And 145 more." `items` is the page (after
 * `offset`), `total` the whole list of the asked kind. With a kind: "Your watchlist has 61 shows." Empty: "Your
 * watchlist is empty." Past the end: "That's the end of your watchlist." A later page, or a first page the 1,200-character cap cut short, says the range it holds ("Numbers 6 to 10:").
 */
export function formatWatchlist(
  items: readonly WatchlistItemView[],
  opts: { total: number; offset: number; kind?: WatchKind | 'any' | null },
): string {
  const kind = opts.kind === 'show' || opts.kind === 'movie' ? opts.kind : null;
  const noun = kind ?? 'title';
  const total = Math.max(0, Math.floor(opts.total));
  const offset = Math.max(0, Math.floor(opts.offset));
  if (total === 0) return kind ? `Your watchlist has no ${noun}s.` : 'Your watchlist is empty.';
  if (items.length === 0) return "That's the end of your watchlist.";
  const lead = `Your watchlist has ${total === 1 ? `one ${noun}` : `${countWord(total)} ${noun}s`}.`;
  // PR #580 ruling 8: fit the items to the cap FIRST, then say the range and "And N more." of the items KEPT, so
  // an agent paging by `offset` never skips a title the cap dropped.
  const header = (k: number): string => {
    const range = k === 1 ? `number ${offset + 1}` : `numbers ${offset + 1} to ${offset + k}`;
    if (offset > 0) return `${capitalize(range)}: `;
    return k === items.length ? 'Newest first: ' : `Newest first, ${range}: `;
  };
  const render = (k: number): string => {
    const more = Math.max(0, total - offset - k);
    return [
      lead,
      ...items.slice(0, k).map((it, i) => `${i === 0 ? header(k) : ''}${watchlistItemSentence(it)}`),
      ...(more > 0 ? [`And ${more} more.`] : []),
    ].join(' ');
  };
  for (let k = items.length; k > 1; k -= 1) {
    const text = render(k);
    if (text.length <= SPOKEN_MAX_CHARS) return text;
  }
  return capSpoken(render(1));
}

/** What a `set_watchlist` call did (DESIGN-051 D-02 / D-03). */
export type WatchlistChangeView =
  | { status: 'added'; kind: WatchKind; title: string; year: number | null; onPlex: boolean }
  | { status: 'removed'; kind: WatchKind; title: string; year: number | null }
  /**
   * The title was already in the asked state: nothing written, nothing sent. `onPlex` feeds the Seerr sentence of an
   * "already on" add (DESIGN-051 D-15j: a retried add lands here, and its first answer may never have been heard).
   */
  | { status: 'unchanged'; action: 'add' | 'remove'; kind: WatchKind; title: string; year: number | null; onPlex: boolean }
  /** Resolved, but plex.tv's catalog has no such title. */
  | { status: 'not_in_catalog'; kind: WatchKind; title: string; year: number | null }
  /**
   * PLAN-071 ruling 6: the title's plex guid and its external-id match named different catalog titles (or the
   * match found none), so nothing was written.
   */
  | { status: 'unconfirmed'; kind: WatchKind; title: string; year: number | null }
  /**
   * PR #580 ruling 2: the write went out but plex.tv never confirmed whether it landed. An add of a title not on
   * Plex says Seerr will request it if it landed (DESIGN-051 D-15j).
   */
  | { status: 'unknown'; action: 'add' | 'remove'; kind: WatchKind; title: string; year: number | null; onPlex: boolean }
  /** Plex could not be reached (or refused the change). */
  | { status: 'failed' };

/**
 * The `set_watchlist` read-back (DESIGN-051 D-02). The title and year are plex.tv's (the discover match), so
 * the agent can check the change: "Added The Matrix (1999 movie) to your watchlist. It's on Plex." / "Added Dune:
 * Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it." (ADR-092 C-03). An
 * "already on" add and an unconfirmed add of a title not on Plex carry a Seerr sentence too (D-15j): a client that
 * retries an add which landed hears "already on", and the first answer may never have reached anyone.
 */
export function formatWatchlistChange(v: WatchlistChangeView): string {
  if (v.status === 'failed') return "I couldn't reach Plex, so your watchlist didn't change.";
  const label = titleYearKind(v.title, v.year, v.kind);
  switch (v.status) {
    case 'added':
      return capSpoken(
        `Added ${label} to your watchlist. ${v.onPlex ? "It's on Plex." : "It isn't on Plex yet, so Seerr will request it."}`,
      );
    case 'removed':
      return capSpoken(`Removed ${label} from your watchlist.`);
    case 'unchanged':
      if (v.action === 'remove') return capSpoken(`${label} isn't on your watchlist.`);
      return capSpoken(`${label} is already on your watchlist.${v.onPlex ? '' : ` ${SEERR_ALREADY_ON}`}`);
    case 'unconfirmed':
      return capSpoken(`I couldn't confirm ${label} in Plex's catalog, so your watchlist didn't change.`);
    case 'unknown':
      return unknownOutcome(label, v.action === 'add' && !v.onPlex ? SEERR_IF_ADDED : null);
    default:
      return capSpoken(`I found ${label} but not in Plex's catalog, so your watchlist didn't change.`);
  }
}

/**
 * A `set_watchlist` remove resolves only among the titles on the watchlist (DESIGN-051 D-03 step 2), so its
 * not-found answer says where it looked: "I couldn't find X on your watchlist."
 */
export function formatNotOnWatchlist(query: string, opts: { kind?: WatchKind | null } = {}): string {
  const what = opts.kind ? `a ${opts.kind} called ` : '';
  return capSpoken(`I couldn't find ${what}${spokenQuery(query)} on your watchlist.`);
}

/** DESIGN-051 D-02 — `watchlist` and `set_watchlist` for a principal that is not the Server Owner. */
export function formatWatchlistNotSetUp(): string {
  return "Your Plex watchlist isn't set up for your account yet.";
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

/**
 * `mark_watched` got an episode without its season (D-05 lists both; nothing is written): ask for it.
 * "Which season is episode 3 of Silo in? Say it like season 2 episode 3."
 */
export function formatNeedSeason(query: string, episode?: number | null): string {
  const which = typeof episode === 'number' ? `episode ${episode}` : 'that episode';
  return capSpoken(
    `Which season is ${which} of ${spokenQuery(query)} in? Say it like season 2 episode ${typeof episode === 'number' ? episode : 3}.`,
  );
}

/** No owner row yet (D-03). */
export function formatNotReady(): string {
  return "Watch history isn't ready yet.";
}

/**
 * ADR-091 C-04 / DESIGN-050 D-07 — a connector's user has no tracked Plex account (unmapped in the ADR-053 map,
 * or not tracked): every tool answers this, as an ordinary result.
 */
export function formatNotSetUp(): string {
  return "Watch history isn't set up for your account yet.";
}

/** The `isError` text for an unexpected failure (D-06). */
export function formatWatchError(): string {
  return 'Watch history hit an error. Try again in a minute.';
}
