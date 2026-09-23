// ADR-088 / DESIGN-049 D-09 steps 3–4 (PLAN-068 S6) — the PURE half of the `watch` sync: group every record
// of a title (the stored Title State, each server's Plex item, the owner's Watch Events, the *arr ledger
// item) by shared identity keys, decide which shows need an `allLeaves` re-read, and assemble the Title
// States the domain writer upserts. No I/O: the fetcher (watch.ts) reads, this computes, @hnet/domain writes.
import type { PlexServerSlug, WatchEventRow, WatchOnPlexEntry, WatchTitleRow } from '@hnet/db';
import type { WatchTitleWrite } from '@hnet/domain';
import {
  PLEX_SERVERS,
  computeMovieProgress,
  computeShowProgress,
  countsEqual,
  episodeObsFromLeaves,
  eventObs,
  isKidsTitle,
  keysOf,
  movieCounts,
  movieObsFromItem,
  movieProgressFields,
  nameKey,
  normalizeTitle,
  orderOnPlex,
  parsePlexItemIds,
  plexGenres,
  serverEpisodesFromMap,
  showCounts,
  showProgressFields,
  storedMovieObs,
  titleKeyFor,
  titleKeyRank,
  type LedgerIndexItem,
  type PlexItemLike,
  type ServerEpisodes,
  type ServerMovieObs,
  type WatchKind,
} from '@hnet/watch';

/** One Plex item on one server: a listed show, or a watched / in-progress movie. */
export interface PlexObs {
  server: PlexServerSlug;
  item: PlexItemLike;
}

export interface AssembleInput {
  stored: readonly WatchTitleRow[];
  /** Every show of the fully listed show sections (and of partially read servers, for what was read). */
  shows: readonly PlexObs[];
  /** Movies from the watched and in-progress listings, plus the absent-movie checks that answered. */
  movies: readonly PlexObs[];
  /** `${server}\0${ratingKey}` → the leaves re-read this run. */
  leaves: ReadonlyMap<string, readonly PlexItemLike[]>;
  /** `${server}\0${ratingKey}` of stored movies Plex confirmed gone (404) this run. */
  goneMovies: ReadonlySet<string>;
  /** Servers whose show sections were read completely: a show absent there is gone from it. */
  showServersRead: ReadonlySet<PlexServerSlug>;
  /** Servers whose movie listings were read completely. */
  movieServersRead: ReadonlySet<PlexServerSlug>;
  events: readonly WatchEventRow[];
  ledger: readonly LedgerIndexItem[];
  /** Event rows inserted this run (their titles are re-read even if Plex counters did not move). */
  freshEventIds?: ReadonlySet<number>;
}

export const obsKey = (server: PlexServerSlug, ratingKey: string): string => `${server}\u0000${ratingKey}`;

type Rec =
  | { type: 'stored'; kind: WatchKind; keys: string[]; row: WatchTitleRow }
  | { type: 'plex'; kind: WatchKind; keys: string[]; obs: PlexObs }
  | { type: 'events'; kind: WatchKind; keys: string[]; events: WatchEventRow[]; title: string; year: number | null; showGuid: string | null }
  | { type: 'ledger'; kind: WatchKind; keys: string[]; item: LedgerIndexItem };

export interface TitleGroup {
  kind: WatchKind;
  stored: WatchTitleRow[];
  plex: PlexObs[];
  events: WatchEventRow[];
  eventTitle: { title: string; year: number | null; showGuid: string | null } | null;
  ledger: LedgerIndexItem[];
}

function plexKeys(kind: WatchKind, item: PlexItemLike): string[] {
  const ids = parsePlexItemIds(item);
  return keysOf({ kind, title: item.title, year: item.year ?? null, ...ids, tvdbId: kind === 'show' ? ids.tvdbId : null });
}

/**
 * The owner's events as title records. Episodes with a show guid are one record per guid (`plex:` key only
 * — an episode's `year` is its own air year, not the show's, so no name key). Guid-less episodes (Q-06:
 * unresolved or gone) are one record per normalized show title, with a name key per year they carry. Movies
 * key on their item guid and their title + year.
 */
function eventRecords(events: readonly WatchEventRow[]): Rec[] {
  const byGuid = new Map<string, WatchEventRow[]>();
  const byShowName = new Map<string, WatchEventRow[]>();
  const movies = new Map<string, WatchEventRow[]>();
  for (const e of events) {
    if (e.kind === 'episode') {
      if (e.showGuid?.startsWith('plex://show/')) {
        const list = byGuid.get(e.showGuid) ?? [];
        list.push(e);
        byGuid.set(e.showGuid, list);
      } else {
        const norm = normalizeTitle(e.showTitle ?? e.title).norm;
        const list = byShowName.get(norm) ?? [];
        list.push(e);
        byShowName.set(norm, list);
      }
    } else {
      const guid = e.itemGuid?.startsWith('plex://movie/') ? e.itemGuid : null;
      const id = guid ?? nameKey('movie', e.title, e.year);
      const list = movies.get(id) ?? [];
      list.push(e);
      movies.set(id, list);
    }
  }
  const newest = (list: readonly WatchEventRow[]) =>
    [...list].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const minYear = (list: readonly WatchEventRow[]) => {
    const years = list.map((e) => e.year).filter((y): y is number => typeof y === 'number' && y > 0);
    return years.length > 0 ? Math.min(...years) : null;
  };
  const out: Rec[] = [];
  for (const [guid, list] of byGuid) {
    const last = newest(list);
    out.push({
      type: 'events',
      kind: 'show',
      keys: [`plex:${guid}`],
      events: list,
      title: last?.showTitle ?? last?.title ?? '',
      year: minYear(list),
      showGuid: guid,
    });
  }
  for (const list of byShowName.values()) {
    const last = newest(list);
    const title = last?.showTitle ?? last?.title ?? '';
    const years = new Set(list.map((e) => e.year ?? null));
    const keys = [...years].map((y) => nameKey('show', title, y));
    out.push({ type: 'events', kind: 'show', keys, events: list, title, year: minYear(list), showGuid: null });
  }
  for (const [id, list] of movies) {
    const last = newest(list);
    const title = last?.title ?? '';
    const year = last?.year ?? null;
    const keys = id.startsWith('plex://') ? [`plex:${id}`, nameKey('movie', title, year)] : [id];
    out.push({ type: 'events', kind: 'movie', keys, events: list, title, year, showGuid: null });
  }
  return out;
}

/**
 * Group every record by shared identity keys (same kind). A guid-less show event group that matched
 * nothing by key joins the one Plex/stored show with the same normalized title, when exactly one exists
 * (the Q-06 fallback: the show title stands in for its guid meanwhile).
 */
export function groupTitles(input: {
  stored: readonly WatchTitleRow[];
  shows: readonly PlexObs[];
  movies: readonly PlexObs[];
  events: readonly WatchEventRow[];
  ledger: readonly LedgerIndexItem[];
}): TitleGroup[] {
  const recs: Rec[] = [
    ...input.stored.map((row): Rec => ({ type: 'stored', kind: row.kind, keys: keysOf(row), row })),
    ...input.shows.map((obs): Rec => ({ type: 'plex', kind: 'show', keys: plexKeys('show', obs.item), obs })),
    ...input.movies.map((obs): Rec => ({ type: 'plex', kind: 'movie', keys: plexKeys('movie', obs.item), obs })),
    ...eventRecords(input.events),
    ...input.ledger.map((item): Rec => ({
      type: 'ledger',
      kind: item.kind,
      keys: keysOf({ ...item, kind: item.kind }),
      item,
    })),
  ];

  // Union-find over kind-scoped keys.
  const parent = recs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      const p = parent[i] as number;
      parent[i] = parent[p] as number;
      i = p;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owner = new Map<string, number>();
  recs.forEach((r, i) => {
    for (const k of r.keys) {
      const scoped = `${r.kind}|${k}`;
      const seen = owner.get(scoped);
      if (seen === undefined) owner.set(scoped, i);
      else union(seen, i);
    }
  });

  // The Q-06 title fallback for guid-less show events that joined nothing.
  const showNames = new Map<string, Set<number>>();
  recs.forEach((r, i) => {
    if (r.kind !== 'show' || (r.type !== 'plex' && r.type !== 'stored')) return;
    const title = r.type === 'plex' ? r.obs.item.title : r.row.title;
    const norm = normalizeTitle(title).norm;
    const set = showNames.get(norm) ?? new Set<number>();
    set.add(find(i));
    showNames.set(norm, set);
  });
  const groupSize = new Map<number, number>();
  recs.forEach((_, i) => groupSize.set(find(i), (groupSize.get(find(i)) ?? 0) + 1));
  recs.forEach((r, i) => {
    if (r.type !== 'events' || r.kind !== 'show' || r.showGuid !== null) return;
    if ((groupSize.get(find(i)) ?? 0) > 1) return;
    const roots = showNames.get(normalizeTitle(r.title).norm);
    if (roots && roots.size === 1) union(i, [...roots][0] as number);
  });

  const groups = new Map<number, TitleGroup>();
  recs.forEach((r, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { kind: r.kind, stored: [], plex: [], events: [], eventTitle: null, ledger: [] };
      groups.set(root, g);
    }
    if (r.type === 'stored') g.stored.push(r.row);
    else if (r.type === 'plex') g.plex.push(r.obs);
    else if (r.type === 'ledger') g.ledger.push(r.item);
    else {
      g.events.push(...r.events);
      g.eventTitle ??= { title: r.title, year: r.year, showGuid: r.showGuid };
    }
  });
  return [...groups.values()];
}

/** The group's primary stored row: the strongest key, then the oldest. */
function primaryRow(g: TitleGroup): WatchTitleRow | null {
  return [...g.stored].sort((a, b) => titleKeyRank(a.titleKey) - titleKeyRank(b.titleKey) || a.id - b.id)[0] ?? null;
}

/** A title the sync keeps a Title State for: stored, watched/started on Plex, or in the event log. */
function tracked(g: TitleGroup): boolean {
  if (g.stored.length > 0 || g.events.length > 0) return true;
  if (g.kind === 'movie') return g.plex.length > 0; // the watched / in-progress listings only
  return g.plex.some((o) => (o.item.viewedLeafCount ?? 0) > 0);
}

/**
 * D-09 step 3 — which shows need `allLeaves` now: a tracked show whose counters moved on ANY server (or
 * that has no stored counters for a server, or new events this run) is re-read on EVERY server that holds
 * it (PLAN-068 S6: the stored map is pair-level, so a server's own flags cannot be recovered from it).
 */
export function planShowRereads(
  groups: readonly TitleGroup[],
  freshEventIds: ReadonlySet<number> = new Set(),
): PlexObs[] {
  const out: PlexObs[] = [];
  for (const g of groups) {
    if (g.kind !== 'show' || g.plex.length === 0 || !tracked(g)) continue;
    const row = primaryRow(g);
    const hasFreshEvents = g.events.some((e) => freshEventIds.has(e.id));
    const moved = g.plex.some((o) => !row || !countsEqual(showCounts(o.item), row.plexCounts[o.server]));
    if (moved || hasFreshEvents) out.push(...g.plex);
  }
  return out;
}

function firstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return null;
}

/** The stored episode lists of the servers not re-read this run (and not gone). */
function storedServers(row: WatchTitleRow | null, keep: (s: PlexServerSlug) => boolean): ServerEpisodes[] {
  return serverEpisodesFromMap(row?.episodeMap).filter((s) => keep(s.server));
}

/**
 * D-09 step 4 — assemble the Title States of every tracked title (the pure D-10 functions do the math).
 * Per server: fresh Plex data where this run read it, the stored snapshot where it could not (per-source
 * degradation), nothing where a complete read shows the title gone. Identity: Plex, then the ledger, then
 * the stored row, then the events; genres ledger first (D-16); the stored row's id when there is one.
 */
export function assembleTitleStates(input: AssembleInput, groups = groupTitles(input)): WatchTitleWrite[] {
  const out: WatchTitleWrite[] = [];
  for (const g of groups) {
    if (!tracked(g)) continue;
    const row = primaryRow(g);
    const plex = [...g.plex].sort(
      (a, b) => PLEX_SERVERS.indexOf(a.server) - PLEX_SERVERS.indexOf(b.server),
    );
    const byServer = new Map<PlexServerSlug, PlexObs>();
    for (const o of plex) if (!byServer.has(o.server)) byServer.set(o.server, o);
    const matched = plex.find((o) => !parsePlexItemIds(o.item).local) ?? null;
    const lead = matched ?? plex[0] ?? null;
    const leadIds = lead ? parsePlexItemIds(lead.item) : null;
    const ledger = [...g.ledger].sort((a, b) => a.mediaItemId.localeCompare(b.mediaItemId))[0] ?? null;
    const serversRead = g.kind === 'show' ? input.showServersRead : input.movieServersRead;

    // Which servers the title is on now: this run's reads, plus the stored entries this run could not
    // settle. A show missing from a COMPLETE show listing is gone from that server. A movie missing from the
    // watched / in-progress listings is either unwatched there or gone: only the absent-movie check (a 404)
    // says gone, and without one the stored entry stands.
    const keepStored = (e: WatchOnPlexEntry) =>
      !byServer.has(e.server) &&
      (g.kind === 'show'
        ? !serversRead.has(e.server)
        : !input.goneMovies.has(obsKey(e.server, e.ratingKey)));
    const onPlex: WatchOnPlexEntry[] = orderOnPlex([
      ...[...byServer.values()].map((o) => ({
        server: o.server,
        ratingKey: o.item.ratingKey,
        local: parsePlexItemIds(o.item).local,
      })),
      ...(row?.onPlex ?? []).filter(keepStored),
    ]);
    const kept = (s: PlexServerSlug) => !byServer.has(s) && onPlex.some((e) => e.server === s);

    const events = g.events.map(eventObs);
    let progress: ReturnType<typeof showProgressFields>;
    const plexCounts: WatchTitleRow['plexCounts'] = {};
    for (const e of onPlex) {
      const stored = row?.plexCounts[e.server];
      if (kept(e.server) && stored) plexCounts[e.server] = stored;
    }
    if (g.kind === 'show') {
      const fresh: ServerEpisodes[] = [];
      for (const o of byServer.values()) {
        const leaves = input.leaves.get(obsKey(o.server, o.item.ratingKey));
        if (leaves) {
          fresh.push({ server: o.server, episodes: episodeObsFromLeaves(leaves) });
          plexCounts[o.server] = showCounts(o.item);
        } else {
          // Not re-read (its counters did not move — or the re-read failed): the stored snapshot stands, and so
          // do the stored counters, so a failed re-read is retried next run.
          const stored = row?.plexCounts[o.server];
          if (stored) plexCounts[o.server] = stored;
        }
      }
      const unread = (s: PlexServerSlug) =>
        kept(s) || (byServer.has(s) && !fresh.some((f) => f.server === s));
      const servers = [...storedServers(row, unread), ...fresh];
      progress = showProgressFields(
        computeShowProgress(servers, events),
        row ? { season: row.nextSeason, episode: row.nextEpisode, title: row.nextTitle } : null,
      );
    } else {
      const fresh: ServerMovieObs[] = [...byServer.values()].map((o) => movieObsFromItem(o.server, o.item));
      const stored = row ? storedMovieObs(row).filter((s) => kept(s.server)) : [];
      const servers = [...fresh, ...stored];
      for (const f of fresh) plexCounts[f.server] = movieCounts(f);
      progress = movieProgressFields(computeMovieProgress(servers, events), servers);
    }

    const ev = g.eventTitle;
    const plexGuid = firstNonNull(
      leadIds?.plexGuid?.startsWith(`plex://${g.kind}/`) ? leadIds.plexGuid : null,
      row?.plexGuid,
      ev?.showGuid,
    );
    const ids = {
      plexGuid,
      tvdbId: g.kind === 'show' ? firstNonNull(leadIds?.tvdbId, ledger?.tvdbId, row?.tvdbId) : null,
      tmdbId: firstNonNull(leadIds?.tmdbId, ledger?.tmdbId, row?.tmdbId),
      imdbId: firstNonNull(leadIds?.imdbId, ledger?.imdbId, row?.imdbId),
    };
    const title = firstNonNull(lead?.item.title, ledger?.title, row?.title, ev?.title) ?? '';
    const year = firstNonNull(lead?.item.year, ledger?.year, row?.year, ev?.year);
    const genres =
      ledger && ledger.genres.length > 0
        ? ledger.genres
        : lead && plexGenres(lead.item).length > 0
          ? plexGenres(lead.item)
          : (row?.genres ?? []);
    const contentRating = firstNonNull(lead?.item.contentRating, row?.contentRating);
    const computedKey = titleKeyFor({ kind: g.kind, title, year, ...ids });
    // The writer keeps a stored key at least as strong (D-08: re-key only to a STRONGER key).
    const titleKey =
      row && titleKeyRank(row.titleKey) <= titleKeyRank(computedKey) ? row.titleKey : computedKey;

    out.push({
      ...(row ? { id: row.id } : {}),
      kind: g.kind,
      titleKey,
      ...ids,
      mediaItemId: firstNonNull(ledger?.mediaItemId, row?.mediaItemId),
      title,
      year,
      genres: [...genres],
      contentRating,
      isKids: isKidsTitle({ kind: g.kind, contentRating, genres }),
      onPlex,
      plexCounts,
      showStatus: g.kind === 'show' ? firstNonNull(ledger?.showStatus, row?.showStatus) : null,
      ...progress,
    });
  }
  return out;
}
